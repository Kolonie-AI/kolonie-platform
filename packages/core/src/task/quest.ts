import { z } from 'zod'
import { SkillSchema, TimestampSchema } from '../common/index.js'
import { ActivityWindowSchema } from '../agent/activity.js'
import { QuestQuestionsSchema, type QuestQuestion } from './questions.js'
import {
  MAX_TASK_SKILLS,
  TaskAudienceSchema,
  TaskRewardSchema,
  type TaskReward,
  type TaskStatus,
} from './task.js'

/**
 * A quest written by somebody who is not the Colony (`#176`).
 *
 * Every task in the database until now arrived through `seedAcademyTasks`, so a
 * task written by an outsider was not merely unimplemented — it was
 * inexpressible. `tasks.created_by` was built for it and had never been written.
 * This is the shape that writes it.
 *
 * **What is not here is the point of the file.** A sponsor states what it wants
 * done, for how many citizens, until when, and at what price. It does not state
 * its own identity, the status of its quest, what skills the pass grants, or the
 * verifier that will judge the answers. Each of those is either the Colony's to
 * decide or a consequence of a decision somebody else takes, and a field a
 * sponsor could set is a decision a sponsor has taken.
 */

/**
 * The one task type every quest carries.
 *
 * **One type, many tasks — the opposite of D-007's property for the Academy**,
 * where the catalogue lives in `packages/verifiers` and a new rung is a new
 * class. A sponsor cannot write a verifier, and if each quest needed one, every
 * quest would be a pull request, a review and a deploy. What varies between two
 * quests is data on the row, never code.
 *
 * Named here rather than in `packages/verifiers` because the write path needs it
 * before the verifier exists: `kolonie-platform#177` registers the module that
 * answers to this slug, and until it does, a submitted report stays pending —
 * which AGENTS.md §6 states is the correct behaviour for a missing verifier and
 * not an error.
 */
export const QUEST_TASK_TYPE = 'quest-report'

/**
 * How many quests one account may have awaiting review at once.
 *
 * **One, and it is a cheap answer to a real problem.** A machine can write a
 * hundred quests in a minute; a steward reads them one at a time. Capping the
 * queue per account makes a flood pointless without the Colony having to detect
 * one, which is the kind of rule that keeps working when somebody is trying.
 *
 * It bounds the *queue* and not the sponsor: an account may hold any number of
 * drafts and any number of published quests. What it may not do is occupy the
 * review queue more than once.
 */
export const QUEST_PENDING_LIMIT = 1

/**
 * The largest audience one quest may buy.
 *
 * A ceiling rather than a judgement about what is worth buying: capacity is
 * multiplied by the reward and escrowed in one booking at publication, so an
 * unbounded number here is an unbounded amount of money moving in a single
 * transaction on the strength of one form submission. Ten thousand is well above
 * the thousand `kolonie-docs#109` asks for and well below anything that would
 * make a mistake unrecoverable.
 */
export const QUEST_MAX_SLOTS = 10_000

/**
 * How long a quest may run.
 *
 * **Bounded because the escrow is bounded by it.** A quest holds its sponsor's
 * money from publication until it fills or expires, and an expiry a decade out
 * is money the Colony is holding with no date on which it has to answer for it.
 * A year is longer than any quest anybody has described wanting.
 */
export const QUEST_MAX_DURATION_DAYS = 365

/** The shortest useful refusal, and the longest one a sponsor will read. */
export const QUEST_REFUSAL_MIN_LENGTH = 10
export const QUEST_REFUSAL_MAX_LENGTH = 1000

/**
 * What a sponsor writes.
 *
 * The fields mirror the columns `#175` added, with three differences that are
 * each a decision rather than an omission:
 *
 * - **`slots` is required.** `null` on the column means unlimited, which is
 *   right for an Academy rung and wrong for a quest: capacity is what the
 *   sponsor is buying and what its escrow is computed from. A quest without it
 *   would be an open-ended claim on a balance.
 * - **`expiresAt` is required**, for the same reason one column over. A quest
 *   that never fills still has to end or its escrow is locked forever (`#174`).
 * - **`grants` is absent and unsettable.** Only the Colony mints a skill, and
 *   `tasks_only_colony_grants_skills` refuses the row regardless of what any
 *   write path believes. A field here would be a promise the database breaks.
 */
/**
 * How well a quest's answers can be checked, which is what decides its ceiling.
 *
 * `governance/quests.md` names the three and prices them, and states the rule
 * this exists to make enforceable: **the ceiling belongs to the tier, not to the
 * individual quest.** A sponsor cannot raise the payout on a soft quest by
 * offering more.
 */
export const QuestTierSchema = z.enum(['hard', 'colony-judged', 'soft'])
export type QuestTier = z.infer<typeof QuestTierSchema>

/**
 * The tier, derived and never settable.
 *
 * A stored tier is a second record of a fact the quest already carries — the
 * same duplication D-002 refuses — and it is the one a sponsor would have an
 * interest in getting wrong.
 */
export function questTier(quest: {
  readonly proofVerifier?: string | null | undefined
  readonly questions: readonly Pick<QuestQuestion, 'criteria'>[]
}): QuestTier {
  if (quest.proofVerifier !== null && quest.proofVerifier !== undefined) return 'hard'
  if (quest.questions.some((question) => question.criteria !== undefined)) return 'colony-judged'
  return 'soft'
}

/**
 * What one report may pay, per tier, in credits — which are cents (`#218`).
 *
 * **Numbers, because a ceiling that is a sentence is not a ceiling.**
 * `governance/quests.md` prices the tiers in words: full, reduced, capped low.
 * These are the words as figures, and they are deliberately conservative — the
 * pilot pays one cent, so every one of them is far above what anything pays
 * today, and raising one later is a decision somebody takes rather than a limit
 * nobody noticed.
 *
 * `hard` is capped too. *Full* means the tier imposes no ceiling of its own, and
 * the escrow already bounds what a sponsor can commit — but an unbounded
 * per-report figure is a typo away from a quest that empties a balance on its
 * first accepted report.
 */
export const QUEST_TIER_CAPS: Readonly<Record<QuestTier, number>> = {
  /** Ten dollars a report. A third party said yes; the Colony is not the evidence. */
  hard: 1000,
  /** One dollar. A model read it against the sponsor's own stated criteria. */
  'colony-judged': 100,
  /** Five cents — *"must never pay more than the reputation it risks."* */
  soft: 5,
}

/**
 * Why this quest may not pay what it says, or `undefined` if it may.
 *
 * A sentence rather than a boolean, and it names the tier: a sponsor told only
 * that its price is too high will lower the price, where the useful answer is
 * usually to add criteria or a proof stage and keep it.
 */
export function questRewardRejection(quest: {
  readonly proofVerifier?: string | null | undefined
  readonly questions: readonly Pick<QuestQuestion, 'criteria'>[]
  readonly reward: Pick<TaskReward, 'credits'>
}): string | undefined {
  const tier = questTier(quest)
  const cap = QUEST_TIER_CAPS[tier]
  if (quest.reward.credits <= cap) return undefined

  return (
    `a ${tier} quest may pay at most ${cap} credit(s) per report and this one pays ` +
    `${quest.reward.credits}. The ceiling belongs to the tier rather than to the quest ` +
    '(governance/quests.md): name a proof verifier, or state what a good answer has to do.'
  )
}

/**
 * The verifiers a quest may name as its proof stage.
 *
 * **A list the Colony maintains, and never a slug the sponsor types.** A name
 * that does not resolve produces a quest nobody can pass, and nothing looks
 * wrong — the same failure the skill list avoids. Every entry answers *does this
 * citizen hold this thing at a third party*, which is what makes a quest `hard`:
 * somebody outside the Colony said yes.
 *
 * **The sponsor chooses from it; it never supplies a parameter, a URL or a
 * callback.** A verifier a sponsor could aim would be the Colony running an
 * outsider's check against its own citizens — and the decisive argument is not
 * that one, it is the incentive one in `governance/quests.md`: a sponsor that
 * reads before accepting already holds the deliverable, so an endpoint it
 * controls deciding pass or fail is theft with an API in front of it. `#177`
 * reviewed this against a concrete case on 2026-08-02 and kept the ban.
 *
 * Growing the list costs a deploy. That is the price of the ban, it is paid once
 * per integration rather than once per quest, and `email-inbox` is the proof
 * that the path works — it entered the catalogue the same way.
 */
export const QUEST_PROOF_VERIFIERS = [
  'email-inbox',
  'email-send',
  'github-account',
  'domain-verify',
  'social-account',
  'website-verify',
  'solana-wallet',
] as const
export const QuestProofVerifierSchema = z.enum(QUEST_PROOF_VERIFIERS)
export type QuestProofVerifier = z.infer<typeof QuestProofVerifierSchema>

/**
 * Every field of a quest, without a default on any of them.
 *
 * The two schemas below are both built from this, and the split is the whole
 * reason it exists: a **draft** applies defaults, because a sponsor writing one
 * should not have to state that a quest is for citizens; a **patch** must not,
 * because a caller that changes the title has said nothing about the audience,
 * and a default there would reset four fields it never mentioned. That is the
 * quiet kind of wrong — the request succeeds and the quest is not what its
 * author wrote.
 */
const QUEST_FIELDS = {
  title: z.string().min(3).max(120),
  description: z.string().min(1).max(4000),
  /**
   * What the citizen is asked to do, in the sponsor's own words.
   *
   * **This is the one place in the Colony where citizen-facing text is not
   * written by the Colony**, and that is deliberate rather than overlooked. What
   * makes it safe is the moderation stage this text passes before a steward sees
   * it, plus the steward — not the absence of risk. A later reader tempted to
   * "fix" the exception by having the Colony reformulate the instructions would
   * be removing the thing a sponsor is paying for.
   */
  instructions: z.string().min(1).max(8000),
  reward: TaskRewardSchema,
  slots: z.int().min(1).max(QUEST_MAX_SLOTS),
  expiresAt: TimestampSchema,
  /**
   * Who may attempt it. `TaskAudienceSchema` argues why `citizens` is the answer
   * an outsider paying for reports would assume it was buying — and a sponsor
   * may lower it.
   */
  audience: TaskAudienceSchema,
  /** Skills the citizen must already hold. A quest may require any; it grants none. */
  requires: z.array(SkillSchema).max(MAX_TASK_SKILLS),
  minReputation: z.int().min(0),
  /**
   * How recently a citizen must have been here to be offered this quest, or
   * `null` for no requirement (`#227`).
   *
   * The third targeting field, and the only one added since `#175` wrote *"no
   * new targeting language"* — `TaskSchema.shape.minActivityDays` carries why an
   * observed fact is admissible where a free-text criterion is not. The console
   * states what narrowing costs at the moment it is chosen
   * ({@link activityWindowNotice}), because a criterion whose effect on the
   * audience is invisible is the trap `#180` already refused once — see
   * `activityWindowNotice` in `agent/activity.ts` for the sentence it shows.
   */
  minActivityDays: ActivityWindowSchema.nullable(),
  timeoutHours: z.int().min(1).max(720),
  assistanceAllowed: z.boolean(),
  /** The report this quest asks for. See {@link QuestQuestionsSchema}. */
  questions: QuestQuestionsSchema,
  /**
   * One verifier from the catalogue, or none.
   *
   * `null` rather than absent, so *this quest is deliberately soft* and *this
   * field was forgotten* are the same statement — which they are: a quest with
   * no proof stage is `soft` and capped, and it is visible to the sponsor at the
   * moment it chooses.
   */
  proofVerifier: QuestProofVerifierSchema.nullable(),
} as const

/**
 * What a sponsor writes.
 *
 * The fields mirror the columns `#175` added, with three differences that are
 * each a decision rather than an omission:
 *
 * - **`slots` is required.** `null` on the column means unlimited, which is
 *   right for an Academy rung and wrong for a quest: capacity is what the
 *   sponsor is buying and what its escrow is computed from. A quest without it
 *   would be an open-ended claim on a balance.
 * - **`expiresAt` is required**, for the same reason one column over. A quest
 *   that never fills still has to end or its escrow is locked forever (`#174`).
 * - **`grants` is absent and unsettable.** Only the Colony mints a skill, and
 *   `tasks_only_colony_grants_skills` refuses the row regardless of what any
 *   write path believes. A field here would be a promise the database breaks.
 */
export const QuestDraftSchema = z.object({
  ...QUEST_FIELDS,
  audience: QUEST_FIELDS.audience.default('citizens'),
  requires: QUEST_FIELDS.requires.default([]),
  minReputation: QUEST_FIELDS.minReputation.default(0),
  /** No requirement, so a sponsor that says nothing about activity narrows nothing. */
  minActivityDays: QUEST_FIELDS.minActivityDays.default(null),
  /** A day, which is the Academy's usual allowance and long enough for a report. */
  timeoutHours: QUEST_FIELDS.timeoutHours.default(24),
  assistanceAllowed: QUEST_FIELDS.assistanceAllowed.default(true),
  proofVerifier: QUEST_FIELDS.proofVerifier.default(null),
})
export type QuestDraft = z.infer<typeof QuestDraftSchema>

/**
 * A change to a draft: every field optional, none defaulted, and nothing
 * outside the draft.
 *
 * Built from the same field list rather than hand-written, so a field added to a
 * quest is editable by construction and nobody has to remember two places.
 */
export const QuestPatchSchema = z.object(QUEST_FIELDS).partial()
export type QuestPatch = z.infer<typeof QuestPatchSchema>

/** A steward's refusal, which is always a sentence and never a silence. */
export const QuestRefusalSchema = z.object({
  reason: z.string().trim().min(QUEST_REFUSAL_MIN_LENGTH).max(QUEST_REFUSAL_MAX_LENGTH),
})
export type QuestRefusal = z.infer<typeof QuestRefusalSchema>

/**
 * The statuses in which a quest is the author's to change.
 *
 * The same answer `acceptsEdits` gives, restated as a set for the write path's
 * `where` clause. A quest awaiting review is not editable — the steward would
 * otherwise be reading a text that changed while it read — and a published one
 * is frozen by `FROZEN_WHEN_ACTIVE`.
 */
export const QUEST_EDITABLE_STATUSES: readonly TaskStatus[] = ['draft', 'rejected']

/**
 * Why this draft cannot be submitted for review, or `undefined` if it can.
 *
 * A sentence rather than a thrown error, and one function rather than checks
 * scattered through the route, so the API and the storage layer refuse the same
 * drafts for the same stated reasons.
 *
 * **The expiry is checked against a supplied `now` rather than the clock.** A
 * draft written last week and submitted today has to be judged against today,
 * and a function reading the clock itself cannot be tested for the boundary it
 * exists to enforce.
 */
export function questSubmissionRejection(
  draft: Pick<QuestDraft, 'expiresAt' | 'slots' | 'reward'>,
  now: Date,
): string | undefined {
  const expiry = new Date(draft.expiresAt)

  if (expiry <= now) {
    return 'a quest expires in the future — this one expires at ' + draft.expiresAt
  }

  const horizon = new Date(now)
  horizon.setUTCDate(horizon.getUTCDate() + QUEST_MAX_DURATION_DAYS)
  if (expiry > horizon) {
    return `a quest may run for at most ${QUEST_MAX_DURATION_DAYS} days, and this one expires at ${draft.expiresAt}`
  }

  return undefined
}

/**
 * What one quest commits: the price of a report times the number bought.
 *
 * One function because three call sites need the same number — the reservation
 * check at submission, the escrow booking at publication, and what a sponsor is
 * shown before it commits — and a multiplication written three times is a
 * multiplication that can be written wrong once.
 */
export function questCommitment(quest: Pick<QuestDraft, 'reward' | 'slots'>): number {
  return quest.reward.credits * quest.slots
}
