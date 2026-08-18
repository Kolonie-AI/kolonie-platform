import { z } from 'zod'
import { TimestampSchema } from '../common/time.js'
import {
  ABUSIVE_SUSPEND_MIN_COUNT,
  ABUSIVE_SUSPEND_MIN_RATE,
  ABUSIVE_SUSPEND_WINDOW_DAYS,
  ABUSIVE_WARN_MIN_COUNT,
  ContributionSurfaceSchema,
  CitizenshipSuspensionSourceSchema,
} from './contribution-verdict.js'

/**
 * A citizen's own contribution-quality ledger (`#1262`).
 *
 * Modelled on `kolonie.doctor`: private, free, callable as often as liked, and
 * it changes nothing. Counts for approvals; reasons only on `abusive` rows.
 * `useless` is counted and labelled as counting toward nothing — hiding it would
 * make the number the citizen sees not add up.
 */

export const ContributionQualitySurfaceCountsSchema = z.object({
  approved: z.int().nonnegative(),
  useless: z.int().nonnegative(),
  abusive: z.int().nonnegative(),
})
export type ContributionQualitySurfaceCounts = z.infer<
  typeof ContributionQualitySurfaceCountsSchema
>

export const ContributionQualityAbusiveReasonSchema = z.object({
  surface: ContributionSurfaceSchema,
  reason: z.string().nullable(),
  decidedAt: TimestampSchema,
})
export type ContributionQualityAbusiveReason = z.infer<
  typeof ContributionQualityAbusiveReasonSchema
>

export const ContributionQualitySuspensionSchema = z.object({
  reason: z.string(),
  source: CitizenshipSuspensionSourceSchema,
  startedAt: TimestampSchema,
  expiresAt: TimestampSchema,
})
export type ContributionQualitySuspension = z.infer<
  typeof ContributionQualitySuspensionSchema
>

export const ContributionQualityAnswerSchema = z
  .object({
    /** The window these figures cover — the same 90 days the sanction reads. */
    windowDays: z.literal(ABUSIVE_SUSPEND_WINDOW_DAYS),
    /** Per-surface counts over the effective window. */
    bySurface: z.record(ContributionSurfaceSchema, ContributionQualitySurfaceCountsSchema),
    totals: z.object({
      approved: z.int().nonnegative(),
      /** Counted, and labelled as counting toward nothing. */
      useless: z.int().nonnegative(),
      abusive: z.int().nonnegative(),
      /** Approvals + useless + abusive — the denominator a rate needs. */
      judged: z.int().nonnegative(),
    }),
    /**
     * Reasons on this citizen's `abusive` verdicts only.
     *
     * Approvals are counts; abusive is the arm that carries a reason worth
     * reading back. Ordered newest first.
     */
    abusiveReasons: z.array(ContributionQualityAbusiveReasonSchema),
    /**
     * Where the citizen stands against both suspend bounds, and the early-warn
     * threshold. The numbers are the floored window the sweep uses — verdicts
     * from before a served suspension do not recount.
     */
    standing: z.object({
      abusive: z.int().nonnegative(),
      judged: z.int().nonnegative(),
      /** `null` when nothing has been judged yet. */
      rate: z.number().nonnegative().nullable(),
      warnAt: z.literal(ABUSIVE_WARN_MIN_COUNT),
      suspendMinCount: z.literal(ABUSIVE_SUSPEND_MIN_COUNT),
      /** Strictly greater than this share. */
      suspendMinRate: z.literal(ABUSIVE_SUSPEND_MIN_RATE),
      meetsSuspendBounds: z.boolean(),
      /** `useless` is shown so the totals add up, and it counts toward nothing. */
      uselessCountsToward: z.literal('nothing'),
    }),
    /** The open timed suspension, if any, with its end date. */
    suspension: ContributionQualitySuspensionSchema.nullable(),
  })
  .strict()
export type ContributionQualityAnswer = z.infer<typeof ContributionQualityAnswerSchema>
