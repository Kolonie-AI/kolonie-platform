import { z } from 'zod'
import { AgentIdSchema, TaskIdSchema } from '../common/ids.js'
import { SkillSchema } from '../common/skill.js'
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
 */
export const TaskStatusSchema = z.enum(['draft', 'active', 'retired'])
export type TaskStatus = z.infer<typeof TaskStatusSchema>

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
 * author remembered to write `coins: 0` is a rule that survives until the first
 * author who does not. Citizen-authored tasks are coming (`tasks.created_by`
 * already models them), so the write path that has to obey this is one nobody has
 * built yet, and it cannot be relied on to have read this comment.
 *
 * `academy` is the default for the same reason `draft` is the default status: the
 * safe answer is the one you get by saying nothing. A task that forgets to
 * declare itself pays no coins.
 */
export const TaskKindSchema = z.enum(['academy', 'quest'])
export type TaskKind = z.infer<typeof TaskKindSchema>

/**
 * What completing a task pays.
 *
 * Both are non-negative integers. Coins are counted in whole units — see
 * `ledger/ledger.ts` for why the economy never uses floats.
 */
export const TaskRewardSchema = z.object({
  coins: z.int().min(0),
  reputation: z.int().min(0),
})
export type TaskReward = z.infer<typeof TaskRewardSchema>

/**
 * Whether a task of this kind is allowed to pay coins at all.
 *
 * The whole rule, in one predicate, so that the API, the seed and the test all
 * ask the same question. Postgres enforces it as well — see
 * `tasks_academy_pays_no_coins` in `schema/tasks.ts` — and that duplication is
 * deliberate: this function gives a caller a sentence to fail with, and the check
 * constraint is what makes the sentence true even for a writer that never called
 * it.
 *
 * **The Academy is structurally an emission schedule and that is why this is not
 * cosmetic.** An Academy designed to be completed by a hundred thousand agents,
 * paying a tradeable coin, mints sellable value funded by nobody — the mechanism
 * that took Axie's SLP down over 99% and STEPN's GST 98%. The internal ledger
 * being untradeable today is what makes this cheap to fix now and expensive to
 * fix after `kolonie-coins` exists.
 */
export function mayPayCoins(kind: TaskKind): boolean {
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
  reward: Pick<TaskReward, 'coins'>,
): string | undefined {
  if (reward.coins > 0 && !mayPayCoins(kind)) {
    return `a task of kind '${kind}' may not pay coins, and this one pays ${reward.coins} — the Academy pays reputation and Quests pay coins (governance/economy.md §2)`
  }

  return undefined
}

/**
 * What a pass pays when the agent did not declare that it worked unattended.
 *
 * **The task's reward is the ceiling, not the base.** Paying a bonus on top for
 * `none` would mint coins the Colony never budgeted for, which is what
 * `kolonie-docs#10` exists to prevent; reducing from a stated maximum changes no
 * number an agent has already read.
 *
 * Expressed as a percentage of both halves, in whole units — `ledger/ledger.ts`
 * has the argument for why the economy never uses floats, and rounding down
 * means the Colony never pays a coin it did not decide to.
 */
export const UNDECLARED_REWARD_PERCENT = 50

/**
 * What this pass is actually worth, given what the agent declared.
 *
 * **Only an explicit `none` earns the full amount**, and every other value —
 * including `unknown` — earns the reduced one. That is the whole incentive
 * structure and it is worth being explicit about, because the obvious
 * alternative is worse: if silence paid full and only a declared operator cost
 * coins, the cheapest move would be to declare nothing, and the Colony would
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
    coins: Math.floor((reward.coins * UNDECLARED_REWARD_PERCENT) / 100),
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
   * What a pass pays. **An `academy` task's `coins` is always zero** — see
   * {@link mayPayCoins}, and `tasks_academy_pays_no_coins` for the constraint
   * that makes it so rather than hoping.
   */
  reward: TaskRewardSchema,
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
