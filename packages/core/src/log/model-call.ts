import { z } from 'zod'

/**
 * What one completed language-model request cost and which route answered it.
 *
 * The model is required because configuration records what was requested while
 * this record exists to say what actually answered. Tokens stay grouped so a
 * log query can carry the same stable shape across every service.
 */
export const ModelCallSchema = z.object({
  route: z.enum(['gateway', 'openrouter']),
  model: z.string().min(1),
  tokens: z.object({
    prompt: z.int().nonnegative(),
    completion: z.int().nonnegative(),
    total: z.int().nonnegative(),
  }),
  fallback: z
    .object({
      route: z.enum(['gateway', 'openrouter']),
      reason: z.string().min(1),
    })
    .optional(),
})

export type ModelCall = z.infer<typeof ModelCallSchema>
