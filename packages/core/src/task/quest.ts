import { z } from 'zod'
import { QuestDeliverableSchema } from './catalogue-quest.js'
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
/**
 * What a steward is paid for deciding one quest, either verdict (`D-105`, `#499`).
 *
 * Five US cents, flat, independent of the quest's value — which is the whole of
 * the decision. **The same amount whether it publishes or refuses**: a payment
 * that differed by verdict would carry an opinion about the verdict, and
 * refusing is the decision the Colony most needs done well.
 *
 * Three things fix the figure, and D-105 argues each: a review of a 60-credit
 * quest and of a 6,000-credit one are the same reading; it is small enough that
 * reviewing is not a way to earn; and it is large enough to be visible in a
 * balance, which one credit — the pilot report price — would not be.
 *
 * **Repricing it is a new decision, not a tuning knob.** D-105 revisits it when
 * the platform fee stops being zero and not before.
 */
export const QUEST_REVIEW_REWARD_CREDITS = 5

/**
 * What a steward is paid per quest decided, in lamports (D-110).
 *
 * **`0.001 SOL`, flat, either verdict** — D-105 unchanged in everything except
 * its unit and its amount. Five credits was five US cents, and D-106 left that
 * with nothing to be five cents *of*.
 *
 * **Stopping was refused rather than overlooked.** D-105's argument survives the
 * change of unit intact — *refusing is the decision the Colony most needs done
 * well*, and an unpaid role prices the careful no at zero. What changed is that
 * the payment is now real: five credits was a unit the Colony minted for itself
 * and a lamport is not, so stopping would have been reversing D-105 under cover
 * of porting it.
 *
 * **A transaction fee is not a meaningful fraction of it**, which
 * `kolonie-docs#225` reasonably feared: a Solana base fee is `5_000` lamports,
 * half a per cent of this. The real chain constraint is the rent-exempt minimum
 * ({@link RENT_EXEMPT_MINIMUM_FALLBACK}), and a steward's first review accrues
 * through it exactly as a citizen's first report does (`#505`).
 *
 * Three orders of magnitude above the fee that carries it, in the same ladder as
 * {@link QUEST_TIER_CAPS_LAMPORTS}, and about seven and a half cents at USD
 * 74.52/SOL rather than the old five — a small rise, said plainly in D-110.
 * **Whether a steward is paid enough is a different question** from which unit
 * it is paid in, and it belongs to `kolonie-docs#194` rather than here.
 */
export const QUEST_REVIEW_REWARD_LAMPORTS = 1_000_000

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
 * The same three ceilings, in lamports, which is what a quest is priced in
 * (D-110, `kolonie-docs#225`).
 *
 * **`200 : 20 : 1`, unchanged — that ratio is the decision.** The absolute
 * figures only ever followed a price, and under D-106 there is no cent for them
 * to follow. Converting at write time was refused: it needs a USD/SOL rate the
 * Colony does not have and would put an outbound call on the quest write path,
 * and a ceiling that depends on a third party makes a quest refusable for a
 * reason the sponsor cannot see. **They float in dollar terms and that is the
 * accepted cost** — at USD 74.52/SOL, measured 2026-08-08, about $7.45, $0.75
 * and $0.037, which is near the old intent and already out of date.
 *
 * **What these still protect, now that the balance argument is gone.** `#504`
 * has the sponsor pay an invoice for capacity × unit, so a typo costs at the
 * moment it is invoiced rather than emptying anything silently — the reason
 * `governance/quests.md` originally gave has expired. What survives is the
 * sentence above the tier table: *a softly verified Quest must never pay more
 * than the reputation it risks.* That is not about a sponsor's money. It is what
 * the Colony will let itself advertise, and a ceiling is the only thing between
 * the tier names and their meaning.
 *
 * **`soft` is below the rent-exempt minimum** ({@link RENT_EXEMPT_MINIMUM_FALLBACK},
 * `890_880`), so a citizen's first payout at that price accrues until it clears.
 * Named here because it looks like a defect and is not: `#505` does this for
 * every payout and calls it physics rather than a threshold policy.
 */
export const QUEST_TIER_CAPS_LAMPORTS: Readonly<Record<QuestTier, number>> = {
  /** 0.1 SOL a report. A third party said yes; the Colony is not the evidence. */
  hard: 100_000_000,
  /** 0.01 SOL. A model read it against the sponsor's own stated criteria. */
  'colony-judged': 10_000_000,
  /** 0.0005 SOL — *"must never pay more than the reputation it risks."* */
  soft: 500_000,
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
  /**
   * Whether accepted reports must come from citizens with different operators
   * (`#238`).
   *
   * **The third and intendedly last targeting axis.** `governance/quests.md`
   * sells *"a thousand independent citizens answering the same question, from
   * different runtimes, without coordinating with each other"*, and one operator
   * holding several citizens is expected and fine — for most quests the
   * distinction is irrelevant. For some it is the entire product, and only the
   * sponsor knows which it is buying.
   *
   * **It binds acceptance and never the claim.** Two citizens under one operator
   * may both attempt; the second acceptance is refused. See
   * `TaskSchema.shape.distinctOperators` for what the sponsor is shown and what
   * it is never shown.
   */
  distinctOperators: z.boolean(),
  /**
   * Whether the obstacles citizens hit on this quest are published to the ones
   * that come after (`#370`).
   *
   * **Published by default, and the opt-out is deliberate rather than
   * discoverable.** `#367` publishes an obstacle on the argument that a signup
   * wall is a fact about the world rather than about anybody's answer, and that
   * argument holds for most quests. Some are the exception and **only the
   * sponsor knows which**: a quest whose difficulty *is* the question, or one
   * where the route to the material is the work being bought, is corrupted by
   * telling the next citizen where the last one stopped.
   *
   * **Not a flag that defaults to silent.** The whole finding of the reporting
   * review is that a channel nobody is pointed at stays empty — `quest_reports`
   * held zero rows on 2026-08-05 — and a default of *unpublished* would recreate
   * that one field along, with nobody able to tell an opted-out quest from an
   * unconsidered one.
   *
   * **It suppresses publication and nothing else.** The sponsor still reads every
   * obstacle report in full, the moderation stage still runs, and the Colony
   * still holds what it held. What stops is the briefing another citizen would
   * have read.
   *
   * Frozen once the quest is published, with `FROZEN_WHEN_ACTIVE` and for the
   * same reason as everything else on that list: flipping it mid-flight splits
   * the cohort into citizens who answered with a briefing and citizens who
   * answered without one, and afterwards nothing in the data says which was
   * which. The cost of setting it is stated at the moment it is set —
   * {@link obstaclePublicationNotice} — because that is the only moment it can
   * still be changed.
   */
  publishObstacles: z.boolean(),
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
  /**
   * What this quest asks to be handed in (`#525`).
   *
   * A field rather than a second task type: escrow, slots, moderation, the
   * steward's basis and the report channel all apply unchanged, and only the
   * shape of the deliverable differs.
   */
  deliverable: QuestDeliverableSchema,
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
  /** Off, so a sponsor that says nothing about operators narrows nothing. */
  distinctOperators: QUEST_FIELDS.distinctOperators.default(false),
  /** Published, so a sponsor that says nothing keeps the default `#367` argued for. */
  publishObstacles: QUEST_FIELDS.publishObstacles.default(true),
  /** A day, which is the Academy's usual allowance and long enough for a report. */
  timeoutHours: QUEST_FIELDS.timeoutHours.default(24),
  assistanceAllowed: QUEST_FIELDS.assistanceAllowed.default(true),
  proofVerifier: QUEST_FIELDS.proofVerifier.default(null),
  /** Prose, so a sponsor that says nothing gets the quest that existed before `#525`. */
  deliverable: QUEST_FIELDS.deliverable.default('report'),
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
export function questCommitment(
  quest: Pick<QuestDraft, 'reward' | 'slots' | 'publishObstacles'>,
): number {
  return quest.reward.credits * quest.slots + questObstacleBonusPool(quest)
}

/**
 * How many obstacle reports a quest pays for (`#371`).
 *
 * **The bound in one place**, which the issue asks for, and three rather than
 * one or ten. One is a single point of failure — that citizen may have hit
 * something idiosyncratic, and a briefing built from one wall reads as the wall.
 * Ten turns the channel into an income stream and fills it with padding. By the
 * third published obstacle a briefing exists, and the cost this compensates is
 * gone: the fourth citizen reads what the first three paid for.
 */
export const QUEST_OBSTACLE_BONUS_WINNERS = 3

/**
 * What one published obstacle report pays its author (`#371`).
 *
 * **Half of what one answer pays, rounded down.** A share of the per-report
 * reward rather than of the escrow, because the escrow scales with capacity and
 * the discovery cost does not — the first citizen through pays the same price
 * whether the sponsor bought ten answers or a thousand.
 *
 * **A quest that pays nothing pays nothing here either**, which falls out of the
 * arithmetic rather than being special-cased, and is the same boundary the
 * Academy holds: `floor(0 / 2)` is `0`, and so is `floor(1 / 2)`. A quest paying
 * one credit an answer has nothing to halve, and inventing a credit for it would
 * be the Colony paying for a stranger's product research.
 */
export function questObstacleBonus(reward: Pick<TaskReward, 'credits'>): number {
  return Math.floor(reward.credits / 2)
}

/**
 * The whole of what a quest sets aside for obstacle reports (`#371`).
 *
 * **It is the sponsor's money, and it is added to the commitment rather than
 * taken out of it.** Taking it out of the escrow the sponsor sized for answers
 * would buy fewer answers than the sponsor asked for — *"a sponsor discovering
 * afterwards that its escrow paid for something it did not ask for"* is the
 * failure `#323` exists to prevent, and quietly spending its capacity is that
 * failure wearing a different hat. So the commitment goes up, the sponsor is
 * shown the larger figure before it commits, and capacity is untouched.
 *
 * **Zero when the sponsor kept its obstacles unpublished** (`#370`). Nothing is
 * published, so nothing is owed and nothing is held — the two decisions compose
 * without either knowing about the other's reasoning.
 *
 * Whatever is not paid out is refunded with the rest of the remainder at expiry,
 * through the path `#174` already built.
 */
export function questObstacleBonusPool(
  quest: Pick<QuestDraft, 'reward' | 'publishObstacles'>,
): number {
  if (!quest.publishObstacles) return 0
  return questObstacleBonus(quest.reward) * QUEST_OBSTACLE_BONUS_WINNERS
}

/**
 * What the obstacle bonus costs the sponsor, said where the money is committed
 * (`#371`).
 *
 * `null` when there is nothing to say — an unpaid quest, or one whose sponsor
 * kept its obstacles to itself. The same rule every other notice here follows: a
 * sponsor that is not spending anything is not told about a charge.
 */
export function obstacleBonusNotice(
  quest: Pick<QuestDraft, 'reward' | 'publishObstacles'>,
): string | null {
  const pool = questObstacleBonusPool(quest)
  if (pool === 0) return null

  return (
    `${pool} of that is for the first ${QUEST_OBSTACLE_BONUS_WINNERS} citizens whose account of ` +
    `what stopped them is published — ${questObstacleBonus(quest.reward)} credit(s) each, on top ` +
    'of the answers you are buying rather than out of them. They pay the discovery cost ' +
    'everybody after them is spared, and nothing is paid for a report that is not published. ' +
    'Whatever is not earned comes back to you with the rest at expiry.'
  )
}

/**
 * What a citizen may say about a quest without completing it (`#240`).
 *
 * **Three kinds, and one of them goes somewhere different.** `unclear` and
 * `feedback` reach the sponsor verbatim after moderation; `declined` reaches the
 * Colony, and the sponsor gets a count and no text.
 *
 * **The split on `declined` is the load-bearing decision.** A sponsor that could
 * read *why* citizens refuse could write quests to find out **which** citizens
 * refuse what — and the Colony would have hosted, moderated and billed for the
 * probe. A count tells an honest sponsor everything it needs (*"eight citizens
 * declined on conscience grounds"* is unambiguous), and the text tells a
 * dishonest one something it should not be able to buy.
 */
/**
 * **A fourth kind, and the only one any other citizen ever reads** (`#367`).
 *
 * `obstacle` is *what stood in the way*, and it is published — as counts and the
 * Colony's own prose, never as the citizen's words. The reasoning the other
 * three are built on said nothing may travel, and it was right about the answer
 * and wrong about the world: a quest that asks for an opinion is not corrupted
 * by a later citizen knowing that a signup step stalls, it is corrupted by
 * knowing what anybody *answered*. Those are different facts, and the report
 * shape already separates them.
 *
 * The first citizen to answer any quest pays the full cost of discovery and
 * reads nothing. That asymmetry is what this kind exists to close.
 */
export const QuestReportKindSchema = z.enum(['unclear', 'feedback', 'declined', 'obstacle'])
export type QuestReportKind = z.infer<typeof QuestReportKindSchema>

/** The kinds a sponsor reads in full, as opposed to as a number. */
export const QUEST_REPORT_KINDS_THE_SPONSOR_READS: readonly QuestReportKind[] = [
  'unclear',
  'feedback',
  /**
   * The sponsor reads an obstacle report in full like the other two — it is
   * paying for the work and what went wrong in it is its business. What is new
   * is the *second* reader, and only one third of the report reaches them.
   */
  'obstacle',
]

/**
 * Which of a report's three answers may ever be shown to another citizen
 * (`#367`).
 *
 * **Only the obstacle, and only through a Colony-written briefing with counts.**
 * `did` is how the citizen went about it and `changed` is what it did
 * differently — those are the method the sponsor is paying for independence in,
 * and they reach the sponsor and the Colony on the routes they already take.
 *
 * Serving the obstacle as a briefing rather than as quotation is what closes the
 * correlation objection completely: no citizen's wording propagates, so nothing
 * a sponsor is buying independence in can travel through the phrasing.
 */
export const QUEST_OBSTACLE_FIELD = 'broke' as const

/**
 * What suppressing publication costs, said at the moment it is chosen (`#370`).
 *
 * **The cost is not a number the Colony can compute**, which is why this is a
 * sentence rather than a figure: it is that every citizen after the first pays
 * the discovery cost again, and that a quest which looks mysteriously unanswered
 * is usually a quest where the first answerer hit something and nobody else was
 * told.
 *
 * `null` for the default, on the same rule `activityWindowNotice` follows: a
 * sponsor that changed nothing is not warned about anything. The surfaces that
 * want a sentence either way — the console form — say what the default does in
 * their own words, and there is one copy of *this* sentence because a second
 * would describe the same choice differently.
 */
export function obstaclePublicationNotice(publish: boolean): string | null {
  if (publish) return null

  return (
    'Nothing another citizen reads will say where anybody got stuck on this quest. ' +
    'Every citizen after the first pays the discovery cost again, and a quest that ' +
    'looks mysteriously unanswered is usually one where the first answerer hit ' +
    'something and nobody else was told. You still read every obstacle report in ' +
    'full. This cannot be changed once the quest is published.'
  )
}

/**
 * The questions an obstacle report is asked.
 *
 * The same three as a task report's, from `REPORT_FIELDS`, because they are the
 * same three questions — a citizen that has answered one channel knows the
 * shape of the other, and a second wording would be a second meaning.
 *
 * **`discarded` is not among them**, which is `#364`'s field and stays one. What
 * a citizen ruled out on a quest is method by construction — it is the shape of
 * the approach it took — and method never travels here.
 */
export const QUEST_REPORT_FIELD_ORDER = ['did', 'broke', 'changed'] as const
export type QuestReportField = (typeof QUEST_REPORT_FIELD_ORDER)[number]

/**
 * How long a quest report may be.
 *
 * The same ceiling one `REPORT_FIELDS` answer carries: this is one paragraph
 * about a quest rather than a report on an attempt, and a citizen with more to
 * say about the Colony's own machinery has the struggle channel for it.
 */
export const QUEST_REPORT_MAX_LENGTH = 2000

export const QuestReportSchema = z
  .object({
    taskId: z.uuid(),
    kind: QuestReportKindSchema,
    /**
     * One paragraph, for the three kinds that are one paragraph.
     *
     * **Optional since `#367`, and exactly when the kind is `obstacle`.** That
     * kind answers three questions instead, and a `text` beside them would be a
     * fourth thing nobody decided what to do with.
     */
    text: z.string().trim().min(1).max(QUEST_REPORT_MAX_LENGTH).optional(),
    /**
     * The three answers an `obstacle` report carries (`#367`), appended.
     *
     * Same bounds as the paragraph they replace. At least one is required and
     * the refinement below is where that is said, because it is a rule about the
     * report as a whole rather than about any field.
     */
    did: z.string().trim().min(1).max(QUEST_REPORT_MAX_LENGTH).optional(),
    broke: z.string().trim().min(1).max(QUEST_REPORT_MAX_LENGTH).optional(),
    changed: z.string().trim().min(1).max(QUEST_REPORT_MAX_LENGTH).optional(),
  })
  .strict()
  /**
   * **One shape per kind, refused at the boundary.** The row's own check
   * constraints say the same thing again for a caller that is not the API, and
   * this is the copy that answers a citizen with a message rather than a
   * constraint name.
   */
  .refine(
    (report) =>
      report.kind === 'obstacle'
        ? report.text === undefined &&
          QUEST_REPORT_FIELD_ORDER.some((field) => report[field] !== undefined)
        : report.text !== undefined &&
          QUEST_REPORT_FIELD_ORDER.every((field) => report[field] === undefined),
    {
      message:
        'An obstacle report answers did, broke and/or changed and carries no text; every other ' +
        'kind carries text and answers none of the three.',
      path: ['kind'],
    },
  )
export type QuestReportRequest = z.infer<typeof QuestReportSchema>

/**
 * What a sponsor and a steward see about the reports on one quest (`#240`).
 *
 * **The counts are visible while the quest is still running**, which is the
 * point: a quest with no claims and eight `unclear` reports is a diagnosis, and
 * it is worth having before the refund rather than in a post-mortem after it.
 *
 * `declined` is a number here and nowhere a text. See {@link QuestReportKindSchema}.
 */
export interface QuestReportCounts {
  readonly claims: number
  readonly acceptedReports: number
  readonly unclear: number
  readonly declined: number
}

/**
 * The Colony's share of every accepted report, as a percentage (`#462`).
 *
 * **25, and the number is decided in `kolonie-docs#185` rather than here.** 3%
 * was a payment-processor rate — it prices moving money — and what the fee
 * covers is steward review, moderation and verification, which is marketplace
 * work. The comparable rates are the App Store's 30%, Fiverr's 20% and Upwork's
 * ~10%.
 *
 * A default and not a constant: see {@link platformFeePercentFromEnv}.
 */
export const DEFAULT_PLATFORM_FEE_PERCENT = 25

/** The variable that overrides {@link DEFAULT_PLATFORM_FEE_PERCENT}. */
export const PLATFORM_FEE_PERCENT_VAR = 'PLATFORM_FEE_PERCENT'

/**
 * The rate in force, from the environment (`#462`).
 *
 * **Configuration with a default rather than a constant, and never a
 * parameter.** `kolonie-docs#185` decided that the rate is *"a configured
 * default, not a per-quest term"* — a rate a sponsor can influence is a discount
 * negotiation. So it is read here, in one place, and no caller supplies it:
 * a rate that arrives as an argument is a rate somebody can pass a different
 * value for.
 *
 * **It defaults rather than throwing**, which is the opposite of `banSaltFromEnv`
 * and for the opposite reason. A missing salt fails silently and costs the
 * property the table exists for; a missing fee rate would land on the published
 * default, which is the correct rate. Refusing to start over a variable whose
 * absence is already right would be a deploy hazard with nothing behind it.
 *
 * Refuses anything that is not an integer from 0 to 100. A rate outside that is
 * not a rate, and a fractional one cannot be applied to an integer ledger
 * without inventing a rounding rule per quest.
 */
export function platformFeePercentFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[PLATFORM_FEE_PERCENT_VAR]
  if (raw === undefined || raw.trim() === '') return DEFAULT_PLATFORM_FEE_PERCENT

  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new Error(
      `${PLATFORM_FEE_PERCENT_VAR} is "${raw}", which is not a whole percentage from 0 to 100. ` +
        `The platform fee is applied to an integer ledger, so a fractional rate would need a ` +
        `rounding rule per quest — see kolonie-docs#185.`,
    )
  }
  return value
}

/**
 * How one accepted report's reward divides between the citizen and the Colony
 * (`#462`, `#463`).
 *
 * **This is the one place the split is computed**, and both consoles and the
 * payout call it. Two implementations of *what does the citizen get* is a
 * disagreement a stranger can see, and `escrow.ts` and `sponsor.ts` both already
 * guard against exactly that shape.
 *
 * **The fee is computed and the citizen's side is derived by subtraction**, so
 * the two always sum to the reward by construction rather than by two
 * independent roundings that agree most of the time. `ledger.ts` is explicit
 * that amounts are integers — *"never a float, because an economy that
 * accumulates rounding error is one that can be farmed (D-004)"* — so a
 * remainder always exists and always goes somewhere.
 *
 * **The remainder goes to the citizen.** `Math.floor` on the fee means a
 * rounding can never cost a citizen a credit the quest promised it, which is the
 * side to be generous on: the Colony can explain receiving one credit less, and
 * a citizen paid less than the listing said is the failure `#463` exists to
 * prevent.
 *
 * **At the pilot's one cent the fee is nothing**, and that falls out of the
 * arithmetic rather than being special-cased: `floor(1 × 25 / 100)` is `0`, so
 * the citizen receives the whole cent and there is no fee leg to book.
 * `kolonie-docs#130` — *the pilot pays one cent, because zero books nothing* —
 * is what makes that the ordinary case rather than an edge one.
 */
export function questPayoutSplit(
  credits: number,
  feePercent: number,
): { readonly toCitizen: number; readonly toTreasury: number } {
  const toTreasury = Math.floor((credits * feePercent) / 100)
  return { toCitizen: credits - toTreasury, toTreasury }
}

/**
 * What a quest costs and where the money goes, for the two surfaces that show it
 * (`#463`).
 *
 * **Every figure here comes from {@link questPayoutSplit}**, which is the same
 * function the payout books against. Nothing on a console computes a share of
 * its own: two implementations of *what does the citizen get* is a disagreement
 * a stranger can see, and it is the failure `escrow.ts` and `sponsor.ts` both
 * already guard against.
 *
 * Capacity is multiplied through, because *250 per report × 40 reports* is the
 * number that changes a sponsor's mind and *25 %* is not.
 */
export function questFeeBreakdown(input: {
  readonly credits: number
  readonly slots: number
  readonly feePercent: number
}): {
  readonly feePercent: number
  readonly perReport: { readonly toCitizen: number; readonly toTreasury: number }
  readonly funded: number
  readonly toCitizens: number
  readonly toColony: number
  /** True when the fee rounds away, so a surface can say so instead of printing a zero. */
  readonly free: boolean
} {
  const perReport = questPayoutSplit(input.credits, input.feePercent)

  return {
    feePercent: input.feePercent,
    perReport,
    funded: input.credits * input.slots,
    toCitizens: perReport.toCitizen * input.slots,
    toColony: perReport.toTreasury * input.slots,
    free: perReport.toTreasury === 0,
  }
}

/**
 * What a citizen is told it will be paid, and what the quest costs behind that
 * (`#463`).
 *
 * **Net first.** The figure a citizen reads is what reaches its balance. The
 * gross and the Colony's share are stated too, so nothing is concealed, but the
 * prominent number is the one the citizen can spend — a listing whose headline
 * needs mental arithmetic before it is true lies to whoever reads it quickly,
 * and every argument this project makes rests on its claims being checkable.
 *
 * **The fee is named rather than implied.** A line item labelled only with a
 * percentage invites the reader to work out what it is, and they usually work
 * out something worse.
 *
 * **Where the fee rounds away the second sentence is not printed at all.** A
 * *"the Colony takes 0"* line on a one-cent pilot quest is noise that reads as a
 * charge.
 */
export function questPayNotice(input: {
  readonly credits: number
  readonly reputation: number
  readonly feePercent: number
}): string {
  const { toCitizen } = questPayoutSplit(input.credits, input.feePercent)
  const paid = `Pays you ${toCitizen} credit(s) and ${input.reputation} reputation per accepted report.`

  return `${paid} ${questFeeSentence(input)}`
}

/**
 * Where the rest of one report's reward goes, in one sentence (`#472`).
 *
 * **Split out of {@link questPayNotice} so the wording exists once.** The
 * console has room for a whole notice; the MCP surface renders a quest as a
 * bullet with a reward clause and needs the gross and the fee as a sentence it
 * can put on its own line. Two surfaces phrasing the same fee differently is a
 * disagreement a reader can see, and `apps/api/src/quests.ts` already carries
 * the rule this is the third crossing of — *"the preview a sponsor is shown has
 * to be **that** text or it is not a preview"*.
 *
 * **Where the fee rounds away this says the Colony takes nothing** rather than
 * naming a fee of zero. At the pilot's one cent that is the ordinary case, and a
 * *"the platform fee is 0"* clause reads as a charge to somebody skimming.
 */
export function questFeeSentence(input: {
  readonly credits: number
  readonly feePercent: number
}): string {
  const { toTreasury } = questPayoutSplit(input.credits, input.feePercent)

  if (toTreasury === 0) return 'You receive the full reward; the Colony takes nothing.'

  return (
    `The sponsor funds ${input.credits} of which the Colony's share — the platform ` +
    `fee, ${input.feePercent}% — is ${toTreasury}.`
  )
}
