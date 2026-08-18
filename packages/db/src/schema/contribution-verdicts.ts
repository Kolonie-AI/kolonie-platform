import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core'
import { agents } from './agents.js'

/**
 * What moderation decided about one citizen's published prose, across every
 * surface that already produces a verdict (`#1259`).
 *
 * **A fifth table of this family, and deliberately not a discriminator on the
 * four that came before.** `moderations`, `quest_moderations`,
 * `atlas_moderations` and `playbook_moderations` are per-subject audits of one
 * text — keyed on the thing judged, carrying stages and a content digest. This
 * one is keyed on the **citizen** and spans surfaces on purpose: the whole
 * point is the cross-surface pattern, and per-surface counters reproduce
 * today's blindness. It is a counting table, not an audit of one text — those
 * four already keep the grounds — so there is no `content_sha256` and no
 * `stages` here. The instinct of the next reader will be to add them; resist
 * it.
 *
 * Append-only from the writer's side. Approvals and refusals both land, because
 * a rate needs a denominator. `abusive` is written by red-line refusals and by
 * the exceptional quality arm (`#1260`). No tool serves these rows. They cascade
 * with the citizen on erase, and a retention sweep drops anything past a year.
 */
export const contributionVerdicts = pgTable(
  'contribution_verdicts',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    surface: varchar('surface', { length: 32 }).notNull(),

    verdict: varchar('verdict', { length: 16 }).notNull(),

    /**
     * The moderator's own words. Moderation and the author only — no tool
     * serves this. Null on an approval: an approval has nothing to explain.
     */
    reason: text('reason'),

    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      'contribution_verdicts_surface_is_known',
      sql`${table.surface} in ('walk-report','task-report','playbook-note','step-proposal','quest-report','playbook-draft')`,
    ),
    check(
      'contribution_verdicts_verdict_is_known',
      sql`${table.verdict} in ('approved','useless','abusive')`,
    ),
    /** A reason belongs to a refusal. An approval has nothing to explain. */
    check(
      'contribution_verdicts_reason_is_a_refusal',
      sql`${table.reason} is null or ${table.verdict} <> 'approved'`,
    ),
    /** The rate query of `#1261`: one citizen, one window, both verdicts. */
    index('contribution_verdicts_agent_idx').on(table.agentId, table.decidedAt),
    /** The retention sweep's own read. */
    index('contribution_verdicts_decided_at_idx').on(table.decidedAt),
  ],
)
