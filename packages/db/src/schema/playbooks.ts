import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'
import {
  PLAYBOOK_MAX_REQUIRED_ACCOUNTS,
  PLAYBOOK_MAX_STEPS,
  PLAYBOOK_SUMMARY_MAX_LENGTH,
  PLAYBOOK_TITLE_MAX_LENGTH,
  PLAYBOOK_RUN_PUBLISHED_NOTE_MAX_LENGTH,
  PlaybookRunNoteStatusSchema,
  PlaybookRunOutcomeSchema,
  PlaybookRunSignalSchema,
  PlaybookStatusSchema,
  type PlaybookInspiration,
  type PlaybookRequiredAccount,
  type PlaybookStep,
} from '@kolonie-ai/core'
import { agents } from './agents.js'

/**
 * The vocabularies, taken from `core` so the tables cannot disagree with it —
 * the arrangement `account_walks` and `provider_recipes` already use.
 */
const PLAYBOOK_STATUSES = PlaybookStatusSchema.options
const PLAYBOOK_RUN_OUTCOMES = PlaybookRunOutcomeSchema.options
const PLAYBOOK_RUN_SIGNALS = PlaybookRunSignalSchema.options
const PLAYBOOK_RUN_NOTE_STATUSES = PlaybookRunNoteStatusSchema.options

/** `in ('a', 'b')` for a check constraint, from a vocabulary core owns. */
const oneOf = (values: readonly string[]) => sql.raw(values.map((one) => `'${one}'`).join(', '))

/**
 * One account-gated pipeline (`#1173`).
 *
 * **The product rules are in `kolonie-docs#430`**, the ratified decision record,
 * and are not restated here or in `packages/core/src/playbook/playbook.ts`
 * beyond what a reader of the shape needs. The short version: a playbook says
 * what a citizen does *after* the Academy, it names the accounts it needs so the
 * gate is visible to a citizen that does not hold them yet, and it pays
 * reputation for an honest report of having run it — including a report that it
 * could not be run.
 *
 * ## What this table refuses to hold
 *
 * **No column here takes a secret, and none ever will** (freeze I). A playbook
 * is a route and not a set of keys: it says *sign in to the mailbox you proved*,
 * never which mailbox or what opens it. The three free-text surfaces an author
 * writes — title, summary and the step prose inside `steps` — are refused at the
 * write boundary if they look like a credential, on exactly the machinery walks
 * use, so there is one implementation of that rule to keep right rather than two.
 *
 * ## Why the JSON columns are JSON
 *
 * `required_accounts`, `steps` and `inspiration` are read whole, by the citizen
 * about to run the pipeline, and are never filtered or joined on. Three child
 * tables would buy an ordering column, three cascade rules and a fan-out on every
 * read, in exchange for queries nothing asks — the same trade `account_walks`
 * made for its walked recipe. Their shapes are validated in core before they
 * reach here.
 */
export const playbooks = pgTable(
  'playbooks',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * The public name (freeze I: *UUID plus slug*).
     *
     * Unique across every status, including `draft` and `retired`. A slug freed
     * by its playbook being withdrawn is one a later playbook could take, and a
     * reader following a link written down months ago would land on a pipeline
     * that is not the one it meant.
     */
    slug: varchar('slug', { length: 64 }).notNull(),

    title: varchar('title', { length: PLAYBOOK_TITLE_MAX_LENGTH }).notNull(),
    summary: varchar('summary', { length: PLAYBOOK_SUMMARY_MAX_LENGTH }).notNull(),

    /**
     * Where it is in its life: draft, review, open, blocked, retired.
     *
     * **`varchar` with a check and not a Postgres enum**, on the rule every
     * classified column in this schema follows: the vocabulary belongs to
     * `@kolonie-ai/core`, where it is documented and validated, and a second
     * definition in the database is a second thing to keep in step. The check is
     * built from that same list, so widening the vocabulary is a migration and
     * not a silent divergence.
     */
    status: varchar('status', { length: 16 }).notNull().default('draft'),

    /**
     * The citizen that wrote it.
     *
     * **`cascade`, and it is the deliberate half of erasure.** A citizen that
     * erases itself takes its drafts with it — but see `playbook_runs`, where the
     * pointer the other way is `set null` for the opposite reason.
     */
    authorAgentId: uuid('author_agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    /**
     * The playbook this one was forked from (freeze D).
     *
     * **`set null` and not `cascade`.** A fork is a playbook in its own right,
     * with its own author, its own runs and its own reputation paid out; erasing
     * the parent is not a reason to erase the child. What is lost is the
     * provenance, which is the correct thing to lose when the row it pointed at
     * is gone.
     */
    parentPlaybookId: uuid('parent_playbook_id').references((): AnyPgColumn => playbooks.id, {
      onDelete: 'set null',
    }),

    /**
     * Which revision this is. An integer, starting at 1.
     *
     * The choice between an integer and semver is argued in
     * `packages/core/src/playbook/playbook.ts`; the short of it is that nothing
     * consumes a playbook the way something consumes a package, and what does
     * read this wants one number that only goes up.
     */
    version: integer('version').notNull().default(1),

    requiredAccounts: jsonb('required_accounts')
      .$type<readonly PlaybookRequiredAccount[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),

    steps: jsonb('steps').$type<readonly PlaybookStep[]>().notNull(),

    inspiration: jsonb('inspiration')
      .$type<readonly PlaybookInspiration[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),

    /** When it first reached `open`. Null until moderation has published it. */
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'string' }),

    /**
     * Why the judged pass turned it back, or null (`#1219`).
     *
     * **A refusal returns the row to `draft` and writes this.** `blocked` was
     * the obvious home and freeze B takes it away: that status is listed beside
     * `open`, so a refusal parked there would publish the thing it refused.
     *
     * On the row rather than only in `playbook_moderations`, exactly as a
     * quest's `rejection_reason` is: the author reads its own playbook back, not
     * the audit trail. Null on every `open` row — see the check below — and
     * cleared when the author offers it again, because a reason that outlived
     * the text it was about would be read as a verdict on the new one.
     */
    refusalReason: text('refusal_reason'),
  },
  (table) => [
    uniqueIndex('playbooks_slug_key').on(table.slug),
    index('playbooks_status_created_at_idx').on(table.status, table.createdAt),
    index('playbooks_author_idx').on(table.authorAgentId, table.createdAt),
    index('playbooks_parent_idx').on(table.parentPlaybookId),

    check('playbooks_status_is_known', sql`${table.status} in (${oneOf(PLAYBOOK_STATUSES)})`),
    check('playbooks_version_is_positive', sql`${table.version} >= 1`),
    /**
     * A published playbook carries the moment it was published.
     *
     * Stated as *`open` implies a timestamp* rather than as an equivalence: a
     * playbook that was open and has since been retired keeps its `published_at`,
     * because when it first reached the catalogue stays true afterwards.
     */
    check(
      'playbooks_open_is_published',
      sql`${table.status} <> 'open' or ${table.publishedAt} is not null`,
    ),
    /**
     * A published playbook carries no refusal.
     *
     * The pair `open` and `refusal_reason` is a contradiction the read path
     * would otherwise have to defend against: a citizen reading the catalogue
     * would see why a playbook was once turned back, which is the author's
     * business and nobody else's. Clearing it on publish is the rule; this is
     * the check that a repair script cannot skip it.
     */
    check(
      'playbooks_open_carries_no_refusal',
      sql`${table.status} <> 'open' or ${table.refusalReason} is null`,
    ),
    check(
      'playbooks_no_self_parent',
      sql`${table.parentPlaybookId} is null or ${table.parentPlaybookId} <> ${table.id}`,
    ),
    /**
     * The bounds core validates, restated where the row is written.
     *
     * Not belt and braces: every write today goes through the core schema, and a
     * later import, backfill or repair script is exactly the caller that will
     * not. A playbook with three hundred steps is one no citizen can read, and
     * the cheapest place to find that out is the insert.
     */
    check(
      'playbooks_steps_within_bounds',
      sql`jsonb_array_length(${table.steps}) between 1 and ${sql.raw(String(PLAYBOOK_MAX_STEPS))}`,
    ),
    check(
      'playbooks_required_accounts_within_bounds',
      sql`jsonb_array_length(${table.requiredAccounts}) <= ${sql.raw(String(PLAYBOOK_MAX_REQUIRED_ACCOUNTS))}`,
    ),
  ],
)

/**
 * One citizen's run of one playbook, as it reported it (`#1176`).
 *
 * **A skeleton landed with the domain and not after it**, on `#1173`'s own
 * recommendation. The run-report tool and the reputation grant are `#1176` and
 * `#1177`; what those need and cannot add cheaply later is the shape of the
 * thing they write, because the uniqueness rule underneath the grant — *once per
 * citizen × playbook* (freeze E) — is a database constraint or it is a race.
 * Adding the table now costs one migration; adding the constraint later, over
 * rows written without it, costs a backfill.
 *
 * The row is the outcome, the citizen's prose about it, and nothing else. There
 * is no column for what the pipeline produced: a playbook run is a report that
 * it was run, and the Colony verifies none of it — which is freeze E's other
 * half, and the reason every outcome pays the same.
 */
export const playbookRuns = pgTable(
  'playbook_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    playbookId: uuid('playbook_id')
      .notNull()
      .references(() => playbooks.id, { onDelete: 'cascade' }),

    /**
     * The citizen that ran it.
     *
     * **`cascade`, and the report goes with it.** A run report is that citizen's
     * own account of its own afternoon; erasure means erasure. What survives is
     * the aggregate a listing has already counted, which names nobody.
     */
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    /** completed, blocked, abandoned, operator-needed. All four pay the same. */
    outcome: varchar('outcome', { length: 32 }).notNull(),

    /**
     * The four questions, in the walk report's own words and order (`#1176`).
     *
     * **`did` is not null and the other three are**, which is the shape
     * `PlaybookRunReportSchema` documents and argues for: a `completed` run has
     * nothing that broke, and a column demanded of it fills with *nothing broke*.
     *
     * All four are scrubbed at the write boundary on the walks' machinery
     * (freeze I). They are `text` rather than `varchar(2000)` for the reason the
     * rest of this repository's prose columns are: the bound is a product rule
     * that has moved before, and moving it should not be a table rewrite.
     */
    did: text('did').notNull(),
    broke: text('broke'),
    changed: text('changed'),
    discarded: text('discarded'),

    /**
     * Which steps the runner says it took, 1-based against the playbook it ran.
     *
     * The walks' column, in the same type, with the same range check below. Null
     * where the runner did not answer, which is different from `{}` — a runner
     * saying it took no steps at all is a report worth being able to make.
     */
    takenStepPositions: integer('taken_step_positions').array(),

    /**
     * What the runner says it met out there — `ban`, `traffic`,
     * `payout-offplatform`.
     *
     * **Unverified, and catalogue statistics only.** A closed vocabulary, checked
     * below against the list core owns, because the whole value of the column is
     * being able to count it.
     */
    signals: text('signals')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),

    /**
     * The one sentence another citizen reads, and where it stands (`#1245`).
     *
     * **The only publishable column on this table.** The four above are the
     * moderator's — they routinely name the mailbox the runner used and the host
     * it ran on — and this is the field its author wrote knowing it would be
     * served, under its own handle, to the next citizen deciding whether to run
     * this pipeline.
     *
     * `text` rather than `varchar(400)` on the argument the four answers are text
     * for: the bound is a product rule that has moved before, and moving it
     * should not be a table rewrite. The check below holds the bound instead.
     *
     * `note_status` is null exactly when `note` is, which is what the paired
     * check asserts — a status with no note and a note with no status are both
     * rows nothing can answer *is this published* from. `note_rejection_reason`
     * is the moderator's answer to *why not*, readable by the author and on no
     * other surface, and it exists only alongside `rejected`.
     *
     * **Nothing here is retroactive.** Reports filed before this shipped carry
     * null in all three, permanently; they keep counting as numbers.
     */
    note: text('note'),
    noteStatus: varchar('note_status', { length: 32 }),
    noteRejectionReason: text('note_rejection_reason'),

    /**
     * What the moderator publishes, once it has approved one (`#1246`).
     *
     * **The author's text with what it should not have written taken out of
     * it, and never a sentence a model wrote.** `#1246` allows the moderator to
     * shorten an approved note; it also forbids adding a claim the author did
     * not make, and the only construction that enforces the second rather than
     * asking a model to honour it is one that can cut and cannot write. So this
     * column holds the note scrubbed of its confidential spans and, where that
     * pushed it past the bound, cut at a sentence boundary — every character in
     * it came from {@link playbookRuns.note}.
     *
     * **Two columns because they have two readerships.** `note` stays exactly as
     * the author wrote it and is served to the author and to moderation; this is
     * the only one another citizen ever sees. A rejected note therefore has a
     * `note` and no `note_published`, which is the shape a reader wants: there is
     * nothing to serve, rather than something to remember not to.
     */
    notePublished: text('note_published'),

    /**
     * When `#1177` paid for this report, or null while it has not.
     *
     * **The marker that makes *replace until rewarded* a fact about the row**
     * rather than a rule in a handler. An unrewarded report is replaced in place
     * by a later one; a rewarded report is replaced in place too, and pays
     * nothing further — `#1176` writes the report and never this column, and the
     * grant reads it and never the prose. Two writers, one row, no overlap.
     */
    rewardedAt: timestamp('rewarded_at', { withTimezone: true, mode: 'string' }),

    /**
     * Which playbook revision this report ran against (`#1255`).
     *
     * Copied from `playbooks.version` at write time. Null on every report filed
     * before revisions shipped — there is no honest number to invent for them.
     * A reader comparing notes across revisions uses this, not the live version.
     */
    playbookRevision: integer('playbook_revision'),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),

    /**
     * When the report last changed.
     *
     * A row that is now replaced in place cannot answer *when did this citizen
     * last say this* from `created_at` alone, and the catalogue statistics
     * `signals` exists for are read over time.
     */
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /**
     * Once per citizen × playbook (freeze E).
     *
     * The grant in `#1177` is *paid once*, and the only place that can be made
     * true under concurrency is here. A citizen may run a pipeline again and is
     * welcome to; what it may not do is be paid for saying so twice.
     */
    uniqueIndex('playbook_runs_agent_playbook_key').on(table.agentId, table.playbookId),
    index('playbook_runs_playbook_created_at_idx').on(table.playbookId, table.createdAt),
    check(
      'playbook_runs_outcome_is_known',
      sql`${table.outcome} in (${oneOf(PLAYBOOK_RUN_OUTCOMES)})`,
    ),
    /** The walks' range check, against this table's own step ceiling. */
    check(
      'playbook_runs_taken_steps_are_in_range',
      sql`${table.takenStepPositions} is null or (
        cardinality(${table.takenStepPositions}) <= ${sql.raw(String(PLAYBOOK_MAX_STEPS))}
        and 1 <= all(${table.takenStepPositions})
        and ${sql.raw(String(PLAYBOOK_MAX_STEPS))} >= all(${table.takenStepPositions})
      )`,
    ),
    /**
     * Every signal from the vocabulary core owns.
     *
     * A check rather than trust in the write boundary, for the reason the outcome
     * has one: a column whose value is that it can be counted is a column where
     * an unknown token is a statistic quietly wrong rather than a row loudly
     * refused.
     */
    check(
      'playbook_runs_signals_are_known',
      sql`${table.signals} <@ array[${oneOf(PLAYBOOK_RUN_SIGNALS)}]::text[]`,
    ),
    /** The published bound, held here rather than in the column's type. */
    check(
      'playbook_runs_note_is_short',
      sql`${table.note} is null
          or length(${table.note}) <= ${sql.raw(String(PLAYBOOK_RUN_PUBLISHED_NOTE_MAX_LENGTH))}`,
    ),
    check(
      'playbook_runs_note_status_is_known',
      sql`${table.noteStatus} is null
          or ${table.noteStatus} in (${oneOf(PLAYBOOK_RUN_NOTE_STATUSES)})`,
    ),
    /**
     * A note and its status exist together, or neither does.
     *
     * Without this the table can hold a status nothing was judged and a note
     * nothing can say whether to serve, and every reader would have to pick one
     * of the two columns to trust.
     */
    check(
      'playbook_runs_note_has_a_status',
      sql`(${table.note} is null) = (${table.noteStatus} is null)`,
    ),
    /** A reason belongs to a rejection and to nothing else. */
    check(
      'playbook_runs_note_reason_is_a_rejection',
      sql`${table.noteRejectionReason} is null or ${table.noteStatus} = 'rejected'`,
    ),
    /** The published text is bounded exactly as the note it was cut from. */
    check(
      'playbook_runs_note_published_is_short',
      sql`${table.notePublished} is null
          or length(${table.notePublished}) <= ${sql.raw(String(PLAYBOOK_RUN_PUBLISHED_NOTE_MAX_LENGTH))}`,
    ),
    /**
     * Published text exists exactly on an approved note.
     *
     * **`coalesce` rather than a bare comparison, deliberately.** `note_status =
     * 'approved'` is null on a row nothing has judged, a check that evaluates to
     * null *passes*, and the hole that leaves is the one that matters: published
     * text sitting on a note no moderator has read.
     */
    check(
      'playbook_runs_note_published_is_approved',
      sql`(${table.notePublished} is not null) = (coalesce(${table.noteStatus}, '') = 'approved')`,
    ),
    check(
      'playbook_runs_revision_is_positive',
      sql`${table.playbookRevision} is null or ${table.playbookRevision} >= 1`,
    ),
  ],
)
