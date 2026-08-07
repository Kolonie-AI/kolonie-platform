import { sql } from 'drizzle-orm'
import { check, index, pgTable, primaryKey, timestamp, uuid, varchar } from 'drizzle-orm/pg-core'
import { agents } from './agents.js'
import { submissions } from './submissions.js'

/**
 * A capability the Colony has verified an agent holds (D-030).
 *
 * This table is what replaced `agents.level` as the answer to *"what may this
 * agent attempt?"*. A level was a synthesised position in an order nobody could
 * audit; a row here says which submission earned which skill and when, so the
 * question *"why does this agent hold `github`?"* has an answer that can be
 * joined back to a verdict.
 *
 * **A join table rather than an array column on `agents`**, which is the
 * opposite of what `roles` does two files over — and the difference is the
 * provenance. A role is conferred; a skill is *earned by a specific pass*, and
 * an array column has nowhere to put the submission that earned it. The set is
 * also queried from both directions here: which skills an agent holds, and
 * (for the frontier) which agents hold one.
 *
 * `skill` is a validated slug and not an enum column, mirroring `tasks.type` and
 * D-007: the vocabulary grows every time the Academy learns to verify something
 * new, and a new skill must not be a migration. The regex restates
 * `SKILL_PATTERN` from core in SQL, for the same reason and with the same test
 * asserting the two agree.
 */
export const agentSkills = pgTable(
  'agent_skills',
  {
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    skill: varchar('skill', { length: 64 }).notNull(),

    /**
     * The passed submission this skill was granted for.
     *
     * `not null`, so a skill always names the submission that earned it: a
     * capability whose provenance has been removed is a capability the Colony
     * cannot explain, and it gates everything the agent does afterwards. That is
     * the same argument `academy-tasks.ts` makes about never deleting a task row.
     *
     * **`cascade` stated explicitly, where this used to have no delete rule at
     * all.** The default is `no action`, which happens to survive an erasure —
     * both this row and the submission cascade from the same agent, and
     * `no action` is checked at the end of the statement by which time both are
     * gone. Relying on that would be relying on an accident: the identical
     * arrangement with `restrict` (`reputation_events.submission_id`, before
     * `#90`) aborts the erasure, and nothing in an unwritten default says which
     * of the two a reader is looking at. Writing it down costs a word and means
     * the row's fate is decided here rather than by Postgres' check timing.
     *
     * **Nullable since `#504`, for exactly one skill and checked as such.** D-106
     * grants `transfer` for paying a quest invoice, and paying is not a
     * submission — there is no task, no attempt and no verifier, because the
     * proof *is* the transaction. Rather than invent a submission to point at,
     * the column admits the one case and
     * `agent_skills_submission_unless_demonstrated` refuses every other. The
     * invariant this comment opens with is unchanged for the twenty-odd skills
     * that still earn their way through the Academy; what changed is that one
     * capability is now demonstrated rather than assessed.
     */
    submissionId: uuid('submission_id').references(() => submissions.id, { onDelete: 'cascade' }),

    grantedAt: timestamp('granted_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /**
     * **The primary key is what makes granting idempotent.**
     *
     * One row per (agent, skill), so re-passing a task grants nothing new and
     * the second grant is not an error — the insert says `on conflict do
     * nothing` and the database, not the caller, is what decides there is
     * already one. A skill held twice is not a stronger skill, and a caller
     * that had to check first would be racing itself.
     */
    primaryKey({ columns: [table.agentId, table.skill] }),
    /**
     * A skill names the submission that earned it, unless it is one the Colony
     * grants for an act that is not a submission (`#504`).
     *
     * **The exception is a list in the database rather than a rule in code**, so
     * a second skill cannot join it by a caller forgetting to pass an id. Adding
     * one is a migration, which is the friction this deserves: provenance is
     * what makes a capability explainable.
     */
    check(
      'agent_skills_submission_unless_demonstrated',
      sql`${table.submissionId} is not null or ${table.skill} in ('transfer')`,
    ),
    check('agent_skills_skill_slug', sql`${table.skill} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    check('agent_skills_skill_min_length', sql`char_length(${table.skill}) >= 3`),
    /** Who holds this skill — the direction the primary key cannot answer. */
    index('agent_skills_skill_idx').on(table.skill),
  ],
)
