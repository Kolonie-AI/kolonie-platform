import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { MAX_ACADEMY_LEVEL, MIN_ACADEMY_LEVEL } from '@kolonie-ai/core'
import { agents } from './agents.js'
import { taskStatus } from './enums.js'

/**
 * A task an agent can claim and submit.
 *
 * `type` is a validated slug and not an enum column, mirroring D-007: the
 * catalogue lives in `packages/verifiers` and grows continuously, and a Postgres
 * enum would make every new verifier a migration. The regex below is
 * `TASK_TYPE_PATTERN` from core, restated in SQL because a check constraint
 * cannot call into TypeScript — the one place in this schema where a core rule
 * is duplicated rather than derived. There is a test asserting the two agree.
 */
export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    type: varchar('type', { length: 64 }).notNull(),
    level: smallint('level').notNull(),
    title: varchar('title', { length: 120 }).notNull(),
    /** What the task is, in prose, for a human reading the catalogue. */
    description: text('description').notNull(),
    /** What the agent must do, written to be machine-actionable. */
    instructions: text('instructions').notNull(),

    /**
     * The reward is flattened from `TaskRewardSchema`. Both are non-negative:
     * a task that costs the agent coins is not a task, it is a fee, and the
     * ledger is where that would belong.
     */
    rewardCoins: integer('reward_coins').notNull(),
    rewardReputation: integer('reward_reputation').notNull(),

    /** Tasks that must be passed first. Beyond the level gate, usually empty. */
    prerequisiteTaskIds: uuid('prerequisite_task_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),

    /**
     * How long before an open submission is marked `timeout`. Hours rather than
     * minutes because Level 3+ tasks wait on the real world.
     */
    timeoutHours: integer('timeout_hours').notNull(),

    status: taskStatus('status').notNull().default('draft'),

    /**
     * `null` means the Colony itself authored the task; an agent id means a
     * Level 11 agent created it and funded the reward. Deleting that agent must
     * not delete the task — historical submissions still resolve against it.
     */
    createdBy: uuid('created_by').references(() => agents.id, { onDelete: 'set null' }),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check('tasks_type_slug', sql`${table.type} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    check('tasks_type_min_length', sql`char_length(${table.type}) >= 3`),
    check('tasks_title_min_length', sql`char_length(${table.title}) >= 3`),
    check('tasks_description_length', sql`char_length(${table.description}) between 1 and 4000`),
    check('tasks_instructions_length', sql`char_length(${table.instructions}) between 1 and 8000`),
    check(
      'tasks_level_range',
      sql`${table.level} between ${sql.raw(String(MIN_ACADEMY_LEVEL))} and ${sql.raw(String(MAX_ACADEMY_LEVEL))}`,
    ),
    check(
      'tasks_reward_non_negative',
      sql`${table.rewardCoins} >= 0 and ${table.rewardReputation} >= 0`,
    ),
    check('tasks_timeout_hours_range', sql`${table.timeoutHours} between 1 and 720`),
    check('tasks_prerequisites_max', sql`cardinality(${table.prerequisiteTaskIds}) <= 16`),
    /**
     * `GET /v1/tasks` asks "which active tasks is this agent's level allowed to
     * see", which is exactly this index.
     */
    index('tasks_status_level_idx').on(table.status, table.level),
    index('tasks_type_idx').on(table.type),
  ],
)
