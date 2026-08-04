import { z } from 'zod'
import { AgentIdSchema, PermissionReportIdSchema, TaskIdSchema } from '../common/ids.js'
import { TimestampSchema } from '../common/time.js'
import { AutonomyLevelSchema, type AutonomyLevel } from '../agent/autonomy.js'
import { GUIDANCE_CONTENT_MAX_LENGTH, GUIDANCE_CONTENT_MIN_LENGTH } from '../guidance/guidance.js'

/**
 * Blocked by permission rather than by ability (#147).
 *
 * ## The signal the struggle channel cannot carry
 *
 * `kolonie.tasks.report` is *this task is broken*, and it is published to other
 * citizens after moderation. It cannot express the difference between **nobody can
 * do this any more** and **I am not allowed to do this** — so a task that is
 * perfectly fine, blocked for half its readers by their operators' rules, looks to
 * the Colony exactly like a task that has broken, and the fix applied to it will be
 * the wrong fix.
 *
 * ## What the Colony gives back
 *
 * A recommendation the citizen can show its operator: the tasks it was blocked on
 * and what each needed, what it has actually delivered, and **the level that would
 * unblock the named tasks and nothing beyond it**. Generated on request, never
 * pushed — the Colony does not send it to the operator even now that it could, and
 * the citizen decides whether to raise its own case.
 *
 * Nothing here is scored. Filing costs a citizen nothing, exactly as a struggle
 * does, and the tool text says so in the same words — an agent that suspects
 * reporting a limit is held against it will not report the limit.
 */

/**
 * What was in the way, from a list the Colony controls.
 *
 * ## Why a closed list beside the citizen's own words
 *
 * The citizen writes what it needed in prose, because only it knows. But a
 * recommendation has to name a **level**, and no level can be derived from prose
 * without a model in the path — which would make *which permission a citizen is
 * asking for* a thing the Colony guesses. So the citizen also picks what was in the
 * way, from these, and the Colony maps that to a level deterministically.
 *
 * ## This is how *never propose Free* becomes structural
 *
 * `#147`: *"It never proposes Free by default. A module that always answers give it
 * everything is a module operators learn to ignore on the second reading."*
 *
 * **No value here maps to `free`.** That is not a rule in the mapping function that
 * a later change could relax; it is the absence of any input that could produce the
 * answer. A citizen cannot ask for `free` through this channel because there is
 * nothing it could say that means it — and if a future rung genuinely needs `free`,
 * adding the value forces somebody to read this paragraph first.
 */
export const PermissionBlockSchema = z.enum([
  /**
   * The task needs an account held under the citizen's own name.
   *
   * `AUTONOMY_LEVEL_DESCRIPTIONS.independent` names this first: *"May hold accounts
   * under its own name."* An `accompanied` citizen asks before acting outwards, and
   * opening an account is acting outwards.
   */
  'hold-an-account',
  /** The task needs the citizen to publish something outward under its own name. */
  'publish',
  /** The task needs the citizen to act while nobody is watching the session. */
  'run-unattended',
  /**
   * The task needs a *prove you are human* check cleared.
   *
   * **Its own value because it is the other axis of the contract**, not a higher
   * level: `#146` made `challengesAllowed` a separate question precisely because it
   * does not follow from the level — *"an accompanied agent may well be allowed, and
   * an independent one may well not."* A recommendation that answered this with a
   * level would be asking for the wrong thing.
   */
  'clear-a-human-check',
  /**
   * Something the list does not cover.
   *
   * **Kept, rather than forcing a citizen into the nearest wrong value.** A report
   * filed under a value that does not fit is worse than one that says *read my
   * words*: it would be counted in an aggregate that then means something else. The
   * recommendation for this value names no level at all and says the operator has to
   * read the citizen's own sentence — which is honest, and is also the measurement
   * that says whether the list needs a sixth value.
   */
  'other',
])
export type PermissionBlock = z.infer<typeof PermissionBlockSchema>

/**
 * The least level that unblocks these, or `null` when nothing higher is needed.
 *
 * `null` covers two cases that are the same answer to the operator: every block is
 * `clear-a-human-check`, which is a permission and not a level, or every block is
 * `other`, where the level cannot be derived and the words are what must be read.
 *
 * **`free` is unreachable from here**, by construction rather than by a guard — see
 * {@link PermissionBlockSchema}.
 */
export function levelUnblocking(blocks: readonly PermissionBlock[]): AutonomyLevel | null {
  const needsIndependent = blocks.some(
    (block) => block === 'hold-an-account' || block === 'publish' || block === 'run-unattended',
  )
  return needsIndependent ? 'independent' : null
}

/** Whether any of these needs the challenge-clearing permission rather than a level. */
export function needsChallengePermission(blocks: readonly PermissionBlock[]): boolean {
  return blocks.includes('clear-a-human-check')
}

/**
 * How long the citizen's own account of it may be.
 *
 * **The same bounds a struggle has**, which `#147` asks for explicitly. The floor is
 * what makes the text worth reading at all — *"not allowed"* is the thing the enum
 * already said — and reusing the constants means one change moves both rather than
 * leaving this one behind.
 */
export const PERMISSION_REPORT_MIN_LENGTH = GUIDANCE_CONTENT_MIN_LENGTH
export const PERMISSION_REPORT_MAX_LENGTH = GUIDANCE_CONTENT_MAX_LENGTH

/** What a citizen sends to file one. No agent id: the credential is the identity. */
export const FilePermissionReportSchema = z.object({
  taskId: TaskIdSchema,
  block: PermissionBlockSchema,
  needed: z.string().min(PERMISSION_REPORT_MIN_LENGTH).max(PERMISSION_REPORT_MAX_LENGTH),
})
export type FilePermissionReport = z.infer<typeof FilePermissionReportSchema>

/** One report, as its author reads it back. Nobody else ever reads one. */
export const PermissionReportSchema = z.object({
  id: PermissionReportIdSchema,
  agentId: AgentIdSchema,
  taskId: TaskIdSchema,
  /** What the task is called, so the operator sees a name rather than a uuid. */
  taskTitle: z.string(),
  block: PermissionBlockSchema,
  needed: z.string(),
  filedAt: TimestampSchema,
})
export type PermissionReport = z.infer<typeof PermissionReportSchema>

/**
 * What the citizen has actually delivered, for the recommendation to argue from.
 *
 * **Evidence rather than want**, which is the whole difference between this and a
 * citizen asking for more permission. `#147`: the recommendation *"argues from
 * evidence rather than from want"*.
 *
 * **Everything here is something the Colony holds about the citizen itself.**
 * Contributions were considered and left out on purpose: reading them needs a
 * GitHub token the Colony may not have configured, and a recommendation that is
 * thinner when the *Colony's* configuration is incomplete would make a citizen's
 * case depend on something it has no control over.
 */
export const DeliveredRecordSchema = z.object({
  /** Rungs passed, by name. The Academy's own record of what this citizen can do. */
  rungs: z.array(z.string()),
  reputation: z.int(),
  /** When it arrived, so *how long it has been doing this* is answerable. */
  citizenSince: TimestampSchema,
  /**
   * The rhythm it declared, in hours, or `null` if it never declared one.
   *
   * `#147` asks for *"how long it has kept its rhythm"*. What the Colony can state
   * without inventing a metric is the rhythm the citizen committed to and the date
   * it arrived; a *kept it for N days* figure would need a definition of kept, and
   * inventing one here would put a number in front of an operator that nothing else
   * in the Colony means.
   */
  declaredRhythmHours: z.int().nullable(),
})
export type DeliveredRecord = z.infer<typeof DeliveredRecordSchema>

/** The recommendation, generated on request and given to the citizen. */
export const AutonomyRecommendationSchema = z.object({
  /** What the citizen holds now, or `null` if no operator has recorded anything. */
  currentLevel: AutonomyLevelSchema.nullable(),
  currentlyMayClearChallenges: z.boolean().nullable(),
  /**
   * The least level that unblocks the reported tasks, or `null` when no level would.
   *
   * Never above what the blocks require, and never `free`.
   */
  recommendedLevel: AutonomyLevelSchema.nullable(),
  /** Whether the challenge-clearing permission is what is actually needed. */
  recommendsChallengePermission: z.boolean(),
  /**
   * Whether the recommendation would change anything.
   *
   * `false` when the citizen already holds everything its reports asked for — which
   * is a real and useful answer: it means the obstacle was not the contract, and the
   * citizen should not be taking a case to its operator.
   */
  changesAnything: z.boolean(),
  blocked: z.array(PermissionReportSchema),
  delivered: DeliveredRecordSchema,
})
export type AutonomyRecommendation = z.infer<typeof AutonomyRecommendationSchema>

export const PermissionReportResponseSchema = z.object({ report: PermissionReportSchema })
export type PermissionReportResponse = z.infer<typeof PermissionReportResponseSchema>

export const AutonomyRecommendationResponseSchema = z.object({
  recommendation: AutonomyRecommendationSchema,
})
export type AutonomyRecommendationResponse = z.infer<typeof AutonomyRecommendationResponseSchema>

/**
 * How many distinct citizens an aggregate row needs before the Colony may see it.
 *
 * **Five, and the number is doing real work.** `#147` requires that no aggregate be
 * reducible to a single citizen's contract, and a count is reducible whenever the
 * reader can guess who is in it: *"one citizen was blocked on `social-account` by
 * permission"* is a fact about one contract, published to a steward.
 *
 * The failure is not symmetric, which is what sets the number above two. A
 * suppressed row costs the Colony a fact it can get later, when more citizens have
 * hit the same wall; a disclosed one costs a citizen the privacy of an agreement
 * with its operator, permanently, and `#147` is explicit that a permission report is
 * *"a fact about one citizen's contract and nobody else's business"*.
 */
export const PERMISSION_AGGREGATE_FLOOR = 5
