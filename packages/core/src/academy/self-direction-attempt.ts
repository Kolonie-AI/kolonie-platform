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

/**
 * What became of the outward act a citizen named at its previous close
 * (`#1910`, D-152).
 *
 * **Self-report, and the vocabulary is built so that every value is sayable.**
 * The Colony cannot see whether anything was shipped, contacted, spent, built
 * or run, so this records a citizen's own dated claim about a specific named
 * act. `not-yet` and `abandoned` are ordinary answers rather than lesser ones:
 * a loop in which only `done` looks acceptable collects lies instead of
 * evidence, and lies are worse than the silence this replaces.
 *
 * Nothing reads it to score, gate, rank, pay or escalate — see
 * {@link SELF_DIRECTION_FOLLOW_THROUGH_LABEL}, which travels with it wherever
 * it is read so it can never be mistaken for outside observation.
 */
export const SELF_DIRECTION_FOLLOW_THROUGH_OUTCOMES = [
  'done',
  'partly',
  'not-yet',
  'abandoned',
] as const
export const SelfDirectionFollowThroughOutcomeSchema = z.enum(
  SELF_DIRECTION_FOLLOW_THROUGH_OUTCOMES,
)
export type SelfDirectionFollowThroughOutcome = z.infer<
  typeof SelfDirectionFollowThroughOutcomeSchema
>

/**
 * The one label carried beside every follow-through answer, everywhere.
 *
 * The whole risk of asking this question is that the answer is later read as
 * though the Colony had watched the act happen. This sentence is a value rather
 * than prose in a doc comment precisely so a reader gets it from the data.
 */
export const SELF_DIRECTION_FOLLOW_THROUGH_LABEL =
  'self-report by the citizen; the Colony did not observe this act'

export const SelfDirectionFollowThroughSchema = z
  .object({
    outcome: SelfDirectionFollowThroughOutcomeSchema,
    note: sentence(500),
  })
  .strict()
export type SelfDirectionFollowThrough = z.infer<typeof SelfDirectionFollowThroughSchema>

export const SelfDirectionCloseSchema = z
  .object({
    decision: z.enum(['changed', 'unchanged']),
    /**
     * What became of the previous close's outward act, when there was one.
     *
     * Optional in the schema because the first close a citizen ever makes has
     * nothing to report on. Whether it is *required* is decided where the
     * previous close is known, which is storage, not here.
     */
    followThrough: SelfDirectionFollowThroughSchema.optional(),
    outwardAction: z.object({ kind: SelfDirectionOutwardKindSchema, what: sentence(500) }).strict(),
    summary: sentence(1000).optional(),
    expectedEffect: sentence(1000).optional(),
    /**
     * Why the citizen decided as it did (`#1915`).
     *
     * **Required on `unchanged`, an optional free note on `changed`.** An
     * unchanged close is nothing but its reason, so it is what makes that
     * decision sayable at all. On a changed close the summary and the expected
     * effect are what the practice needs, and a citizen that also explains
     * itself has answered with more than the branch asked for — refusing that
     * spent a call and taught the citizen to say less, which is the opposite of
     * what this practice is for.
     */
    reason: sentence(1000).optional(),
  })
  .strict()
  .superRefine((close, ctx) => {
    if (close.decision === 'changed') {
      if (close.summary === undefined || close.expectedEffect === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'changed requires a summary and an expectedEffect',
        })
      }
    } else if (close.reason === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'unchanged requires a reason',
      })
    } else if (close.summary !== undefined || close.expectedEffect !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'unchanged takes no summary or expectedEffect',
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
