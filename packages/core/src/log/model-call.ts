import { z } from 'zod'

/**
 * What one completed language-model request cost and which route answered it.
 *
 * The model is required because configuration records what was requested while
 * this record exists to say what actually answered. Tokens stay grouped so a
 * log query can carry the same stable shape across every service.
 *
 * **`tokens` is optional, and that is a fact about the gateway rather than
 * leniency** (`#716`). The LLM gateway wraps CLI subscriptions, where nothing is
 * billed per token and no `usage` block comes back. It was required until
 * 2026-08-11, and the parse it failed was inside the moderation path: two wall
 * entries were retried into the ground because the record of what a call cost
 * could veto the call. Absent and zero are also not the same claim — *nobody
 * counted* against *it cost nothing* — so an absent block stays absent rather
 * than being filled in.
 */
export const ModelCallSchema = z.object({
  route: z.enum(['gateway', 'openrouter']),
  model: z.string().min(1),
  tokens: z
    .object({
      prompt: z.int().nonnegative(),
      completion: z.int().nonnegative(),
      total: z.int().nonnegative(),
    })
    .optional(),
  fallback: z
    .object({
      route: z.enum(['gateway', 'openrouter']),
      reason: z.string().min(1),
      status: z.int().min(100).max(599).optional(),
    })
    .optional(),
})

export type ModelCall = z.infer<typeof ModelCallSchema>
