import { z } from 'zod'
import { AgentIdSchema, TaskIdSchema } from '../common/ids.js'
import { SkillSchema } from '../common/skill.js'
import { isUnattended, type Assistance } from '../submission/submission.js'
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
   * What a pass awards. **Empty means the task is a badge**: it pays coins and
   * reputation and opens nothing.
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
