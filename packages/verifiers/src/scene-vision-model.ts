import {
  SceneCheckSchema,
  SCENE_PROHIBITION,
  TIER_2,
  chatRequestBody,
  sceneBindingPhrase,
  throwIfTruncated,
  type CapabilityTier,
  type SceneConstraints,
  type Log,
} from '@kolonie-ai/core'
import type { SceneChecker, SceneCheckResult } from './image-model.js'
import { OPENROUTER_API_KEY_VAR } from './vision-model.js'
import { isPermanentVendorStatus, readVendorRejection } from './vendor.js'
import { recordOpenRouterCall } from './model-call.js'

/**
 * Which model judges a scene. Its own variable, so the two image rungs are tuned
 * independently.
 *
 * **Not a shared `VISION_MODEL` with the `raster` rung**, and the reason is the
 * count property: asked how many otters are in a picture, a small vision model
 * is wrong often enough to fail work that was right. `raster` asks five
 * questions a cheap model answers well — is the background blue, is the shape a
 * circle — and paying a stronger model for those on every submission buys
 * nothing. One variable would force the Colony to price both rungs at whichever
 * is more demanding.
 */
export const SCENE_VISION_MODEL_VAR = 'SCENE_VISION_MODEL'

/**
 * The tier that judges a scene (`#1694`).
 *
 * It has to accept an image *and* return a structured object, for the reason
 * `DEFAULT_VISION_TIER` records — a verdict extracted from prose with a regular
 * expression eventually passes an image because the model wrote the word
 * "correct" in an explanation.
 *
 * **And it has to count.** That is the requirement this tier is chosen for and
 * the one that rules out `tier-3`: a judge that miscounts four objects fails a
 * citizen who did exactly what was asked, on a rung whose attempts cost that
 * citizen money. Which model serves `tier-2` is settled at the gateway against
 * real submissions — that is what the tier bought, and the variable below is
 * still there for pinning one during an incident.
 */
export const DEFAULT_SCENE_VISION_TIER: CapabilityTier = TIER_2

/**
 * The six questions, as a schema the model must answer in.
 *
 * **One boolean per property rather than a single verdict**, which is what makes
 * a failure actionable: an agent that got the count wrong is told `count` and
 * re-prompts, where *"does this match"* would have it start over. The binding is
 * one boolean and not two on purpose — half a binding is not a partial pass, the
 * colours either landed where they were asked for or they did not.
 */
const SCENE_CHECK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'subjectCorrect',
    'countCorrect',
    'bindingCorrect',
    'settingCorrect',
    'styleCorrect',
    'prohibitionCorrect',
    'notes',
  ],
  properties: {
    subjectCorrect: { type: 'boolean' },
    countCorrect: { type: 'boolean' },
    bindingCorrect: { type: 'boolean' },
    settingCorrect: { type: 'boolean' },
    styleCorrect: { type: 'boolean' },
    prohibitionCorrect: { type: 'boolean' },
    notes: { type: 'string' },
  },
} as const

/** What the model is told to do. Exported so a test asserts the properties reach it. */
export function scenePromptForModel(constraints: SceneConstraints): string {
  return (
    'You are checking whether an image satisfies six properties. Answer about the image only, ' +
    'and do not be generous: a property holds or it does not.\n\n' +
    `- Subject: ${constraints.subject}\n` +
    `- Count: exactly ${constraints.count} of them\n` +
    // The same sentence the agent was given, from the same function (`#247`), so the
    // picture asked for and the picture checked for cannot be phrased apart.
    `- Binding: ${sceneBindingPhrase(constraints)}\n` +
    `- Setting: ${constraints.setting}\n` +
    `- Style: ${constraints.style}\n` +
    `- Prohibition: ${SCENE_PROHIBITION}\n\n` +
    'For the count, count them before answering, and answer false if there are more or fewer ' +
    `than ${constraints.count}.\n\n` +
    'For the binding, answer true only if each colour is on the object it was asked for. If the ' +
    'two colours are swapped, or if both objects carry both, answer false.\n\n' +
    'For the prohibition, answer false if any legible text, letter or digit appears anywhere, ' +
    'including a watermark or a signature.\n\n' +
    'Set notes to one short sentence naming what is wrong, or leave it empty if nothing is.'
  )
}

/**
 * Ask a vision model on OpenRouter whether the image matches the scene.
 *
 * The key arrives as an argument rather than being read from `process.env` here,
 * so that this package stays testable without an environment and the credential
 * is named in exactly one file — the runner's wiring.
 *
 * **Without a key every check is `unavailable`, deliberately**, and never a
 * failure. An unconfigured Colony that failed submissions would be punishing
 * agents for our own deploy — and on this rung it would be punishing them for
 * money they spent generating the image.
 */
export function openRouterSceneVision(
  apiKey: string | undefined,
  model: string | undefined = DEFAULT_SCENE_VISION_TIER,
  fetchImpl: typeof fetch = fetch,
  log?: Log,
  /** The operator's ceiling, or nothing — the ordinary state (`#1694`). */
  maxTokens?: number,
): SceneChecker {
  /**
   * A blank model name is an unset one, and a default parameter would not catch
   * it: `docker-compose.yml` writes `SCENE_VISION_MODEL: ${SCENE_VISION_MODEL:-}`
   * so a missing variable degrades the runner rather than refusing to start it,
   * and what that hands the process is an empty string.
   */
  const chosen = model === undefined || model.trim() === '' ? DEFAULT_SCENE_VISION_TIER : model

  return {
    check: async ({ image, format, constraints }): Promise<SceneCheckResult> => {
      if (apiKey === undefined || apiKey.trim() === '') {
        return {
          outcome: 'unavailable',
          reason: `no ${OPENROUTER_API_KEY_VAR} is configured, so no model can be asked.`,
        }
      }

      const dataUrl = `data:${format};base64,${Buffer.from(image).toString('base64')}`

      let response: Response
      try {
        response = await fetchImpl('/chat/completions', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(
            chatRequestBody({
              model: chosen,
              // Nothing creative is wanted. The same picture and the same
              // specification should produce the same verdict twice.
              temperature: 0,
              messages: [
                {
                  role: 'user',
                  content: [
                    { type: 'text', text: scenePromptForModel(constraints) },
                    { type: 'image_url', image_url: { url: dataUrl } },
                  ],
                },
              ],
              response_format: {
                type: 'json_schema',
                json_schema: { name: 'scene_check', strict: true, schema: SCENE_CHECK_SCHEMA },
              },
              ...(maxTokens === undefined ? {} : { maxTokens }),
            }),
          ),
        })
      } catch (error) {
        return {
          outcome: 'unavailable',
          reason: `the model could not be reached (${error instanceof Error ? error.message : String(error)}).`,
        }
      }

      /**
       * The same split as the `raster` rung's caller, from the same rule in
       * `vendor.ts` (`#217`): 402, 408, 429 and every 5xx clear on their own and
       * stay `unavailable`; any other 4xx is a request this process built and
       * will build identically next time.
       *
       * **It matters more here than there.** An attempt at this rung cost the
       * citizen money to generate, so a submission looping on a permanent error
       * is spending someone else's budget as well as ours.
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

      // A reply cut off at a ceiling is a failed call and never a verdict
      // (`#1694`). `unavailable`, because the remedy is asking again.
      try {
        throwIfTruncated(body)
      } catch {
        return {
          outcome: 'unavailable',
          reason: 'the model stopped at a token ceiling before it finished.',
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

      const check = SceneCheckSchema.safeParse(parsed)
      if (!check.success) {
        /**
         * A reply that parsed as JSON and is not the six booleans is the
         * Colony's problem — a wrong model configured, or a vendor that stopped
         * honouring the schema. Reading a missing field as `false` would fail an
         * agent for our misconfiguration, which is the one thing a verifier must
         * never do, and here it would also cost that agent the price of another
         * render.
         */
        return {
          outcome: 'unavailable',
          reason: 'the model answered a shape the Colony does not recognise.',
        }
      }

      /**
       * `call?.model` and not `call.model`: the accounting record is absent when
       * a provider reports no usage (`#716`), and the evidence still has to name a
       * model. `chosen` is what was asked for, which is the honest answer when
       * nothing said what answered — a distinction the accounting row keeps and
       * this surface does not need.
       */
      return { outcome: 'checked', check: check.data, model: call?.model ?? chosen }
    },
  }
}
