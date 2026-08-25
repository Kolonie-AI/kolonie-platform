/**
 * What every caller puts in a chat completion request, and what every caller
 * refuses in the reply (`#1694`).
 *
 * Two rules, each measured on 2026-08-25 and each cheap to get wrong silently.
 */

/**
 * The stable code a truncated completion carries.
 *
 * Agents cannot branch on prose — `AGENTS.md` §3 — and this failure reaches an
 * agent as a verification that could not be made. A code rather than a message
 * so that *the answer was cut off* stays tellable from *the model refused* after
 * either sentence is reworded.
 */
export const COMPLETION_TRUNCATED = 'completion_truncated'

/**
 * The model stopped at a ceiling instead of finishing.
 *
 * **A truncated reply is well-formed, which is what makes it dangerous.** It
 * parses, it has the shape asked for, and it is a judgement nobody finished
 * writing — so accepted, it is a verdict the model did not reach. The failure
 * has to be raised at the transport rather than left to each caller's schema
 * check, because a cut-off reply frequently satisfies the schema.
 *
 * **It is raised on `finish_reason` and not on a number**, deliberately.
 * `#1694` removed the output ceiling from this repository, so nothing here knows
 * what the ceiling was: the gateway may impose one no constant here can see, and
 * a preset may carry one. `finish_reason` is the field that is true at any
 * ceiling.
 */
export class TruncatedCompletion extends Error {
  readonly code = COMPLETION_TRUNCATED

  constructor(readonly detail?: string) {
    super(
      `the model stopped at a token ceiling before it finished${
        detail === undefined ? '' : `: ${detail}`
      }`,
    )
    this.name = 'TruncatedCompletion'
  }
}

/**
 * Refuse a reply the model said it did not finish.
 *
 * **Silence is not truncation.** A reply naming no `finish_reason` is left
 * alone: whatever the caller already does with a missing content field is the
 * right handling, and reading it as truncation would attribute a cause nobody
 * measured. Only the model's own word for it counts.
 */
export function throwIfTruncated(body: unknown): void {
  const choice = (body as { choices?: { finish_reason?: unknown }[] } | null)?.choices?.[0]
  if (choice?.finish_reason !== 'length') return

  throw new TruncatedCompletion('finish_reason length')
}

/** What a caller hands to {@link chatRequestBody}: its own fields, plus the ceiling if one is set. */
export interface ChatRequest {
  /**
   * The capability tier, sent to the gateway exactly as given.
   *
   * Typed as a string rather than as `CapabilityTier` because a per-service
   * `LLM_GATEWAY_MODEL_<SERVICE>` override still overrides — an operator pinning
   * one service to one exact model during an incident is the reason those
   * variables exist, and this is the layer the pinned value travels through.
   */
  readonly model: string
  readonly messages: readonly unknown[]
  /**
   * The operator's ceiling, from `LLM_GATEWAY_MAX_TOKENS_<SERVICE>`, or nothing.
   * Nothing is the ordinary case and means the field is absent from the body.
   */
  readonly maxTokens?: number
  readonly [field: string]: unknown
}

/**
 * The request body, with the two rules applied that no caller may forget.
 *
 * **`"stream": false` explicitly.** Measured 2026-08-25 on SprintCX: the field
 * decides the response shape, and **omitting it yields `text/event-stream`**
 * rather than JSON. A caller that omits it and calls `JSON.parse` gets a parse
 * error on an HTTP 200 — which reads as a broken key rather than as a wrong
 * request, and cost an hour the day it was found. Every caller here parses JSON,
 * so it is set here rather than asked of each of them.
 *
 * **`max_tokens` only if an operator set one.** It is a ceiling and not a
 * reservation: the model stops on its own, so a number set here can only ever be
 * too small, and setting one "very high" is omitting it plus a figure a later
 * reader mistakes for a considered limit. Unset means the field is not in the
 * body at all. What guards a truncated answer instead is
 * {@link throwIfTruncated}.
 */
export function chatRequestBody(request: ChatRequest): Record<string, unknown> {
  const { maxTokens, ...rest } = request

  return {
    ...rest,
    stream: false,
    ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
  }
}
