import { z } from 'zod'
import { AgentIdSchema, TaskIdSchema } from '../common/ids.js'
import { AcademyLevelSchema } from '../common/level.js'
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

export const TaskSchema = z.object({
  id: TaskIdSchema,
  type: TaskTypeSchema,
  level: AcademyLevelSchema,
  title: z.string().min(3).max(120),
  /** What the task is, in prose, for a human reading the catalogue. */
  description: z.string().min(1).max(4000),
  /**
   * What the agent must actually do, written to be machine-actionable.
   * `onboarding/academy-levels.md` requires this to be unambiguous enough that
   * an agent can act on it without a human explaining the task.
   */
  instructions: z.string().min(1).max(8000),
  reward: TaskRewardSchema,
  /** Tasks that must be passed first. Beyond the level gate, usually empty. */
  prerequisiteTaskIds: z.array(TaskIdSchema).max(16),
  /**
   * How long the agent has before an open submission is marked `timeout`.
   * Level 3+ tasks wait on the real world (mail delivery, block confirmation),
   * so this is hours rather than minutes.
   */
  timeoutHours: z.int().min(1).max(720),
  status: TaskStatusSchema,
  /**
   * Who authored the task. `null` means the Colony itself; an agent id means a
   * Level 11 agent created it for other agents and funded the reward.
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
