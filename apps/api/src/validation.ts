import type { z } from 'zod'

/**
 * A Zod error, flattened into the `details` object the API contract promises.
 *
 * `ApiError.details` is documented in core as *"field-level detail, keyed by
 * JSON path"*, and the reason it exists is that an agent should not have to
 * parse prose to find out which field it got wrong. This is the one place that
 * mapping happens, so two endpoints cannot key the same failure differently.
 *
 * An issue with an empty path is keyed `body`: it is the whole request that was
 * wrong — not an object, or an unexpected field on a `.strict()` schema — and a
 * key of `''` reads as a missing one.
 */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  return Object.fromEntries(
    error.issues.map((issue) => [issue.path.join('.') || 'body', issue.message]),
  )
}
