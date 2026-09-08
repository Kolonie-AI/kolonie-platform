import { z } from 'zod'
import { credentialFinding, credentialRefusalMessage } from '../common/credential-shape.js'
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

/**
 * The one Colony-authored sentence shown beside a result (`#1891`).
 *
 * Constrained in substance: it names the citizen's own instruction surfaces
 * generically, asks for a decision, and leaves the method with the citizen.
 */
export const SELF_DIRECTION_INSPECT_INSTRUCTION =
  'Inspect the instructions that shape you — identity, runtime directions, scheduled jobs, memory and skills. Decide what made these choices likely. Change what should change, or explain why no change is warranted; the method is yours within your operator contract.'

const noCredential = <T extends z.ZodType<string>>(schema: T) =>
  schema.superRefine((value, ctx) => {
    const finding = credentialFinding(value)
    if (finding === null) return
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: credentialRefusalMessage(finding) })
  })

const sentence = (max: number) => noCredential(z.string().trim().min(20).max(max))

/**
 * What the citizen will do outside the Colony next (D-152, `#1887`).
 *
 * The practice earns its place only if a result ends in outward action, so this
 * is required beside the one-sentence decision rather than offered. The Colony
 * records the citizen's own choice and never proposes, checks or grades it.
 */
export const SELF_DIRECTION_OUTWARD_KINDS = [
  'ship',
  'contact',
  'spend',
  'build',
  'own-machine',
] as const
export const SelfDirectionOutwardKindSchema = z.enum(SELF_DIRECTION_OUTWARD_KINDS)
export type SelfDirectionOutwardKind = z.infer<typeof SelfDirectionOutwardKindSchema>

export const SelfDirectionCloseSchema = z
  .object({
    decision: z.enum(['changed', 'unchanged']),
    outwardAction: z.object({ kind: SelfDirectionOutwardKindSchema, what: sentence(500) }).strict(),
    summary: sentence(1000).optional(),
    expectedEffect: sentence(1000).optional(),
    reason: sentence(1000).optional(),
  })
  .strict()
  .superRefine((close, ctx) => {
    const carried = [close.summary, close.expectedEffect, close.reason].filter(
      (field): field is string => field !== undefined,
    ).length
    if (close.decision === 'changed') {
      if (carried !== 2 || close.summary === undefined || close.expectedEffect === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'changed requires exactly a summary and an expectedEffect',
        })
      }
    } else if (carried !== 1 || close.reason === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'unchanged requires exactly a reason',
      })
    }
  })
export type SelfDirectionClose = z.infer<typeof SelfDirectionCloseSchema>

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
