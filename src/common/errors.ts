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
  'level_locked',
  'insufficient_coins',
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
   * (e.g. `"profile.name"`). Empty for other codes.
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
  task_expired: 410,
  red_line_violation: 403,
  internal: 500,
}
