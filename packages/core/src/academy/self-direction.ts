import { z } from 'zod'

/** The five public formative themes fixed by D-152. */
export const SELF_DIRECTION_THEMES = [
  'initiative',
  'leverage',
  'outwardEffect',
  'strategicFocus',
  'selfRevision',
] as const
export const SelfDirectionThemeSchema = z.enum(SELF_DIRECTION_THEMES)
export type SelfDirectionTheme = z.infer<typeof SelfDirectionThemeSchema>

/** Instrument publication states; only a new version may change published content. */
export const SelfDirectionInstrumentLifecycleSchema = z.enum([
  'draft',
  'pilot',
  'active',
  'retired',
])
export type SelfDirectionInstrumentLifecycle = z.infer<
  typeof SelfDirectionInstrumentLifecycleSchema
>

export const SelfDirectionItemAudienceSchema = z.enum(['general', 'profession'])
export const SelfDirectionItemStateSchema = z.enum(['active', 'retired'])

const KeySchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(64)
const line = z.string().trim().min(1).max(500)

export const SelfDirectionThemeWeightsSchema = z
  .object({
    initiative: z.int().min(-100).max(100),
    leverage: z.int().min(-100).max(100),
    outwardEffect: z.int().min(-100).max(100),
    strategicFocus: z.int().min(-100).max(100),
    selfRevision: z.int().min(-100).max(100),
  })
  .strict()
export type SelfDirectionThemeWeights = z.infer<typeof SelfDirectionThemeWeightsSchema>

export const SelfDirectionOptionSchema = z
  .object({
    key: KeySchema,
    text: line,
    weights: SelfDirectionThemeWeightsSchema,
    patterns: z.array(KeySchema).max(8),
  })
  .strict()
export type SelfDirectionOption = z.infer<typeof SelfDirectionOptionSchema>

export const SelfDirectionItemSchema = z
  .object({
    key: KeySchema,
    audience: SelfDirectionItemAudienceSchema,
    professionTag: KeySchema.nullable(),
    scenarioKind: KeySchema,
    prompt: z.string().trim().min(1).max(2000),
    rationale: z.string().trim().min(1).max(1000),
    state: SelfDirectionItemStateSchema,
    options: z.array(SelfDirectionOptionSchema).max(8),
  })
  .strict()
  .superRefine((item, ctx) => {
    if (item.audience === 'general' && item.professionTag !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'general items cannot name a profession',
      } as never)
    }
    if (item.audience === 'profession' && item.professionTag === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'profession items require a profession tag',
      } as never)
    }
    if (new Set(item.options.map(({ key }) => key)).size !== item.options.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'option keys must be unique' })
    }
  })
export type SelfDirectionItem = z.infer<typeof SelfDirectionItemSchema>

export const SelfDirectionInstrumentDocumentSchema = z
  .object({
    slug: KeySchema,
    version: z.int().positive(),
    lifecycle: SelfDirectionInstrumentLifecycleSchema,
    cadenceDays: z.int().positive().max(365),
    retestFloorHours: z.int().positive().max(8760),
    compatibility: z
      .object({
        lineage: KeySchema,
        comparableToPrevious: z.boolean(),
      })
      .strict(),
    themeDefinitions: z
      .array(z.object({ key: SelfDirectionThemeSchema, description: line }).strict())
      .length(SELF_DIRECTION_THEMES.length),
    items: z.array(SelfDirectionItemSchema).max(500),
  })
  .strict()
  .superRefine((instrument, ctx) => {
    if (
      new Set(instrument.themeDefinitions.map(({ key }) => key)).size !==
      SELF_DIRECTION_THEMES.length
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'every theme requires one definition' })
    }
    if (new Set(instrument.items.map(({ key }) => key)).size !== instrument.items.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'item keys must be unique' })
    }
    if (instrument.lifecycle === 'draft') return
    if (instrument.items.length !== 10) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a published MVP requires exactly ten items',
      })
    }
    instrument.items.forEach((item, index) => {
      if (item.options.length !== 4) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['items', index, 'options'],
          message: 'a published MVP item requires exactly four options',
        })
      }
    })
    for (const theme of SELF_DIRECTION_THEMES) {
      const coverage = instrument.items.filter((item) =>
        item.options.some((option) => option.weights[theme] !== 0),
      ).length
      if (coverage < 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${theme} must be covered by at least two items`,
        })
      }
    }
  })
export type SelfDirectionInstrumentDocument = z.infer<typeof SelfDirectionInstrumentDocumentSchema>

/** Stable canonical content used to make idempotent publication distinguish drift. */
export function selfDirectionInstrumentContentHash(
  instrument: SelfDirectionInstrumentDocument,
): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical)
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, canonical(entry)]),
      )
    }
    return value
  }
  return JSON.stringify(canonical(instrument))
}
