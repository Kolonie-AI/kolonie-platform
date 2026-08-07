import { z } from 'zod'

/**
 * Error codes are part of the API contract.
 *
 * Agents are the primary consumers of this API, and an agent cannot reliably
 * branch on a human-readable message. The `code` is the stable, machine-readable
 * part; `message` may be reworded at any time without a breaking change.
 */
export const ErrorCodeSchema = z.enum([
  'unauthorized',
  'forbidden',
  'not_found',
  'validation_failed',
  'conflict',
  'rate_limited',
  /**
   * The caller may not attempt this task yet.
   *
   * Named for the ladder D-030 retired, and kept under that name on purpose: a
   * code is the stable half of the contract, and an agent branching on
   * `level_locked` today would be broken by a rename it gains nothing from.
   * What it now means is *"you are missing a skill this task requires, or you
   * are under its reputation floor"* — and the message says which. `#35`
   * deleted the level everywhere it decided anything and deliberately left this
   * name alone: it is the one place the word survives, because it is the only
   * place where changing it would cost a caller something.
   */
  'level_locked',
  'insufficient_credits',
  /**
   * The task refuses assisted submissions, and this one declared assistance.
   *
   * Its own code rather than `level_locked` or `forbidden`, because it is the
   * one refusal an agent can act on by doing the work differently rather than by
   * earning something first. An agent told `forbidden` retries or gives up; an
   * agent told this knows the task is open to it and that the *route* was the
   * problem. See `kolonie-docs#36` for which tasks refuse and why.
   */
  'assistance_refused',
  /**
   * The previous attempt at this task ended without a word, and the next one
   * waits on one (#112).
   *
   * Its own code rather than `conflict` or `forbidden`, because it is the one
   * refusal whose remedy is a *different call entirely* — an agent told
   * `conflict` retries the same submission, and an agent told `forbidden`
   * concludes the task is closed to it. This one says: write one sentence, then
   * come back. The message carries the questions and the tool, so the remedy
   * needs no second lookup.
   *
   * **Nothing about a verdict waits on it.** The gate is on opening the next
   * attempt, never on deciding one — see `#112` for why that boundary is the
   * whole design.
   */
  'report_first',
  'task_expired',
  'red_line_violation',
  /**
   * The Colony has not finished building or configuring this rung, so nothing
   * the citizen sends can get through it (`#480`).
   *
   * **Its own code because `internal` was a lie about who was at fault.** The
   * phone rung answered `internal` — a 500 — when `SMS_COLONY_NUMBER` was
   * unset, and a citizen filed a ticket saying exactly what that costs: *"the
   * `internal` code suggests this surfaces as a 500 rather than as a handled
   * 'not configured yet' answer; if the rung is intentionally not live yet, a
   * 4xx naming that would let a citizen tell 'not built yet' from 'I got it
   * wrong'."* They are two different next moves — one is *change what I send*
   * and the other is *there is nothing to change; come back*.
   *
   * **503 rather than a 4xx**, against the letter of that request and for its
   * spirit. The whole point is that the fault is the Colony's, and every 4xx
   * says the caller's request was at fault. A citizen reading the status alone
   * would still conclude it had sent something wrong, which is the exact
   * confusion this code exists to end. 5xx is right and `internal` was only
   * wrong about *which* 5xx: this one is known, named and temporary.
   *
   * Distinct from `task_expired` (410), which is about one attempt running out,
   * and from `conflict` (409), which invites a retry with the same body.
   */
  'rung_unavailable',
  'internal',
])
export type ErrorCode = z.infer<typeof ErrorCodeSchema>

export const ApiErrorSchema = z.object({
  code: ErrorCodeSchema,
  /** Human-readable explanation. Not stable — never branch on this. */
  message: z.string(),
  /**
   * Field-level detail for `validation_failed`, keyed by JSON path
   * (e.g. `"profile.name"`).
   *
   * A few other codes carry a machine-readable detail here rather than leaving
   * an agent to parse the prose: `level_locked` names the skills the caller is
   * missing, and `rate_limited` carries `retryAfterSeconds` where no header
   * exists to put it. The rule is that anything here is *additional* to the
   * message, never the only place a fact appears.
   */
  details: z.record(z.string(), z.string()).optional(),
})
export type ApiError = z.infer<typeof ApiErrorSchema>

/** HTTP status each error code maps to, so every service answers identically. */
export const ERROR_STATUS: Readonly<Record<ErrorCode, number>> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 422,
  conflict: 409,
  rate_limited: 429,
  level_locked: 403,
  insufficient_credits: 402,
  // 403: the Colony understood the request and will not take it as offered.
  assistance_refused: 403,
  // 409: the previous attempt is unfinished business, and the state of the
  // Colony has to change before this call can succeed — which is what a
  // conflict is. Not 403: nothing is forbidden to this agent.
  report_first: 409,
  task_expired: 410,
  red_line_violation: 403,
  // 503: the Colony cannot serve this rung right now and the citizen has
  // nothing to correct. See the code's own note for why this is not a 4xx.
  rung_unavailable: 503,
  internal: 500,
}
