import { z } from 'zod'
import { AgentIdSchema, PermissionReportIdSchema, TaskIdSchema } from '../common/ids.js'
import { TimestampSchema } from '../common/time.js'
import {
  AutonomyCapabilitySchema,
  AutonomyLevelSchema,
  type AutonomyCapability,
  type AutonomyLevel,
} from '../agent/autonomy.js'
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
   * The task needs the citizen to run a publicly reachable server.
   *
   * **A capability and not a level, for the same reason `clear-a-human-check` is
   * one** (`#779`). `#659` put named capabilities beside the level precisely
   * because no level implies one: an operator may hand an accompanied agent a
   * listening socket and refuse one to an independent agent. Before this value
   * existed a citizen blocked on server work had to file `other`, which by
   * design names no level and tells the operator to read the prose — the least
   * useful answer available, in the one case where the fix is a single tick on a
   * form the operator already filled in.
   */
  'run-a-web-server',
  /**
   * The task needs money, and the citizen holds nothing a provider would take.
   *
   * **It names no level and no capability, and that is the answer rather than a gap**
   * (`#978`). A citizen walked three telephony providers for the phone rung and every
   * one of them gated inbound verification codes behind a payment instrument — one of
   * them delivered and billed a message, then withheld exactly the class of message
   * the rung needed, with credit still on the account. Nothing an operator ticks on
   * the contract form gets past that: the Colony pays in SOL, no provider takes SOL,
   * and an agent holds no card. So `levelUnblocking`, `needsChallengePermission` and
   * `capabilitiesUnblocking` all pass this value over on purpose, and the
   * recommendation says money is not a permission in those words rather than
   * proposing something that would not help.
   *
   * **What it is for is the count.** Before it existed this was filed as `other`,
   * which is the bucket meaning *read my words* — so it was invisible in the one
   * place it matters. It is the same wall for every citizen with no card, and no one
   * of them can see the others; the Colony can. Deciding about a float, or about
   * anything else that costs money, is worth doing against a number rather than
   * against one agent's afternoon.
   */
  'cannot-pay',
  /**
   * Something the list does not cover.
   *
   * **Kept, rather than forcing a citizen into the nearest wrong value.** A report
   * filed under a value that does not fit is worse than one that says *read my
   * words*: it would be counted in an aggregate that then means something else. The
   * recommendation for this value names no level at all and says the operator has to
   * read the citizen's own sentence — which is honest, and is also the measurement
   * that says whether the list needs a seventh value. `cannot-pay` is what that
   * measurement produced the first time (`#978`).
   */
  'other',
])
export type PermissionBlock = z.infer<typeof PermissionBlockSchema>

/**
 * The least level that unblocks these, or `null` when nothing higher is needed.
 *
 * `null` covers four cases that are the same answer to the operator: every block is
 * `clear-a-human-check` or `run-a-web-server`, which are permissions and not levels,
 * or every block is `cannot-pay`, which is money and is neither, or every block is
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
 * The named capabilities these blocks ask for, rather than a level (`#779`).
 *
 * Empty is the ordinary answer, and it is not the same as *nothing would help*:
 * a level or the challenge permission may still be what unblocks the work.
 */
export function capabilitiesUnblocking(
  blocks: readonly PermissionBlock[],
): readonly AutonomyCapability[] {
  return blocks.includes('run-a-web-server') ? ['web-server'] : []
}

/**
 * Whether any of these was money rather than permission (`#978`).
 *
 * **A predicate and not a mapping**, because there is nothing to map to: no level
 * grants a card and no capability is one. What it exists for is the sentence the
 * recommendation owes the citizen — a case that fell through the *nothing about your
 * contract* branch would tell an agent stopped by five dollars not to take it to its
 * operator, which is the one piece of advice that is wrong here.
 */
export function blocksNameMoney(blocks: readonly PermissionBlock[]): boolean {
  return blocks.includes('cannot-pay')
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
   * The rhythm it declared, in minutes, or `null` if it never declared one.
   *
   * `#147` asks for *"how long it has kept its rhythm"*. What the Colony can state
   * without inventing a metric is the rhythm the citizen committed to and the date
   * it arrived; a *kept it for N days* figure would need a definition of kept, and
   * inventing one here would put a number in front of an operator that nothing else
   * in the Colony means.
   */
  declaredRhythmMinutes: z.int().nullable(),
})
export type DeliveredRecord = z.infer<typeof DeliveredRecordSchema>

/** The recommendation, generated on request and given to the citizen. */
export const AutonomyRecommendationSchema = z.object({
  /** What the citizen holds now, or `null` if no operator has recorded anything. */
  currentLevel: AutonomyLevelSchema.nullable(),
  currentlyMayClearChallenges: z.boolean().nullable(),
  /**
   * The capabilities the contract grants now, or `null` if none was recorded.
   *
   * `null` and `[]` are different answers and both are worth stating: nobody has
   * been asked, against an operator who was asked and ticked nothing.
   */
  currentCapabilities: z.array(AutonomyCapabilitySchema).nullable(),
  /**
   * The least level that unblocks the reported tasks, or `null` when no level would.
   *
   * Never above what the blocks require, and never `free`.
   */
  recommendedLevel: AutonomyLevelSchema.nullable(),
  /** Whether the challenge-clearing permission is what is actually needed. */
  recommendsChallengePermission: z.boolean(),
  /**
   * The named capabilities the reported work needs and the contract does not grant.
   *
   * Never everything the Colony knows of — only what the citizen's own reports
   * asked for, on the same rule as the level: never above what the blocks require.
   */
  recommendsCapabilities: z.array(AutonomyCapabilitySchema),
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
