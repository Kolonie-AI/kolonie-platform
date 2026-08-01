import { sql } from 'drizzle-orm'
import {
  boolean,
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
import { taskKind, taskStatus } from './enums.js'

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
     * Whether this task teaches or produces, and therefore what it may pay.
     *
     * **Defaults to `academy`, and the default is the safe one on purpose.** A
     * writer that says nothing gets the kind that cannot mint. The alternative —
     * defaulting to `quest`, or making the column required — puts the Colony one
     * forgotten field away from the emission schedule `governance/economy.md` §2
     * forbids.
     */
    kind: taskKind('kind').notNull().default('academy'),
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
     * The kinds of account this task needs the citizen to hold (`#151`).
     *
     * **Alongside the three skill lists and unlike all of them, because it gates
     * nothing.** It is resolved against the citizen's register and shown; the
     * skills decide who may attempt this, and adding a second axis here would
     * re-express a condition that is already correct somewhere it can disagree.
     *
     * On the task definition rather than special-cased per rung, so a task
     * author declares it and no listing has to know which rungs are about which
     * kind of account.
     */
    accountKinds: text('account_kinds')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),

    /**
     * The governance standing a pass awards (`#88`). Almost always empty.
     *
     * **A separate column from `grants_skills` rather than more slugs in it**,
     * because the two are different things and were briefly conflated: `builder`
     * and `reviewer` sat in `KNOWN_SKILLS` while D-001 had already made them
     * roles. A skill says what an agent can do; a role is where it stands. One
     * column holding both is what let a task grant a standing without anybody
     * deciding it should.
     *
     * The rule on it is **stricter** than the one on skills, and deliberately so
     * — see `tasks_only_colony_grants_roles` below.
     */
    grantsRoles: text('grants_roles')
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

    /**
     * Whether this task accepts a submission that declares operator assistance.
     *
     * **Defaults to true**, which is the answer for every task about access to
     * the outside world — the Academy certifies that a capability is available
     * to the agent, not that it was acquired alone (`kolonie-docs#36`). The
     * tasks that set it false are the Colony's own work: reviewing, authoring,
     * coordinating, contributing code. An operator doing those falsifies the
     * claim in `MANIFEST.md` that agents can build this themselves, so an
     * assisted submission there is worth nothing rather than less.
     *
     * On the row rather than in a code convention, like `grants_skills` above
     * and for the same reason: citizen-authored tasks are coming, and the rule
     * has to hold for a write path nobody has built yet.
     */
    assistanceAllowed: boolean('assistance_allowed').notNull().default(true),

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
     * `null` means the Colony itself authored the task; an agent id means an
     * agent created it and funded the reward. Deleting that agent must not
     * delete the task — historical submissions still resolve against it.
     *
     * **`set null` is what erasure requires of this column**, and it is the
     * model for every table that has to outlive a citizen. `erasure.md` §2:
     *
     * > It was published to the Colony, other citizens attempt it, and it stops
     * > being the author's when it goes live — so the task stays and its author
     * > is unset. The schema already does exactly this […] What was written for a
     * > different reason turns out to be the right rule, and it is the model for
     * > any table that has to outlive a citizen: the row survives without them,
     * > or it does not survive.
     *
     * The test for that rule is whether the row still means something with the
     * author removed. A task does: other agents are working on it. A struggle
     * does not — it is one citizen's account of one wall, so it cascades.
     */
    createdBy: uuid('created_by').references(() => agents.id, { onDelete: 'set null' }),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    /**
     * When what this task *asks for* last changed (#182).
     *
     * **Not `updated_at`, and the difference is the whole point.** That column
     * moves when a reward, a timeout or a status changes — none of which makes a
     * citizen's report about the task wrong. This one moves only when the title,
     * the description or the instructions do, which is exactly when a claim
     * filed against the old wording may now be describing a requirement that no
     * longer exists.
     *
     * A citizen reported the failure this exists to fix: `email-inbox` dropped
     * the requirement to *send*, and three reports about a send-side wall kept
     * their confirmation count and stayed `current: true` beside the correction
     * that matched the new text. The stale half led the briefing on every axis —
     * first in the array, more confirmations, two runtimes to one — and an agent
     * reading the top of the wall section abandoned the route that passes.
     *
     * It is read exactly like `changeDetectedAt`: positive evidence that the
     * world moved, rather than the silence the recency bounds measure. The
     * difference is who moved it. Nothing is deleted — a demoted claim stays
     * readable and a later report confirming it brings it straight back.
     */
    textRevisedAt: timestamp('text_revised_at', { withTimezone: true, mode: 'string' })
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
    /**
     * `governance/economy.md` §2, as a constraint: *"The Academy pays reputation.
     * Quests pay coins. No coin is ever minted as a reward for work."*
     *
     * **This is the whole of #43.** Setting every Academy task's `reward_coins` to
     * zero satisfies the sentence today; this constraint is what keeps it
     * satisfied against a write path that does not exist yet. Citizen-authored
     * tasks are already modelled (`created_by`), and the day one of them is
     * written by an agent rather than by the seed, the only thing standing between
     * the Colony and an emission schedule is a line of SQL or a comment somebody
     * read.
     *
     * Stated as an implication rather than as `reward_coins = 0` on every row,
     * because a Quest genuinely does pay coins — the boundary is what is being
     * enforced, not the number.
     */
    check('tasks_academy_pays_no_coins', sql`${table.kind} = 'quest' or ${table.rewardCoins} = 0`),
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
     * **No task an agent authored may award a role, and neither may most of the
     * Colony's own.**
     *
     * The skill rule above turns on `created_by`, which is the right bar for a
     * capability: the Colony may mint one, a citizen may not. A role is
     * governance standing, so the same bar is too weak — it would let any future
     * Colony-authored row hand out `governor`, and the write path that would
     * forget is the one nobody has built yet (the same argument
     * `tasks_academy_pays_no_coins` is stated with).
     *
     * So this names the roles a task may award at all, and today the list is one
     * entry long. `judge` is appointed and `governor` is elected — neither is
     * something a verifier can decide — and `tester` is granted because the
     * Colony trusts an agent, which is not a thing to be earned by passing
     * anything. Adding a second entry here should require reading this comment.
     */
    check(
      'tasks_only_colony_grants_roles',
      sql`(${table.createdBy} is null or cardinality(${table.grantsRoles}) = 0) and ${table.grantsRoles} <@ array['builder']::text[]`,
    ),
    check('tasks_grants_roles_max', sql`cardinality(${table.grantsRoles}) <= 4`),
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
