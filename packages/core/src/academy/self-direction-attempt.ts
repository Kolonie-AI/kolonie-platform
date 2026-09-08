import { z } from 'zod'
import {
  SELF_DIRECTION_THEMES,
  type SelfDirectionInstrumentDocument,
  type SelfDirectionTheme,
} from './self-direction.js'

export const SELF_DIRECTION_ATTEMPT_STATES = [
  'open',
  'awaiting-reflection',
  'closed',
  'expired',
] as const
export const SelfDirectionAttemptStateSchema = z.enum(SELF_DIRECTION_ATTEMPT_STATES)
export type SelfDirectionAttemptState = z.infer<typeof SelfDirectionAttemptStateSchema>

export const SelfDirectionResponseSchema = z
  .object({ itemKey: z.string().min(1).max(64), optionKey: z.string().min(1).max(64) })
  .strict()
export type SelfDirectionResponse = z.infer<typeof SelfDirectionResponseSchema>

export const SelfDirectionSubmissionSchema = z
  .object({ responses: z.array(SelfDirectionResponseSchema).length(10) })
  .strict()
export type SelfDirectionSubmission = z.infer<typeof SelfDirectionSubmissionSchema>

export const SelfDirectionResultSchema = z
  .object({
    total: z.int().min(0).max(100),
    themes: z
      .object({
        initiative: z.int().min(0).max(100),
        leverage: z.int().min(0).max(100),
        outwardEffect: z.int().min(0).max(100),
        strategicFocus: z.int().min(0).max(100),
        selfRevision: z.int().min(0).max(100),
      })
      .strict(),
    patterns: z
      .array(z.object({ key: z.string().min(1).max(64), count: z.int().positive() }).strict())
      .max(3),
  })
  .strict()
export type SelfDirectionResult = z.infer<typeof SelfDirectionResultSchema>

const normalise = (score: number, minimum: number, maximum: number): number => {
  if (maximum === minimum) return 50
  return Math.round(((score - minimum) / (maximum - minimum)) * 100)
}

/** Deterministic arithmetic over public weights; no judgement or model call is involved. */
export function scoreSelfDirectionResponses(
  instrument: SelfDirectionInstrumentDocument,
  input: readonly SelfDirectionResponse[],
): SelfDirectionResult {
  const responses = SelfDirectionSubmissionSchema.parse({ responses: input }).responses
  if (new Set(responses.map(({ itemKey }) => itemKey)).size !== instrument.items.length) {
    throw new Error('every item must be answered once')
  }
  const selected = responses.map((response) => {
    const item = instrument.items.find(({ key }) => key === response.itemKey)
    if (item === undefined) throw new Error(`unknown item ${response.itemKey}`)
    const option = item.options.find(({ key }) => key === response.optionKey)
    if (option === undefined) throw new Error(`unknown option ${response.optionKey}`)
    return { item, option }
  })
  const themes = Object.fromEntries(
    SELF_DIRECTION_THEMES.map((theme) => {
      const score = selected.reduce((sum, { option }) => sum + option.weights[theme], 0)
      const minimum = selected.reduce(
        (sum, { item }) => sum + Math.min(...item.options.map(({ weights }) => weights[theme])),
        0,
      )
      const maximum = selected.reduce(
        (sum, { item }) => sum + Math.max(...item.options.map(({ weights }) => weights[theme])),
        0,
      )
      return [theme, normalise(score, minimum, maximum)]
    }),
  ) as Record<SelfDirectionTheme, number>
  const counts = new Map<string, number>()
  for (const { option } of selected) {
    for (const pattern of option.patterns) counts.set(pattern, (counts.get(pattern) ?? 0) + 1)
  }
  const patterns = [...counts]
    .map(([key, count]) => ({ key, count }))
    .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key))
    .slice(0, 3)
  return SelfDirectionResultSchema.parse({
    total: Math.round(
      SELF_DIRECTION_THEMES.reduce((sum, theme) => sum + themes[theme], 0) /
        SELF_DIRECTION_THEMES.length,
    ),
    themes,
    patterns,
  })
}
