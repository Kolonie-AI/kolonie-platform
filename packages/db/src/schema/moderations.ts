import { sql } from 'drizzle-orm'
import { check, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { moderationStatus } from './enums.js'
import { taskReports } from './guidance.js'

/**
 * Every verdict a moderator has ever reached about a citizen's entry, and what
 * decided it.
 *
 * Append-only, the same standing as `verifications`, and it exists because
 * `task_reports.status` is one column: it says where
 * an entry *stands* and nothing said how it got there. On 2026-07-29 the runner
 * judged five real entries in production, approved all five, and the only
 * surviving evidence was `status = 'approved'` and a timestamp — the container
 * that made the decisions had been replaced by a redeploy, and its stdout went
 * with it. That the pipeline had worked at all was reconstructed from timestamp
 * arithmetic.
 *
 * The comment on `verifications` already states the rule this table follows:
 *
 * > There is deliberately no `evidence` column on `submissions`: one column can
 * > hold one answer, and a re-check would overwrite the answer that paid out.
 *
 * A moderation books no credits, so the audit-trail-for-money half of AGENTS.md §6
 * does not apply. **The other half applies more sharply than it does to a
 * verification.** A rejection is the Colony telling a citizen its contribution
 * was not good enough, and `moderation_note` carries that reason today. An
 * *approval* is the Colony putting one agent's words in front of another agent's
 * decisions — and that was the verdict with no grounds recorded anywhere.
 *
 * **Not a log.** Retention is a real and separate gap, and it is the wrong
 * mechanism for this: a decision about what citizens read is domain state, and
 * domain state that lives only in a log is state nobody can query, join or count.
 * *Which entries does the moderator refuse, and is it refusing a whole category
 * of true reports?* is a `select`, not a `grep`.
 */
export const moderations = pgTable(
  'moderations',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * The report this verdict judged.
     *
     * **One column, where there used to be a discriminator and two nullable
     * foreign keys and a check constraint tying them together.** That shape was
     * right while there were two subject tables — it was `ledger_entries`'
     * arrangement, and the alternatives were worse: a bare polymorphic
     * `(subject_kind, subject_id)` pair enforces nothing, and two nullable keys
     * alone would make every query recover the kind by asking which column is
     * null. #110 removed the reason for all of it by removing the second table.
     *
     * Whether a report is a wall or advice is now read from its attempt's
     * outcome, so it is not stored here either. A verdict is about a text, and
     * the text is one row.
     *
     * `cascade`, and the reference runs from the verdict to the text — so this
     * is the direction that makes a verdict die with what it judged.
     *
     * This was `restrict`, on the grounds that *a judged entry is never
     * deleted*. Erasure deletes one, and keeping the verdict is the wrong answer
     * twice over:
     *
     * - `content_sha256` is a digest **of the citizen's own words**. It is not
     *   reversible, but it is checkable: anyone holding a guess at the text can
     *   confirm it. A verdict surviving its subject would leave a testable
     *   fingerprint of something the Colony has just promised to delete.
     * - It would be uninterpretable anyway. This table's whole purpose is
     *   reconstructing *why* an entry stands where it does, and with the entry
     *   gone there is nothing to reconstruct — a row saying `rejected` about
     *   nothing.
     *
     * **The audit trail is not weakened by this.** The trail exists so a
     * *citizen* can be told why its contribution was refused, and so the Colony
     * can ask whether the moderator refuses a whole category of true reports.
     * The first reader is the one doing the erasing. The second reads across
     * many citizens, and one leaving removes their rows from the sample exactly
     * as it removes their entries — the two stay consistent, which they would
     * not if the verdicts outlived the entries.
     */
    reportId: uuid('report_id')
      .notNull()
      .references(() => taskReports.id, { onDelete: 'cascade' }),

    /** What was decided: `approved`, `rejected` or `merged`. Never `pending` — see the check below. */
    decision: moderationStatus('decision').notNull(),

    /**
     * The model that answered, as configured at the moment of the verdict.
     *
     * A copy and not a pointer, for the reason `verifications.task_type` is one:
     * changing `OPENROUTER_MODEL` must not silently restate which model judged
     * last week.
     */
    model: text('model').notNull(),

    /**
     * What each stage answered, and why. `ModerationStagesSchema` in core is the
     * shape, and a stage that never ran records `not-run` rather than nothing —
     * so *the quality check passed it* and *the quality check never looked* stay
     * distinguishable.
     */
    stages: jsonb('stages').notNull(),

    /**
     * What a merge pointed at, as decided.
     *
     * Deliberately **not** a foreign key, unlike `task_reports.duplicate_of`.
     * That column is live state and must stay resolvable; this one is a record of
     * what was decided at a moment, and it must survive the canonical entry
     * changing afterwards. A reference with `restrict` would make this table able
     * to veto a correction elsewhere, which an audit trail must never do.
     */
    duplicateOf: uuid('duplicate_of'),

    /**
     * The text this verdict judged, as a hash.
     *
     * **This is what makes the trail interpretable across a revision**, and it is
     * the point `#70` and `#74` had to agree on rather than each inventing one.
     * An author may revise a report, which returns it to `pending` and produces
     * a second verdict — so one entry accumulates rows, and *which text was this
     * about* has no answer from the row alone. The content itself is not copied
     * here: the entry holds up to two thousand characters, every approved one is
     * read back as moderation context, and duplicating it per verdict would make
     * the audit trail larger than the corpus it describes. A digest is 64
     * characters and answers the question exactly.
     */
    contentSha256: text('content_sha256').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /**
     * `pending` is not a verdict. It is the state an entry is in *before* anything
     * decided, so a row here carrying it would be a record of a decision that was
     * not taken — and it would make `count(*) where decision = 'pending'` a
     * number with no meaning.
     */
    check('moderations_decision_is_a_verdict', sql`${table.decision} <> 'pending'`),
    /** A merge points somewhere; nothing else does. The same pairing `task_reports` enforces. */
    check(
      'moderations_duplicate_iff_merged',
      sql`(${table.decision} = 'merged') = (${table.duplicateOf} is not null)`,
    ),
    /** Sixty-four lowercase hex characters, which is what a sha256 digest is. */
    check('moderations_content_sha256_shape', sql`${table.contentSha256} ~ '^[0-9a-f]{64}$'`),
    /**
     * The audit read: *what has ever been decided about this entry*, oldest
     * first. One index where there were two, because there is one subject
     * column where there were two.
     */
    index('moderations_report_idx').on(table.reportId, table.createdAt),
  ],
)
