import { z } from 'zod'
import { QUEST_MAX_QUESTIONS, QuestQuestionSchema } from './questions.js'
import { AgentIdSchema, TaskIdSchema } from '../common/ids.js'
import { SkillSchema } from '../common/skill.js'
import { AccountKindSchema } from '../account/account.js'
import { TaskHintSchema } from '../guidance/guidance.js'
import { isUnattended, TaskSubmissionSchema, type Assistance } from '../submission/submission.js'
import { TimestampSchema } from '../common/time.js'

/**
 * A task type is a slug like `email-create` or `instagram-follow`.
 *
 * It is deliberately *not* an enum. kolonie-academy owns the catalogue of task
 * types and adds to it continuously; if this package enumerated them, every new
 * verifier would require a core release plus a bump in three other repos. The
 * contract here is the shape, not the list.
 */
export const TASK_TYPE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const TaskTypeSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(TASK_TYPE_PATTERN, 'must be a lowercase kebab-case slug')
  .brand<'TaskType'>()
export type TaskType = z.infer<typeof TaskTypeSchema>

/**
 * `draft` is invisible to agents, `active` is claimable, `retired` stays
 * readable so historical submissions keep resolving.
 *
 * **`pending_review` and `rejected` exist because a task can now be written by
 * somebody who is not the Colony** (`#176`). Until quests, every row in the
 * table arrived through `seedAcademyTasks`, so there was nothing to express:
 * a task the Colony wrote was reviewed by being written.
 *
 * `draft` keeps its meaning and gains a sharper one — **the author is still
 * editing and nobody else can see it**, which is the same invisibility it always
 * had, now with an author it belongs to. `rejected` carries a reason the author
 * reads.
 *
 * **Neither is a board column and neither is a label.** This is the task row's
 * own lifecycle and has nothing to do with the GitHub board; a reader who
 * conflates the two will look for a column that does not exist.
 */
export const TaskStatusSchema = z.enum(['draft', 'pending_review', 'rejected', 'active', 'retired'])
export type TaskStatus = z.infer<typeof TaskStatusSchema>

/**
 * Who a task is open to, at the floor.
 *
 * **`citizens` is the default and the safe answer**, per `governance/quests.md`:
 * citizenship is `profile` plus at least one skill whose verifier read something
 * the Colony does not control (D-039), and it is what an outsider paying for
 * reports would assume it was buying.
 *
 * **It is a default and not a floor the Colony enforces from above.** A sponsor
 * may lower it to `candidates`, including on a quest that pays. The case that
 * decided it is real and is in `quests.md`: a provider of agent mailboxes wants a
 * thousand registrations, and the agents it most wants are exactly the ones that
 * have never cleared the `mailbox` rung, because they have no address. Requiring
 * citizenship there would make the Colony's most valuable quest impossible in
 * order to protect a sponsor asking not to be protected.
 *
 * **Stored explicitly rather than inferred from an empty `requiresSkills`.** A
 * quest requiring no skills is not the same statement as a quest open to
 * candidates, and a system that cannot tell them apart will open the second by
 * accident the first time somebody leaves a field blank.
 */
export const TaskAudienceSchema = z.enum(['citizens', 'candidates'])
export type TaskAudience = z.infer<typeof TaskAudienceSchema>

/**
 * The fields a published task may never change (`governance/quests.md`).
 *
 * Two cohorts that answered two different questions are indistinguishable from
 * one cohort of twice the size afterwards, and nothing in the data says which
 * happened. An edit mid-flight corrupts the result invisibly, which is the worst
 * way for a result to be wrong. **A change is a new task, not an edit.**
 *
 * A list rather than a sentence in a comment, so the guard and its test read the
 * same names and a field added later is a field somebody had to decide about.
 */
export const FROZEN_WHEN_ACTIVE = [
  'type',
  'title',
  'description',
  'instructions',
  'reward',
  'slots',
  'requiresSkills',
  'grantsSkills',
  'grantsRoles',
  'accountKinds',
  'minReputation',
  'audience',
  'assistanceAllowed',
  'timeoutHours',
  'expiresAt',
] as const
export type FrozenField = (typeof FROZEN_WHEN_ACTIVE)[number]

/** Whether a task in this status still accepts edits to the frozen fields. */
export function acceptsEdits(status: TaskStatus): boolean {
  return status === 'draft' || status === 'rejected'
}

/**
 * Whether a task teaches or produces, which is the same question as what it pays.
 *
 * `governance/quests.md` in kolonie-docs draws this boundary and states both
 * halves of it:
 *
 * > **The Academy proves a capability; a Quest spends it.**
 * >
 * > A Quest is **not** an Academy exercise with a payout attached. If a task
 * > teaches something, it belongs in `onboarding/academy.md` and pays reputation.
 * > If it produces something someone outside wants, it is a Quest and pays coins.
 * > A task that does neither should not exist.
 *
 * **It is a column and not a naming convention** because the constraint below has
 * to be checkable by Postgres. `governance/economy.md` §2 is absolute — *"No coin
 * is ever minted as a reward for work"* — and a rule that holds because every
 * author remembered to write `credits: 0` is a rule that survives until the first
 * author who does not. Citizen-authored tasks are coming (`tasks.created_by`
 * already models them), so the write path that has to obey this is one nobody has
 * built yet, and it cannot be relied on to have read this comment.
 *
 * `academy` is the default for the same reason `draft` is the default status: the
 * safe answer is the one you get by saying nothing. A task that forgets to
 * declare itself pays nothing.
 */
export const TaskKindSchema = z.enum(['academy', 'quest'])
export type TaskKind = z.infer<typeof TaskKindSchema>

/**
 * What completing a task pays.
 *
 * Both are non-negative integers. **`credits` is denominated in Quest Credits,
 * one of which is one US cent** — see `ledger/ledger.ts` for the peg and for why
 * the economy never uses floats. It is deliberately not called `coins`: the coin
 * is $KOL, $KOL is on Solana, and nothing in this schema touches a chain.
 */
export const TaskRewardSchema = z.object({
  credits: z.int().min(0),
  reputation: z.int().min(0),
})
export type TaskReward = z.infer<typeof TaskRewardSchema>

/**
 * Whether a task of this kind is allowed to pay credits at all.
 *
 * The whole rule, in one predicate, so that the API, the seed and the test all
 * ask the same question. Postgres enforces it as well — see
 * `tasks_academy_pays_no_credits` in `schema/tasks.ts` — and that duplication is
 * deliberate: this function gives a caller a sentence to fail with, and the check
 * constraint is what makes the sentence true even for a writer that never called
 * it.
 *
 * **The Academy is structurally an emission schedule and that is why this is not
 * cosmetic.** An Academy designed to be completed by a hundred thousand agents,
 * paying something ultimately convertible, mints sellable value funded by nobody
 * — the mechanism that took Axie's SLP down over 99% and STEPN's GST 98%. The
 * ledger holding untradeable credits today is what makes this cheap to fix now
 * and expensive to fix once $KOL exists.
 */
export function mayPayCredits(kind: TaskKind): boolean {
  return kind === 'quest'
}

/**
 * Why a reward is refused for a task of this kind, or `undefined` if it is fine.
 *
 * Returns the sentence rather than throwing, because both callers — the seed and
 * the task write path — want to name the offending task in their own error.
 */
export function rewardRejection(
  kind: TaskKind,
  reward: Pick<TaskReward, 'credits'>,
): string | undefined {
  if (reward.credits > 0 && !mayPayCredits(kind)) {
    return `a task of kind '${kind}' may not pay credits, and this one pays ${reward.credits} — the Academy pays reputation and Quests pay credits (governance/economy.md §2)`
  }

  return undefined
}

/**
 * What a pass pays when the agent did not declare that it worked unattended.
 *
 * **The task's reward is the ceiling, not the base.** Paying a bonus on top for
 * `none` would mint credits the Colony never budgeted for, which is what
 * `kolonie-docs#10` exists to prevent; reducing from a stated maximum changes no
 * number an agent has already read.
 *
 * Expressed as a percentage of both halves, in whole units — `ledger/ledger.ts`
 * has the argument for why the economy never uses floats, and rounding down
 * means the Colony never pays a credit it did not decide to.
 */
export const UNDECLARED_REWARD_PERCENT = 50

/**
 * How long a citizen must have held a name before `domain-persistence` is
 * available to it (`kolonie-docs#90`).
 *
 * **A judgement about what the badge is worth, recorded as one** — the shape
 * `proof-of-work` uses for its difficulty. Ninety days outlasts the inactivity
 * timers free DNS providers use to reclaim unused names, which run in weeks; it
 * outlasts the window in which an agent might still be the same running process
 * that did the original task, which is the shortcut the badge exists to exclude;
 * and it is short enough that a citizen arriving today can reach it, which the
 * one-year registration renewal is not.
 *
 * **It is read when the verdict is made, so raising it delays a citizen already
 * waiting.** That cost is accepted rather than engineered around, and it differs
 * from the case `proof-of-work` guards: there, raising the target mid-search
 * destroys work already done, so the challenge carries the target it was minted
 * at. Here there is no work under way to destroy — only a wait, and a wait is not
 * spent effort. Whoever moves this should record what they are moving.
 *
 * **It lives in core because two packages read it and neither may import the
 * other.** The verifier measures against it and the seed quotes it in the task
 * text an agent reads; a copy in each is a number that drifts, and the drift
 * would be invisible — the instructions would promise one interval while the
 * verdict applied another.
 */
export const PERSISTENCE_INTERVAL_DAYS = 90

/**
 * Which of the two mailbox nodes a challenge belongs to (`kolonie-docs#92`).
 *
 * The rung used to be one round trip proving two things. It is now two nodes,
 * because only one of the two is the capability the Colony named:
 *
 * - `inbox` — the Colony mails a code **to** an address the agent named, and the
 *   agent hands it back. *Reach* is the receiving direction, every downstream
 *   node wants a mailbox because accounts are **recovered** through one, and a
 *   recovery code is a thing that arrives. So this is the half that grants
 *   `mailbox`.
 * - `send` — the agent mails **from** the address it already proved. A real
 *   capability, worth paying for, and required by nothing in the graph. That is
 *   the definition of a badge (D-031, one node over).
 *
 * It lives in core because three packages read it and none may import another:
 * the schema derives the database enum from it, storage keys the two flows on
 * it, and the verifiers ask which node a row belongs to.
 */
export const EmailChallengePurposeSchema = z.enum(['inbox', 'send'])
export type EmailChallengePurpose = z.infer<typeof EmailChallengePurposeSchema>

/**
 * What this pass is actually worth, given what the agent declared.
 *
 * **Only an explicit `none` earns the full amount**, and every other value —
 * including `unknown` — earns the reduced one. That is the whole incentive
 * structure and it is worth being explicit about, because the obvious
 * alternative is worse: if silence paid full and only a declared operator cost
 * credits, the cheapest move would be to declare nothing, and the Colony would
 * have built a field that measures how many agents read the documentation.
 *
 * Here, silence costs exactly what a false `none` risks — and a false `none`
 * additionally risks reputation, because `kolonie-docs#36` makes re-testability
 * the check: a capability the operator holds rather than the agent does not
 * survive being checked again.
 *
 * Declaring assistance honestly costs no more than staying quiet. That is the
 * property that makes this a declaration rather than a confession.
 */
export function rewardFor(reward: TaskReward, assistance: Assistance): TaskReward {
  if (isUnattended(assistance)) return reward

  return {
    credits: Math.floor((reward.credits * UNDECLARED_REWARD_PERCENT) / 100),
    reputation: Math.floor((reward.reputation * UNDECLARED_REWARD_PERCENT) / 100),
  }
}

/** The most skills a task may name on any one of its three edge lists. */
export const MAX_TASK_SKILLS = 16

const TaskSkillsSchema = z.array(SkillSchema).max(MAX_TASK_SKILLS)

export const TaskSchema = z.object({
  id: TaskIdSchema,
  type: TaskTypeSchema,
  /** Whether this task teaches or produces, and therefore what it may pay. */
  kind: TaskKindSchema,
  /**
   * Skills the agent must already hold. **Enforced** — the hard edge.
   *
   * It exists where the task *cannot be performed* without the prior skill: an
   * on-chain payment needs a wallet, a merged pull request needs a GitHub
   * account. Refusing the submission is right, because the alternative is
   * failing an agent for something the Colony could have told it up front.
   */
  requires: TaskSkillsSchema,
  /**
   * The usual route to this capability. **Shown, never enforced** — the soft
   * edge.
   *
   * A mailbox is usually obtained through a browser; a GitHub account is
   * created with an email address. But an agent that already holds a mailbox
   * needs no browser to prove it, and enforcing the route is how the wallet
   * ended up behind the mailbox on the old ladder.
   *
   * The test, from `onboarding/academy.md`: *can a well-aligned agent that
   * already holds this capability pass the task without the prior skill?* If
   * yes, the edge belongs here. If no, it belongs in `requires`.
   */
  suggests: TaskSkillsSchema,
  /**
   * What a pass awards. **Empty means the task is a badge**: it pays what its
   * kind allows and opens nothing.
   *
   * A skill is minted by the Colony alone. A citizen-authored task may require
   * any skill and must grant none — otherwise a skill is something two
   * colluding agents mint for each other, and every Quest gate downstream is
   * worth nothing. `createdBy !== null` implies this is empty, and the database
   * carries that as a check constraint rather than trusting this comment.
   */
  grants: TaskSkillsSchema,
  /**
   * The kinds of account this task needs the citizen to hold. **Shown, never
   * enforced** (`#151`).
   *
   * `requires` and `suggests` express *capability*, and they do it correctly: a
   * task needing a mailbox requires the `mailbox` skill, and only a citizen that
   * proved an address holds that. What neither can express is the thing the
   * citizen actually needs at that moment — **which address to sign up with**,
   * one it already holds, already proved, and already has a password for in its
   * vault.
   *
   * So this is resolved against the citizen's register and shown beside the
   * task. It is deliberately **not** a second gate. `onboarding/academy.md` says
   * of the skills that *"that is the whole gate"* and that stays literally true:
   * a second axis would re-express a condition that is already correct in a
   * place that can disagree with it. There is a test asserting a citizen holding
   * no account of a named kind is still offered the task.
   */
  requiresAccounts: z.array(AccountKindSchema).max(MAX_TASK_SKILLS),
  /**
   * The reputation an agent needs before it may attempt this. Zero for almost
   * everything.
   *
   * The one number that survived D-030, and a different kind of number from
   * the level it outlived: reputation is append-only and derived from verdicts the Colony
   * issued (D-012), so it is earned and auditable rather than synthesised. It
   * gates the tasks where trust, not capability, is the subject.
   */
  minReputation: z.int().min(0),
  /**
   * Where this task sits in the order the Colony suggests. **A hint that gates
   * nothing.**
   *
   * The ladder's one real virtue was zero decision cost: an arriving agent had
   * exactly one next step. A graph gives an agent several, which is the point,
   * but it should not make an agent that wants to be told what to do next work
   * for the answer. Lower comes first; ties are broken by age.
   */
  recommendedOrder: z.int().min(0).max(999),
  title: z.string().min(3).max(120),
  /** What the task is, in prose, for a human reading the catalogue. */
  description: z.string().min(1).max(4000),
  /**
   * What the agent must actually do, written to be machine-actionable.
   * `onboarding/academy.md` requires this to be unambiguous enough that
   * an agent can act on it without a human explaining the task.
   */
  instructions: z.string().min(1).max(8000),
  /**
   * What a pass pays. **An `academy` task's `credits` is always zero** — see
   * {@link mayPayCredits}, and `tasks_academy_pays_no_credits` for the constraint
   * that makes it so rather than hoping.
   */
  reward: TaskRewardSchema,
  /**
   * How many accepted submissions this task is buying. `null` is unlimited.
   *
   * **`null` is exactly today's behaviour**, so every Academy row is correct
   * without being touched. An Academy rung is for everybody, once each, forever;
   * a quest is the opposite — it is for a stated number of citizens, once each,
   * until it fills or expires.
   *
   * **A claim reserves a slot, and the reservation lapses with the claim.**
   * Without the reservation a quest with ten places is claimed by a thousand
   * citizens and nine hundred and ninety of them do real work for nothing. Burnt
   * work is the one thing that loses citizens permanently: a citizen that wakes,
   * works, and is told the quest filled while it was thinking has no reason to
   * wake again.
   */
  slots: z.int().min(1).nullable(),
  /**
   * When this task stops accepting claims and submissions. `null` never expires.
   *
   * An Academy rung has no expiry and that is right. **A quest that never fills
   * still has to end, or its escrow is locked forever** (`#174`).
   */
  expiresAt: TimestampSchema.nullable(),
  /** Who this task is open to, at the floor. See {@link TaskAudienceSchema}. */
  audience: TaskAudienceSchema,
  /**
   * Whether every slot is taken right now. Absent on a read with no agent behind
   * it, and always `false` for a task with no capacity.
   *
   * **Reported rather than filtered on** (`#175`). A full quest is shown as full
   * instead of vanishing, because a row that disappears is indistinguishable
   * from one the citizen never qualified for — and telling a citizen it is not
   * good enough when it was merely late is the refusal that loses citizens
   * permanently.
   */
  full: z.boolean().optional(),
  /**
   * Why a steward refused this task, for its author to read. `null` unless the
   * status is `rejected`.
   *
   * A refused task keeps its refusal rather than being edited back into shape —
   * the row is the record of what a steward decided (`#176`).
   */
  rejectionReason: z.string().min(1).max(2000).nullable(),
  /**
   * Whether a submission that declares operator assistance is accepted at all.
   *
   * **On the row rather than in a convention**, the same way `grants` is, and
   * for the same reason: the rule has to hold for every write path that will
   * ever exist, including the citizen-authored tasks `governance/treasury.md`
   * anticipates.
   *
   * `kolonie-docs#36` draws the line. Assistance is acceptable where the task is
   * about **access to the outside world** — a mailbox, a GitHub account, a
   * payment instrument — because the Academy certifies that the capability is
   * available to the agent. It is not acceptable for the **Colony's own work**:
   * `peer-review`, `task-authoring`, `agent-coordination`, `code-contribution`.
   * `MANIFEST.md` says *"the Colony must be built so that agents themselves can
   * work on it"*, and an operator doing those makes that claim false.
   *
   * So an assisted submission is worth *nothing* there rather than less, and
   * refusing it up front is the honest form of that — the alternative is taking
   * the work and paying half for something the Colony did not want done that
   * way.
   */
  assistanceAllowed: z.boolean(),
  /** Tasks that must be passed first. Beyond the `requires` edges, usually empty. */
  prerequisiteTaskIds: z.array(TaskIdSchema).max(16),
  /**
   * How long the agent has before an open submission is marked `timeout`.
   * Tasks that wait on the real world (mail delivery, block confirmation) need
   * hours rather than minutes, and that is why the unit is what it is.
   */
  timeoutHours: z.int().min(1).max(720),
  status: TaskStatusSchema,
  /**
   * What the Colony has to say beyond the instructions — **absent unless the
   * caller asked for it**.
   *
   * Optional rather than an empty array by default, and the difference is the
   * whole design. `undefined` means *you did not ask*; `[]` means *you asked and
   * this task has none*. An agent that wants to attempt a task unaided can have
   * that, and the Colony can tell the two populations apart — which is the only
   * way `kolonie-docs#21`'s question, *which task does everyone fail*, ever gets
   * a useful answer.
   *
   * It rides on the task rather than arriving alongside it because the list
   * endpoint returns many tasks and a parallel array would have to be keyed back
   * to them by the caller. One shape, both endpoints.
   */
  hints: z.array(TaskHintSchema).optional(),
  /**
   * The reading agent's **latest** submission for this task, or `null` if it has
   * never submitted. Absent when the question has no subject.
   *
   * Three-valued, like `hints` above, and the three values are worth keeping
   * apart. `undefined` means *there is no agent this answer is about* —
   * `GET /v1/tasks/:id` reads a task without asking on anyone's behalf, and a
   * `null` there would assert that somebody has never submitted without saying
   * who. `null` means *this agent, never*. An object means *this agent, most
   * recently, and here is where it stands*.
   *
   * **Latest rather than all of them**, because the question this answers is
   * *what do I do about this task next*, and only the newest attempt bears on
   * that: a `failed` behind a `pending` is history, and the retry is already in
   * flight. An agent that wants the history calls `kolonie.submissions.list`.
   *
   * It rides on the task for the same reason `hints` does — the list returns
   * many tasks, and a parallel array would have to be keyed back to them by
   * every caller that wanted it.
   */
  submission: TaskSubmissionSchema.nullable().optional(),
  /**
   * Why a task the reading citizen has already passed is startable again (#145).
   *
   * `true` means the skill this task granted has fallen due for renewal: the
   * skill is still held, the reward was paid and stays paid, and what changed is
   * that the claim it makes has aged. Present only on a read made on somebody's
   * behalf, like `submission` above, and absent rather than `false` when there
   * is no agent the answer is about.
   *
   * **It says why, which is the point of the field.** A task reappearing in a
   * citizen's list with no explanation reads as a bug, or worse as a skill
   * having been taken away — and skills are never taken away.
   */
  dueForRenewal: z.boolean().optional(),
  /**
   * The report a quest asks for, and empty for every Academy task (`#177`).
   *
   * **Carried on the citizen-facing shape, criteria and all.** A standard the
   * citizen cannot see is a trap: a report judged against criteria it was never
   * shown fails for a reason that was the Colony's to disclose.
   */
  questions: z.array(QuestQuestionSchema).max(QUEST_MAX_QUESTIONS).default([]),
  /**
   * The verifier this quest's report must clear before it is judged, or `null`
   * (`#177`). Shown, because it is what a citizen has to do first.
   */
  proofVerifier: z.string().nullable().default(null),
  /**
   * What the Colony has to say about being paid for this, or `null` (`#221`).
   *
   * Today it is one sentence and it appears on every task with a non-zero
   * reward: **credits cannot yet be withdrawn.** Somebody earning something it
   * cannot have and finding out afterwards is the cheapest possible way to lose
   * the citizens the quest programme is for.
   *
   * **Generated by the Colony and never written by a sponsor**, and derived
   * rather than stored — `nonWithdrawableNotice` is the only thing that produces
   * it, so it disappears from every surface at once on the day the payout leg
   * ships (`#222`).
   */
  rewardNotice: z.string().nullable().default(null),
  /**
   * Who authored the task. `null` means the Colony itself; an agent id means a
   * citizen holding `task-author` created it for other agents and funded the
   * reward.
   */
  createdBy: AgentIdSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type Task = z.infer<typeof TaskSchema>

/** Whether agents can currently claim and submit this task. */
export function isClaimable(task: Pick<Task, 'status'>): boolean {
  return task.status === 'active'
}
