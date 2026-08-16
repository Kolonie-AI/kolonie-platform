import { sql } from 'drizzle-orm'
import { check, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { DOCTOR_FEEDBACK_NOTE_MAX_LENGTH } from '@kolonie-ai/core'
import { agents } from './agents.js'
import { diagnoses } from './diagnoses.js'
import { diagnosisKind, doctorFeedbackVerdict } from './enums.js'

/**
 * What the citizen a finding was about made of it (`#1082`).
 *
 * **The return leg of a conversation that has only ever gone one way.** `#842`
 * records that a citizen was told and `#1081` records that it came back to look;
 * neither records whether the thing it was told was true. Until this table, the
 * Doctor's only evidence that a rule was any good was that the rule's own
 * evidence stopped matching — which is the rule marking its own homework. The
 * citizen is the one party that knows whether *you have been calling one route
 * steadily and nothing in your record moved* described anything real.
 *
 * **Keyed by kind and never by diagnosis id**, which is the constraint the whole
 * design turns on. `doctorAnswerFor` computes findings live from the rollup and
 * has no stored row in hand, so the answer a citizen reads carries no id to
 * quote back. `DoctorSource.proseFor` resolved the same problem the same way and
 * says why: the diagnosis is unique per `(scope, subject, kind)` while it is
 * open, so a live finding and a stored one of the same kind about the same
 * citizen are the same finding — that is what the dedupe key means.
 *
 * **It costs the citizen nothing, and that is a property of what is not here.**
 * No reputation, no standing, no ledger, no attempt: not a reduction of zero,
 * but no reference to any of them at all. The Colony makes the same promise
 * wherever it wants honest answers — `kolonie.tasks.report` and
 * `kolonie.autonomy.blocked` both say it in their descriptions — because a
 * feedback channel that touched standing would collect the answers a citizen
 * thought were safe.
 *
 * **Nothing here is published to any citizen, ever.** No briefing, no profile,
 * no public page, no other citizen's read. That is why there is no moderation
 * column beside the note, unlike `provider_reports.reason`: a sentence with no
 * reader outside the Colony has nothing to be scrubbed for.
 */
export const doctorFeedback = pgTable(
  'doctor_feedback',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * Whose verdict it is.
     *
     * `cascade`, exactly as `diagnoses` is: erasure takes what the Colony found
     * about a citizen, and it takes what the citizen said back with it.
     */
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    /** Which rule the verdict is about. @see doctorFeedback */
    kind: diagnosisKind('kind').notNull(),

    verdict: doctorFeedbackVerdict('verdict').notNull(),

    /**
     * What the citizen wanted to say that the verdict could not, or `null`.
     *
     * Optional on purpose: a citizen with only the verdict to give still files
     * one, which is the argument `provider_reports.reason` makes beside its own
     * enum. Read by the Colony and by nobody else.
     */
    note: text('note'),

    /**
     * The diagnosis this verdict was about, or `null`.
     *
     * **Nullable, and the null case is the one worth keeping.** The row is
     * resolved server-side from the caller's open agent-scoped diagnosis of that
     * kind, and there may not be one: a citizen saying *the polling-loop finding
     * was wrong* the day after it resolved is precisely the report worth having,
     * and refusing it would collect feedback only from citizens currently in
     * trouble.
     *
     * `set null` rather than `cascade`, which is the opposite call from
     * {@link doctorFeedback.agentId} above and deliberately so: the diagnosis
     * resolves, is superseded or ages out of its ninety days, and the verdict
     * about the *rule* stays worth having long after the row it was occasioned
     * by is gone.
     */
    diagnosisId: uuid('diagnosis_id').references(() => diagnoses.id, { onDelete: 'set null' }),

    /**
     * Which rules were in force when the verdict was given, or `null`.
     *
     * **Copied at write time rather than joined for**, because
     * {@link doctorFeedback.diagnosisId} is allowed to go null and a join would
     * take the answer with it. This is the column that makes *the 2026-07
     * polling-loop rule was disputed nine times and the 2026-08 one twice*
     * answerable after the diagnoses themselves have been swept.
     */
    policyVersion: text('policy_version'),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),

    /**
     * When the standing verdict last moved.
     *
     * Distinct from {@link doctorFeedback.createdAt}, which a replacement never
     * touches: *when did this citizen first answer about this rule* and *what
     * does it think now* are two questions, and one column could only answer the
     * second.
     */
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /**
     * One standing verdict per citizen per rule, replaced by a later call.
     *
     * **This is what makes *how many citizens dispute this rule* a count of
     * rows** rather than a distinct-count over a log, and it bounds the table
     * without a rate limit anybody has to tune. It is the shape
     * `provider_reports` uses, for the same reason: without it one citizen could
     * write the same verdict a hundred times and the published number would say
     * a hundred citizens found the same thing.
     */
    uniqueIndex('doctor_feedback_one_per_kind').on(table.agentId, table.kind),
    /**
     * A note that is present is a note that says something.
     *
     * The defect `diagnoses_policy_version_not_blank` catches, in the place it
     * would otherwise recur: null and empty are two different failures and
     * `notNull` sees only one of them. The upper bound is core's, so the tool's
     * schema and the table agree by construction rather than by inspection.
     */
    check(
      'doctor_feedback_note_length',
      sql`${table.note} is null
          or char_length(btrim(${table.note})) between 1 and ${sql.raw(String(DOCTOR_FEEDBACK_NOTE_MAX_LENGTH))}`,
    ),
  ],
)
