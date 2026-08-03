import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { agents } from './agents.js'
import { submissions } from './submissions.js'

/**
 * What a steward found when it re-read one of the judge's verdicts (`#221`).
 *
 * ## Only the decisions are stored, never the selection
 *
 * There is no `sampled` column and no row per drawn submission. Which
 * submissions are in the sample is a **query** — `questAuditDraw` in core is a
 * deterministic map from the submission id to a fraction, and the same
 * expression in SQL selects the ones below the rate.
 *
 * That is not a saving, it is the property the issue asks for. *"A sample
 * selected afterwards is a sample somebody chose"* — and a stored selection is
 * one somebody could choose, by writing rows. A pure function of the submission
 * id cannot be influenced by the citizen, the sponsor or the steward, and
 * re-running it gives the same answer. It also lets the rate change without
 * re-drawing what was already drawn: raising a tenth to a fifth adds
 * submissions and removes none.
 *
 * ## A disagreement is a record and never a reversal
 *
 * Nothing here touches the ledger, the verdict or the submission. Reversing
 * would mean clawing back from a citizen that did what it was asked, on a second
 * opinion, with no process to contest it — a dispute surface nobody has
 * designed, opened by accident. What a disagreement does instead is **count**:
 * above a threshold over a rolling window, the Colony stops publishing paid
 * quests.
 */
export const questAudits = pgTable(
  'quest_audits',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * The verdict that was re-read.
     *
     * `cascade`: an audit of a submission that no longer exists is a record of a
     * decision about nothing, and the citizen it was about has been erased. The
     * disagreement *rate* survives as an aggregate over what remains, which is
     * the honest arithmetic — a departed citizen's report is no longer evidence
     * about the judge either way.
     */
    submissionId: uuid('submission_id')
      .notNull()
      .references(() => submissions.id, { onDelete: 'cascade' }),

    /**
     * The steward that read it.
     *
     * `set null` rather than cascade: the audit is a fact about the *judge*, and
     * losing every decision a departing steward made would rewrite the Colony's
     * measurement of its own model. Who read it stops being known; that it was
     * read does not.
     */
    stewardId: uuid('steward_id').references(() => agents.id, { onDelete: 'set null' }),

    /** Whether the steward reached the same verdict the judge did. */
    agrees: boolean('agrees').notNull(),

    /**
     * Why, in the steward's own words, and required in both directions.
     *
     * An agreement with no reason is a click, and a rate computed from clicks
     * measures nothing. `AuditDecisionSchema` in core enforces the length; this
     * enforces that there is one at all.
     */
    reason: text('reason').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check('quest_audits_reason_length', sql`char_length(${table.reason}) between 10 and 1000`),
    /**
     * One decision per verdict, in the database rather than in code.
     *
     * Two stewards opening the queue at once is the ordinary case, and the
     * second one's decision arriving as a silent second row would double-count
     * that verdict in the rate — in whichever direction the second steward went.
     */
    uniqueIndex('quest_audits_one_per_submission').on(table.submissionId),
    /** The rate: decisions inside the rolling window, grouped by agreement. */
    index('quest_audits_window_idx').on(table.createdAt, table.agrees),
  ],
)
