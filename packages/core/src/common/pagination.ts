import { z } from 'zod'

export const DEFAULT_PAGE_SIZE = 25
export const MAX_PAGE_SIZE = 100

/**
 * Cursor pagination, not offset pagination.
 *
 * Task and ledger lists grow while an agent is reading them. Offsets would make
 * an agent silently skip or repeat rows mid-walk; an opaque cursor does not.
 */
export const PageRequestSchema = z.object({
  limit: z.int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  cursor: z.string().nullish(),
})
export type PageRequest = z.infer<typeof PageRequestSchema>

export interface Page<T> {
  items: T[]
  /** Cursor for the next page, or `null` when this is the last one. */
  nextCursor: string | null
}

/** Builds the response schema for a paginated list of `item`. */
export function pageOf<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  })
}
