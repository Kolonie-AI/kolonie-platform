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
  'insufficient_coins',
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
  'task_expired',
  'red_line_violation',
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
  insufficient_coins: 402,
  // 403: the Colony understood the request and will not take it as offered.
  assistance_refused: 403,
  task_expired: 410,
  red_line_violation: 403,
  internal: 500,
}
