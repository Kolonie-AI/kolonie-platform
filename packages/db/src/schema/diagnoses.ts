import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { agents } from './agents.js'
import { diagnosisKind, diagnosisScope, diagnosisSeverity, diagnosisState } from './enums.js'
import { supportTickets } from './support.js'

/**
 * What the Doctor found, with a life longer than the request that computed it
 * (`#838`).
 *
 * **Without this table the Doctor cannot say *again* and cannot say *still*.**
 * Neither is expressible over a live computation: recurrence is a counter on a
 * row, not a pile of rows to group afterwards, and *this finding has been true
 * since Tuesday* needs a first-seen stamp that a re-computation does not have.
 * Re-evaluation and audit need the same thing for the same reason.
 *
 * **It is written so that `kolonie-platform#814` does not have to be filed
 * against it.** That issue is the complaint that `quest_moderations` records
 * decisions nobody can read back, and `kolonie-docs#324` point 8 turns the
 * lesson into policy: *a diagnosis nobody can reconstruct is one nobody can
 * overturn.* So every column here exists to make one question a single read —
 * what was found, on what evidence, under which rules, and what did it cause.
 *
 * **One row per finding, not one per observation.** The dedupe key is
 * `(scope, subject, kind, policy_version)` while the row is `open`: same
 * citizen, same problem, same rules is one diagnosis with a counter on it. A
 * rule change opens a new one deliberately, because a finding made under
 * different arithmetic is a different judgement and updating the old row would
 * leave a history nobody can read.
 *
 * **Findings and sentences are kept distinguishable.** `prose` and `prose_model`
 * are nullable and their absence is the ordinary case — a gateway outage costs
 * the Colony a sentence and never a finding (`#840`). A reader months later can
 * tell *no model was asked* from *a model wrote this*, which matters because
 * only one of the two is a claim the Colony made itself.
 *
 * **Agent-scoped rows go with the citizen; colony-scoped rows stay.** An erased
 * citizen leaves no diagnosis behind — the cascade is what makes that true, and
 * `erasure.test.ts` asserts it. A colony-scoped row references no citizen at all
 * and is not personal data: *this route returns 500* is a fact about the Colony
 * that outlives everybody who happened to call it.
 */
export const diagnoses = pgTable(
  'diagnoses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scope: diagnosisScope('scope').notNull(),
    /**
     * The citizen, for an agent-scoped diagnosis — `null` for a colony-scoped
     * one.
     *
     * **Beside `subject` rather than instead of it, and the two are not
     * redundant.** This one is a foreign key and exists so the cascade can do
     * its work; `subject` is the dedupe key's text and holds a route for a
     * colony-scoped row, where a uuid column could hold nothing at all.
     */
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'cascade' }),
    /** The citizen's id or the route key — whichever this diagnosis is about. */
    subject: text('subject').notNull(),
    kind: diagnosisKind('kind').notNull(),
    severity: diagnosisSeverity('severity').notNull(),
    /** Between 0 and 1, computed by the rule. `real` because two decimals is the whole precision. */
    confidence: real('confidence').notNull(),
    /**
     * The rules' own numbers-only structure, verbatim.
     *
     * `jsonb` and *not* unschematised: the storage function parses it through
     * core's `EvidenceSchema` before it writes, so free text cannot reach this
     * column through any path. That is a rejection case with a test, and it is
     * not decoration — `#840` builds a model prompt from the typed finding, and
     * an evidence blob that could carry text would be a prompt with an author
     * other than the Colony.
     */
    evidence: jsonb('evidence').notNull(),
    /**
     * Which version of the rules produced this.
     *
     * **`notNull` plus a check that it is not empty**, because the two failures
     * are different and only one of them is caught by a null constraint. An
     * unattributable diagnosis is not storable, since it is not auditable.
     */
    policyVersion: text('policy_version').notNull(),
    state: diagnosisState('state').notNull().default('open'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    /** How many passes have found it. One at the moment it opens. */
    observations: integer('observations').notNull().default(1),
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'string' }),
    /** What a model wrote, or null. Stored verbatim and parsed back into nothing. */
    prose: text('prose'),
    /** Which model version wrote it. In the database, never in a committed file (`#207`). */
    proseModel: text('prose_model'),
    /**
     * The support ticket this diagnosis caused, or null.
     *
     * `set null` on delete rather than cascade: a deleted ticket must not take
     * the diagnosis with it, because the diagnosis is the record of *why* and
     * the ticket was only ever the consequence.
     */
    supportTicketId: uuid('support_ticket_id').references(() => supportTickets.id, {
      onDelete: 'set null',
    }),
    /**
     * When this citizen was last told about it on a waking, and at what severity
     * (`#842`).
     *
     * **On the row rather than in a process, so a restart cannot reset it.** The
     * pair is what makes *told and unchanged* distinguishable from *told and it
     * got worse*: the stamp alone would either re-announce every re-evaluation
     * or none of them, and both are wrong in the direction that costs the
     * channel its credibility.
     *
     * Null on a colony-scoped row and always will be — nothing announces those
     * to anybody, because there is nobody they are about.
     */
    announcedAt: timestamp('announced_at', { withTimezone: true, mode: 'string' }),
    /** @see announcedAt */
    announcedSeverity: diagnosisSeverity('announced_severity'),
  },
  (table) => [
    /**
     * The dedupe key, and it applies **only while the row is open** — which is
     * what the partial index says and a plain unique index could not.
     *
     * A citizen that looped in March, stopped, and loops again in August has two
     * diagnoses and should: they are separate episodes with separate evidence
     * windows, and merging them would make *first seen* a date from a different
     * story. What must never happen is two *open* rows for one problem, and that
     * is exactly what this refuses.
     */
    uniqueIndex('diagnoses_open_unique')
      .on(table.scope, table.subject, table.kind, table.policyVersion)
      .where(sql`${table.state} = 'open'`),
    /** *This subject's open diagnoses* — the read the runner and the citizen surface both make. */
    index('diagnoses_subject_idx').on(table.subject, table.state),
    /** *Open diagnoses, newest first* — the console's default view (`#841`). */
    index('diagnoses_open_idx').on(table.state, table.lastSeenAt.desc()),
    /** The erasure and retention reads, which are the only ones keyed on the citizen. */
    index('diagnoses_agent_idx').on(table.agentId),
    /**
     * A policy version that is present but empty is the same defect as one that
     * is absent, and `notNull` catches only the second.
     */
    check('diagnoses_policy_version_not_blank', sql`length(trim(${table.policyVersion})) > 0`),
    /**
     * An agent-scoped diagnosis names a citizen; a colony-scoped one does not.
     *
     * **In the schema rather than in the code that writes it**, because the
     * failure it prevents is the one this whole scope distinction exists for: a
     * colony-scoped row carrying a citizen would be a finding about the Colony
     * that quietly identifies somebody, and it would pass every test written
     * about scopes because it would still *say* `colony`.
     */
    check(
      'diagnoses_scope_names_its_subject',
      sql`(${table.scope} = 'agent' and ${table.agentId} is not null)
          or (${table.scope} = 'colony' and ${table.agentId} is null)`,
    ),
  ],
)
