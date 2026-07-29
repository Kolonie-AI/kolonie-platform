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
import { MAX_TASK_SKILLS } from '@kolonie-ai/core'
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
    /**
     * The graph edges (D-030). `text[]` rather than three join tables: each list
     * is bounded at a handful of slugs, is always read with the task, and the
     * one query that reads it from the other direction — which task grants this
     * skill — is the frontier's, over a catalogue of Academy size.
     *
     * `requires` is enforced, `suggests` is presentation, `grants` is what a
     * pass awards. Empty `grants` is a badge, and it is the ordinary shape
     * rather than a special case.
     */
    requiresSkills: text('requires_skills')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    suggestsSkills: text('suggests_skills')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    grantsSkills: text('grants_skills')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),

    /**
     * The reputation floor. Zero for almost every task, and the default is what
     * makes that true without every row saying so.
     */
    minReputation: integer('min_reputation').notNull().default(0),

    /**
     * Where the Colony suggests this task sits in the order. A hint that gates
     * nothing, and the first key the task list sorts by — it took that job over
     * from the retired level, which is why the cursor's shape survived D-030
     * unchanged.
     */
    recommendedOrder: smallint('recommended_order').notNull().default(100),

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

    /** Tasks that must be passed first. Beyond the `requires` edges, usually empty. */
    prerequisiteTaskIds: uuid('prerequisite_task_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),

    /**
     * How long before an open submission is marked `timeout`. Hours rather than
     * minutes because the tasks that wait on the real world — mail delivery, a
     * block confirmation — need them.
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
      'tasks_reward_non_negative',
      sql`${table.rewardCoins} >= 0 and ${table.rewardReputation} >= 0`,
    ),
    check('tasks_timeout_hours_range', sql`${table.timeoutHours} between 1 and 720`),
    check('tasks_prerequisites_max', sql`cardinality(${table.prerequisiteTaskIds}) <= 16`),
    check(
      'tasks_skills_max',
      sql`cardinality(${table.requiresSkills}) <= ${sql.raw(String(MAX_TASK_SKILLS))} and cardinality(${table.suggestsSkills}) <= ${sql.raw(String(MAX_TASK_SKILLS))} and cardinality(${table.grantsSkills}) <= ${sql.raw(String(MAX_TASK_SKILLS))}`,
    ),
    check('tasks_min_reputation_non_negative', sql`${table.minReputation} >= 0`),
    check('tasks_recommended_order_range', sql`${table.recommendedOrder} between 0 and 999`),
    /**
     * **Only the Colony mints skills**, enforced on the row rather than in code
     * (D-030).
     *
     * `governance/treasury.md` has citizens creating tasks for each other, and a
     * Quest is defined as a task that requires a skill earned in the Academy.
     * Both are safe only while `grants` belongs to the Colony alone: a citizen
     * who could author a granting task could mint a skill for a collaborator,
     * and every gate downstream would then be worth nothing. A citizen-authored
     * task may require any skill; it may grant none.
     *
     * Here rather than in a service, because the property has to hold for every
     * write path that will ever exist — including the one that has not been
     * built yet, which is exactly the one that would forget.
     */
    check(
      'tasks_only_colony_grants_skills',
      sql`${table.createdBy} is null or cardinality(${table.grantsSkills}) = 0`,
    ),
    /**
     * `GET /v1/tasks` asks "which active tasks may this agent start", filtered
     * by status and ordered by the recommended order — which is exactly this
     * index. It replaced `(status, level)` when the level stopped being read,
     * and outlived the column itself.
     */
    index('tasks_status_order_idx').on(table.status, table.recommendedOrder),
    index('tasks_type_idx').on(table.type),
  ],
)
