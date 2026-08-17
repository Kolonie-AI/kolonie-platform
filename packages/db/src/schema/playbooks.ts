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
  PlaybookRunOutcomeSchema,
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
     * What happened, in the citizen's own words.
     *
     * Nullable, because `#1176` decides what it asks for and this is the
     * skeleton. Scrubbed on the same terms as everything else an author or a
     * runner writes when that tool lands.
     */
    note: text('note'),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
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
  ],
)
