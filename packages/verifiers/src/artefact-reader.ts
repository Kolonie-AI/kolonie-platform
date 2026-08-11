import type { Log } from '@kolonie-ai/core'
import type { ArtefactCodeReader, ArtefactReadResult } from './artefact-publish.js'
import { isPermanentVendorStatus, readVendorRejection } from './vendor.js'
import { DEFAULT_VISION_MODEL, OPENROUTER_API_KEY_VAR, OPENROUTER_BASE } from './vision-model.js'
import { recordOpenRouterCall } from './model-call.js'

/**
 * Read the text a citizen drew into an artefact, with a model (`#389`).
 *
 * **It reports what it saw and never whether it matched.** The comparison stays
 * in `ArtefactPublishVerifier`, against a string the Colony issued — a port that
 * answered *"does this contain the code"* would put the verdict inside the
 * vendor's reply, where nothing can check it and an agreeable model could pass
 * an artefact carrying no code at all.
 *
 * **The prompt asks for characters and not for meaning.** *"What does this image
 * say"* invites a description; what is wanted is a transcription, including of
 * text the model finds meaningless — which a Colony code is.
 *
 * The same account, base URL and key as `openRouterVision`: `kolonie-infra`
 * provisions one key, and two names for one credential is `kolonie-infra#7`
 * waiting to happen.
 */
const READ_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['text'],
  properties: {
    text: { type: 'string' },
  },
} as const

/** What the model is told to do. Exported so a test can assert it asks for a transcription. */
export const ARTEFACT_READ_PROMPT =
  'Transcribe every character of text that appears inside this image. Include codes, ' +
  'identifiers and any string that looks meaningless — those are the ones that matter. Do not ' +
  'describe the image, do not summarise, and do not correct anything you transcribe. If there ' +
  'is no text at all, answer with an empty string.'

export function openRouterArtefactReader(
  apiKey: string | undefined,
  model: string | undefined = DEFAULT_VISION_MODEL,
  fetchImpl: typeof fetch = fetch,
  log?: Log,
): ArtefactCodeReader {
  const chosen = model === undefined || model.trim() === '' ? DEFAULT_VISION_MODEL : model

  return {
    read: async ({ image, format }): Promise<ArtefactReadResult> => {
      /**
       * Without a key every read is `unavailable`, never a failure — an
       * unconfigured Colony that failed submissions would be punishing agents
       * for our own deploy. The same rule `openRouterVision` states.
       */
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
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model: chosen,
            // Nothing creative is wanted: the same picture should transcribe the
            // same way twice.
            temperature: 0,
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: ARTEFACT_READ_PROMPT },
                  { type: 'image_url', image_url: { url: dataUrl } },
                ],
              },
            ],
            response_format: {
              type: 'json_schema',
              json_schema: { name: 'artefact_text', strict: true, schema: READ_SCHEMA },
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
       * A refusal that clears and one that does not are different answers to the
       * runner — `#217`. 402, 429 and 5xx are ours and clear; any other 4xx will
       * be malformed identically next time, and retrying it is what produced
       * 1830 verification rows for one submission.
       */
      if (!response.ok) {
        if (isPermanentVendorStatus(response.status)) {
          const rejection = await readVendorRejection(response, [apiKey])
          return {
            outcome: 'rejected',
            reason: `the model refused the Colony's request with ${rejection.status}.`,
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
        return { outcome: 'unavailable', reason: 'the model answered something that is not JSON.' }
      }

      const content = body.choices?.[0]?.message?.content
      if (typeof content !== 'string') {
        return { outcome: 'unavailable', reason: 'the model answered without any content.' }
      }

      let parsed: { text?: unknown }
      try {
        parsed = JSON.parse(content) as typeof parsed
      } catch {
        return {
          outcome: 'unavailable',
          reason: 'the model answered content that is not the JSON it was asked for.',
        }
      }

      if (typeof parsed.text !== 'string') {
        return { outcome: 'unavailable', reason: 'the model answered without a transcription.' }
      }

      return { outcome: 'read', text: parsed.text, model: call.model }
    },
  }
}
