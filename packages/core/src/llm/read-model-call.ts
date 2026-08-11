import { silentLog, type Log } from '../log/log.js'
import { ModelCallSchema, type ModelCall } from '../log/model-call.js'
import { routeOf } from './gateway.js'

/**
 * The accounting fields of a completed model response, read and logged.
 *
 * ## Why this cannot throw
 *
 * **A record of what a call cost must never be able to veto the call** (`#716`).
 * Three services each had their own copy of this — `apps/moderation-runner`,
 * `apps/support-triage-runner`, `packages/verifiers` — and every copy called
 * `ModelCallSchema.parse` on the way out of a successful request. On 2026-08-11
 * the LLM gateway began answering without a `usage` block, which is ordinary for
 * a CLI subscription that bills nothing per token, and all three inherited the
 * same failure: a `ZodError` thrown *after* the model had answered correctly,
 * propagating out of the caller as though the model call had failed. Two wall
 * entries were retried into the ground for it.
 *
 * So everything here is read defensively and nothing is asserted. A field this
 * cannot make sense of is left off the record and mentioned in a `warn`; the
 * caller gets its answer either way.
 *
 * ## Why it returns `undefined` rather than a placeholder
 *
 * `model` is what actually answered, and there is no honest stand-in for it —
 * the configured model is what was *asked for*, which is the distinction
 * `ModelCallSchema` exists to preserve. A body that names no model produces no
 * record at all, and every caller already holds `call` optionally. An invented
 * value would be indistinguishable from a measurement in a log query, which is
 * the one outcome worth more than the missing row.
 *
 * `response` is the HTTP response the body came out of, and it is what says
 * which route answered (`#674`). Omitting it records OpenRouter, which is what
 * an unrouted service is doing.
 */
export function readModelCall(
  body: unknown,
  log: Log = silentLog,
  response?: Response,
): ModelCall | undefined {
  const answered = body as {
    model?: unknown
    usage?: {
      prompt_tokens?: unknown
      completion_tokens?: unknown
      total_tokens?: unknown
    }
  } | null

  /**
   * The counts are validated apart from the rest, so a `usage` block that makes
   * no sense costs the counts and not the record. `prompt` alone with no `total`
   * is a real shape and there is nothing to do with it; the model that answered
   * and the route it came through are still measurements worth keeping.
   */
  const tokens = TokensSchema.safeParse(countsOf(answered?.usage))

  const parsed = ModelCallSchema.safeParse({
    ...routeOf(response),
    model: answered?.model,
    ...(tokens.success && tokens.data !== undefined ? { tokens: tokens.data } : {}),
  })

  if (!parsed.success) {
    // `warn`, not `error`: the work this accounts for succeeded, and an `error`
    // here would put a line in front of somebody about a call that was fine.
    log.warn('a model answered and its accounting could not be read', {
      event: 'model.call.unaccountable',
      reason: reasons(parsed.error.issues),
    })
    return undefined
  }

  if (!tokens.success) {
    log.warn('a model answered and reported a token count that could not be read', {
      event: 'model.call.usage.unreadable',
      model: parsed.data.model,
      reason: reasons(tokens.error.issues),
    })
  }

  const call = parsed.data
  log.info(`${call.model} answered through ${call.route}`, {
    event: 'model.call.completed',
    model: call.model,
    route: call.route,
    ...(call.tokens === undefined ? {} : { tokens: call.tokens }),
    ...(call.fallback === undefined ? {} : { fallback: call.fallback }),
  })
  return call
}

/** The token block on its own, so it can fail without taking the record with it. */
const TokensSchema = ModelCallSchema.shape.tokens

function reasons(issues: readonly { path: readonly PropertyKey[]; message: string }[]): string {
  return issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
}

/**
 * The `usage` block as the provider sent it, or nothing when it sent none.
 *
 * Nothing is coerced or filled in here: whether the three counts are numbers is
 * the schema's question, and answering it in two places is how the two answers
 * come apart. What this decides is only *was there a usage block at all* —
 * absent is ordinary (a subscription bills nothing per token), and it must not
 * read as a malformed one.
 */
function countsOf(usage: unknown): unknown {
  if (usage === null || typeof usage !== 'object') return undefined
  const {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
  } = usage as {
    prompt_tokens?: unknown
    completion_tokens?: unknown
    total_tokens?: unknown
  }
  if (prompt === undefined && completion === undefined && total === undefined) return undefined
  return { prompt, completion, total }
}
