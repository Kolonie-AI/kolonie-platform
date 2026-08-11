import { ImageCheckSchema, type ImageConstraints, type Log } from '@kolonie-ai/core'
import type { VisionChecker, VisionCheckResult } from './raster.js'
import { isPermanentVendorStatus, readVendorRejection } from './vendor.js'
import { recordOpenRouterCall } from './model-call.js'

/**
 * The environment variable the OpenRouter key arrives in.
 *
 * The same name `apps/moderation-runner` reads, because it is the same account
 * and the same vendor — `kolonie-infra` provisions one key. Two names for one
 * credential is kolonie-infra#7 waiting to happen.
 */
export const OPENROUTER_API_KEY_VAR = 'OPENROUTER_API_KEY'

/** Which model looks at the image. Overridable, because the choice will be revisited. */
export const VISION_MODEL_VAR = 'VISION_MODEL'

/**
 * The model that looks at the image.
 *
 * It has to accept an image *and* return a structured object — a verdict
 * extracted from prose with a regular expression is a verdict that will
 * eventually pass an image because the model wrote the word "correct" in an
 * explanation. That is the same reasoning `MODERATION_MODEL` records, and it
 * rules out most of the cheap vision models rather than a few.
 */
export const DEFAULT_VISION_MODEL = 'openai/gpt-4o-mini'

/** Where OpenRouter is. A constant, as in the moderation runner: a vendor's root. */
/**
 * Where OpenRouter is. Exported since `#389` so `artefact-reader.ts` uses this
 * one rather than writing a second copy — the same argument `safeFetch` makes
 * about the SSRF list, one vendor along.
 */
export const OPENROUTER_BASE = 'https://openrouter.ai/api/v1'

/**
 * The five questions, as a schema the model must answer in.
 *
 * **One boolean per constraint rather than a single verdict**, which is what
 * makes a failure actionable: an agent that got four of five right is told which
 * one to fix. A model asked only *"does this match"* gives an answer of the same
 * quality and an evidence line of none.
 */
const CHECK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'backgroundCorrect',
    'shapeCorrect',
    'shapeColorCorrect',
    'positionCorrect',
    'secondaryCorrect',
    'notes',
  ],
  properties: {
    backgroundCorrect: { type: 'boolean' },
    shapeCorrect: { type: 'boolean' },
    shapeColorCorrect: { type: 'boolean' },
    positionCorrect: { type: 'boolean' },
    secondaryCorrect: { type: 'boolean' },
    notes: { type: 'string' },
  },
} as const

/** What the model is told to do. Exported so a test asserts the constraints reach it. */
export function visionPromptFor(constraints: ImageConstraints): string {
  return (
    'You are checking whether an image satisfies five constraints. Answer about the image only, ' +
    'and do not be generous: a constraint holds or it does not.\n\n' +
    `- Background colour: ${constraints.background}\n` +
    `- Primary shape: ${constraints.shape}\n` +
    `- Colour of that shape: ${constraints.shapeColor}\n` +
    `- Where that shape sits: ${constraints.position}\n` +
    `- Secondary element: ${constraints.secondary}\n\n` +
    (constraints.secondary === 'none'
      ? 'For the secondary element, answer true only if the image contains no element other ' +
        'than the primary shape.\n\n'
      : `For the secondary element, answer true only if ${constraints.secondary} is present ` +
        'and is clearly smaller than the primary shape.\n\n') +
    'Set notes to one short sentence naming what is wrong, or leave it empty if nothing is.'
  )
}

/**
 * Ask a vision model on OpenRouter whether the image matches.
 *
 * The key arrives as an argument rather than being read from `process.env` here,
 * so that this package stays testable without an environment and the credential
 * is named in exactly one file — the runner's wiring.
 *
 * **Without a key every check is `unavailable`, deliberately**, and never a
 * failure. The reasoning is `httpGitHubReader`'s exactly: an unconfigured Colony
 * that failed submissions would be punishing agents for our own deploy.
 */
export function openRouterVision(
  apiKey: string | undefined,
  model: string | undefined = DEFAULT_VISION_MODEL,
  fetchImpl: typeof fetch = fetch,
  log?: Log,
): VisionChecker {
  /**
   * A blank model name is an unset one, and a default parameter would not catch
   * it. `docker-compose.yml` writes `VISION_MODEL: ${VISION_MODEL:-}` so that a
   * missing variable degrades the runner rather than refusing to start it, and
   * what that hands the process is an empty string. Without this the Colony
   * would ask OpenRouter for a model called `""` on every submission.
   */
  const chosen = model === undefined || model.trim() === '' ? DEFAULT_VISION_MODEL : model

  return {
    check: async ({ image, format, constraints }): Promise<VisionCheckResult> => {
      if (apiKey === undefined || apiKey.trim() === '') {
        return {
          outcome: 'unavailable',
          reason: `no ${OPENROUTER_API_KEY_VAR} is configured, so no model can be asked.`,
        }
      }

      const dataUrl = `data:${format};base64,${Buffer.from(image).toString('base64')}`

      let response: Response
      try {
        response = await fetchImpl(`${OPENROUTER_BASE}/chat/completions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: chosen,
            // Nothing creative is wanted. The same picture and the same
            // constraints should produce the same verdict twice.
            temperature: 0,
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: visionPromptFor(constraints) },
                  { type: 'image_url', image_url: { url: dataUrl } },
                ],
              },
            ],
            response_format: {
              type: 'json_schema',
              json_schema: { name: 'image_check', strict: true, schema: CHECK_SCHEMA },
            },
          }),
        })
      } catch (error) {
        return {
          outcome: 'unavailable',
          reason: `the model could not be reached (${error instanceof Error ? error.message : String(error)}).`,
        }
      }

      /**
       * A refusal is either something that will clear or something that will
       * not, and telling them apart is `#217`.
       *
       * 402 is out of credit, 429 is rate-limited and a 5xx is a bad day —
       * those are ours, they clear, and `unavailable` means *try again*. Any
       * other 4xx is the vendor calling this request malformed, and it will be
       * malformed identically on the next attempt: retrying it is what produced
       * 1830 verification rows for one submission. See `vendor.ts`.
       */
      if (!response.ok) {
        if (isPermanentVendorStatus(response.status)) {
          const rejection = await readVendorRejection(response, [apiKey])
          return {
            outcome: 'rejected',
            reason: `the model refused the Colony's request with ${rejection.status}.`,
            status: rejection.status,
            body: rejection.body,
          }
        }

        return { outcome: 'unavailable', reason: `the model answered ${response.status}.` }
      }

      let body: { choices?: Array<{ message?: { content?: unknown } }> }
      let call
      try {
        body = (await response.json()) as typeof body
        call = recordOpenRouterCall(body, log, response)
      } catch {
        return {
          outcome: 'unavailable',
          reason: 'the model answered with something that is not JSON.',
        }
      }

      const content = body.choices?.[0]?.message?.content
      if (typeof content !== 'string') {
        return { outcome: 'unavailable', reason: 'the model answered with no content.' }
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(content)
      } catch {
        return {
          outcome: 'unavailable',
          reason: 'the model answered with something that is not the shape it was asked for.',
        }
      }

      const check = ImageCheckSchema.safeParse(parsed)
      if (!check.success) {
        /**
         * A reply that parsed as JSON and is not the five booleans is the
         * Colony's problem — a wrong model configured, or a vendor that stopped
         * honouring the schema. Reading a missing field as `false` would fail an
         * agent for our misconfiguration, which is the one thing a verifier must
         * never do.
         */
        return {
          outcome: 'unavailable',
          reason: 'the model answered a shape the Colony does not recognise.',
        }
      }

      return { outcome: 'checked', check: check.data, model: call.model }
    },
  }
}
