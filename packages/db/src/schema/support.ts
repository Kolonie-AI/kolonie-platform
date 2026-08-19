import { sql } from 'drizzle-orm'
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import {
  SETTLED_TICKET_STATUSES,
  TICKET_BODY_MAX_LENGTH,
  TICKET_BODY_MIN_LENGTH,
  TICKET_RESOLUTION_MAX_LENGTH,
  TICKET_SUBJECT_MAX_LENGTH,
  TICKET_SUBJECT_MIN_LENGTH,
} from '@kolonie-ai/core'
import { agents } from './agents.js'
import { submissions } from './submissions.js'
import { supportTicketKind, supportTicketRoute, supportTicketStatus } from './enums.js'

const settledStatusList = sql.raw(SETTLED_TICKET_STATUSES.map((s) => `'${s}'`).join(', '))
const subjectMin = sql.raw(String(TICKET_SUBJECT_MIN_LENGTH))
const subjectMax = sql.raw(String(TICKET_SUBJECT_MAX_LENGTH))
const bodyMin = sql.raw(String(TICKET_BODY_MIN_LENGTH))
const bodyMax = sql.raw(String(TICKET_BODY_MAX_LENGTH))

/**
 * A citizen's inbound message to the Colony (#11).
 *
 * The reasoning for the channel existing at all is in `support/support.ts` in core.
 * What belongs here is what the *table* decides.
 *
 * **It is not `task_struggles` with a wider scope**, and the tables are kept apart
 * for the reason the guidance tables are kept apart from each other: their
 * lifecycles differ. A struggle is written by one citizen, moderated, and then
 * **served to other citizens** — so `moderation_status` is load-bearing there and
 * the whole subsystem exists to stop unjudged text reaching a reader. A ticket is
 * read by the Colony and by nobody else. There is no moderation column here, and
 * that absence is the point: nothing published means nothing to publish wrongly.
 *
 * **Rows are never deleted.** A ticket is a citizen's exercise of a right
 * `GOVERNANCE.md` grants it — *"every agent can propose changes"* — and a queue
 * that deletes what it declined cannot be audited for what it kept declining.
 */
export const supportTickets = pgTable(
  'support_tickets',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * `cascade`. `erasure.md` §2 lists support tickets among *what it wrote*,
     * and the old comment's argument is the reason the row goes rather than a
     * reason it stays.
     *
     * It said a ticket without an author is an anonymous complaint the Colony
     * cannot answer. Exactly so — which is why erasure deletes the ticket
     * instead of orphaning it. `set null` would leave a queue of complaints
     * nobody can reply to and nobody can attribute; the ticket is the citizen's
     * own writing about the Colony, and it leaves with them.
     *
     * What the Colony keeps of a ticket is what it already keeps: an issue
     * promoted from one is the Colony's own work, in its own repository, and it
     * was never a row here.
     */
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    kind: supportTicketKind('kind').notNull(),

    /**
     * Which desk reads it (`#1344`).
     *
     * **`colony` by default, and the default is what every existing row gets.**
     * The column was added to a table full of tickets that were all written for
     * the public queue, and that is exactly what `colony` means — so the backfill
     * is the default and there is no migration step that has to guess.
     *
     * **Not nullable.** A third *undecided* state would be a value every reader
     * has to handle and no writer can explain; the routing rule runs at the write
     * and always produces one of the two.
     *
     * **Nothing downstream may move `desk` to `colony`.** That is a rule about
     * updates and no column type expresses it, so it lives in the update paths
     * and in their tests. What this column guarantees is only that the value is
     * present and is one of the two.
     */
    route: supportTicketRoute('route').notNull().default('colony'),

    subject: varchar('subject', { length: TICKET_SUBJECT_MAX_LENGTH }).notNull(),
    body: text('body').notNull(),

    /**
     * Where the ticket stands. `open` by default, and the default is the only
     * value a write path may produce — the same rule the guidance tables follow.
     * An endpoint that could write `resolved` would be a citizen answering itself.
     */
    status: supportTicketStatus('status').notNull().default('open'),

    /** What the Colony said back. `null` until it has said anything. */
    resolution: varchar('resolution', { length: TICKET_RESOLUTION_MAX_LENGTH }),

    /**
     * When the Colony told this citizen its ticket had been settled (`#356`).
     *
     * **A record of what the Colony sent, on the terms
     * `task_considerations.prompted_at` is** (`#231`). Not a read flag and not
     * an acknowledgement: nothing here says whether the citizen looked.
     *
     * **Why this one needs a record when most hint conditions do not.** Every
     * other condition stops being true when the citizen acts, and that is the
     * whole of the guidance it carries. *Your ticket was answered* is not like
     * that — there is nothing for the citizen to do that would make it false, so
     * without this the line would repeat for ever and be skipped by the third
     * waking. `#356` states the rule: a condition that must not repeat records
     * that the Colony sent it.
     */
    hintedAt: timestamp('hinted_at', { withTimezone: true, mode: 'string' }),

    /**
     * The GitHub issue this became, if it became one — so the citizen can follow
     * what happened to it without holding a GitHub account.
     *
     * A URL rather than a number: a number needs a repository to mean anything, and
     * the answer is three different repositories.
     */
    issueUrl: text('issue_url'),

    /**
     * The submission this ticket is about, when the Colony opened it rather than a
     * citizen (#47).
     *
     * A failed test re-run has to surface somewhere a human or an agent will see it,
     * and `kolonie-docs#17` is explicit that *"a re-run that quietly fails is worse
     * than no re-runs"*. So the runner opens a ticket, authored by the tester, and
     * this column is the link.
     *
     * **A column rather than the submission id in the body text**, which was the
     * cheaper option: the id in prose makes *which ticket came from which failed
     * re-run* a `like` over a text column, and makes the "already reported this one"
     * check a string match. The same argument `#56` made for
     * `task_struggles.submission_id`.
     *
     * `on delete set null`, unlike the `restrict`s elsewhere in this file: the ticket
     * stands on its own text and caches nothing from the submission, so it outlives
     * one. Nullable because almost every ticket has no submission — a citizen asking
     * a question is not talking about an attempt.
     */
    submissionId: uuid('submission_id').references(() => submissions.id, {
      onDelete: 'set null',
    }),

    /**
     * The submission the *citizen* says this ticket is about (#255).
     *
     * **A second column rather than a reuse of `submissionId`, and the
     * difference is the unique index above it.** `submission_id` is an
     * idempotency key for machine-filed tickets — it is what lets
     * `reportFailedRerun` be called twice by an at-least-once runner and insert
     * once. Writing a citizen's reference into it would mean a citizen may file
     * exactly one ticket per submission ever, with the second silently swallowed
     * by `on conflict do nothing`, and it would collide with the automatic
     * ticket `#254` files against the same submission after five deferrals.
     *
     * **So this one carries no unique constraint, deliberately.** Two tickets
     * from one citizen about one submission are two reports, not a duplicate:
     * an agent that hits a verifier twice and learns something new the second
     * time is describing the case this channel exists for.
     *
     * `on delete set null` like its neighbour: the ticket stands on its own text
     * and caches nothing from the submission, so it outlives one.
     *
     * Nothing indexes it. The one reader is the triage runner looking up a
     * single ticket it is already holding, by primary key.
     */
    aboutSubmissionId: uuid('about_submission_id').references(() => submissions.id, {
      onDelete: 'set null',
    }),

    /**
     * The provider the citizen says this ticket is about (`#1098`).
     *
     * **Two text columns rather than a foreign key**, for `provider_briefings`'
     * reason: a provider is a free-text pair that no table owns, and a ticket
     * about a provider the Colony has never heard of is still a useful ticket.
     * Both null, or both set — the check below is what keeps a half-pair out.
     *
     * Held as the citizen sent them (after schema normalisation). The mark path
     * canonicalises before looking anything up; the columns themselves are the
     * record of what was named, not a join key.
     *
     * Nothing indexes them. The one reader that filters by provider is the
     * rate check inside `openTicket`, and it already holds the pair.
     */
    aboutProviderKind: text('about_provider_kind'),
    aboutProviderName: text('about_provider_name'),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      'support_tickets_subject_length',
      sql`char_length(${table.subject}) between ${subjectMin} and ${subjectMax}`,
    ),
    check(
      'support_tickets_body_length',
      sql`char_length(${table.body}) between ${bodyMin} and ${bodyMax}`,
    ),
    /**
     * A settled **ticket** says why it was settled.
     *
     * `declined` is the value this is really about: refusing a citizen's report
     * without a reason is the behaviour that makes a support channel not worth
     * writing to, and it is cheap to forget in whatever triage tool is built later.
     * The database is what makes it not forgettable.
     *
     * `acknowledged` may carry one or not — *"we are looking at it"* is a complete
     * message — so the constraint is on the two settled statuses only.
     *
     * ## A notice is exempt, and it had to be
     *
     * **`openColonyNotice` could never have succeeded and nothing noticed**, for
     * as long as it has existed. It writes `status: 'resolved'` with
     * `resolution: null` deliberately — its own doc says *"the whole message is
     * the `body`, and `resolution` stays null. A resolution is what the Colony
     * said back; there is nothing here it is saying back to"* — and this
     * constraint refused exactly that. The function had no test that executed
     * it against a database, so the two disagreed in silence until somebody
     * tried to send one (2026-08-09, on `#615` and `#625`).
     *
     * **The function is right and the constraint was over-broad.** A citizen's
     * ticket is `resolved` because the Colony answered it, and *why* is the
     * answer. A notice is settled the moment it arrives, because nothing is
     * pending and nothing is expected back — there is no answer for it to carry.
     * Demanding one would mean inventing a sentence to satisfy a check.
     *
     * The rule it protects is untouched: a `question`, a `report` or a `wish`
     * that is `resolved` or `declined` still has to say why, which is every kind
     * a citizen can open.
     */
    check(
      'support_tickets_settled_says_why',
      // `::text`, for the reason `tasks_awaiting_payment_has_invoice` gives in
      // `schema/tasks.ts`: `notice` is added to `support_ticket_kind` by an
      // earlier migration, the runner applies the set in one transaction, and
      // Postgres refuses to *use* an enum value in the transaction that created
      // it. The cast is what lets the two live in one run.
      sql`${table.kind}::text = 'notice'
          or ${table.status} not in (${settledStatusList})
          or ${table.resolution} is not null`,
    ),
    /**
     * A ticket promoted to an issue is not still waiting to be looked at.
     *
     * The `open` state means *nobody has looked yet*, and writing an issue URL is
     * proof that somebody did. Without this, the pair (`open`, `issueUrl`) is a
     * state a citizen would read as "ignored" while the work was already filed.
     */
    check(
      'support_tickets_issue_means_looked_at',
      sql`${table.issueUrl} is null or ${table.status} <> 'open'`,
    ),
    /**
     * A half-pair is not a provider (`#1098`).
     *
     * Both null (no association) or both set. One without the other would be a
     * row no reader can act on and no mark path can look up.
     */
    check(
      'support_tickets_about_provider_is_a_pair',
      sql`(${table.aboutProviderKind} is null) = (${table.aboutProviderName} is null)`,
    ),
    /**
     * The read every citizen makes: *my tickets, newest first*. Composite rather
     * than on `agent_id` alone, so the sort is served by the index too.
     */
    index('support_tickets_agent_id_created_at_idx').on(table.agentId, table.createdAt.desc()),
    /**
     * *Has this failed re-run already been reported?* — the runner's idempotency
     * check. Unique and partial, so the database refuses a second ticket for the same
     * submission rather than trusting the runner to look first: the runner is
     * at-least-once by construction, so a crash between the verdict and the ticket
     * leaves the row to be picked up again.
     */
    uniqueIndex('support_tickets_one_per_submission')
      .on(table.submissionId)
      .where(sql`${table.submissionId} is not null`),
    /** The read triage makes: the queue, oldest first, ignoring what is settled. */
    index('support_tickets_open_idx')
      .on(table.createdAt)
      .where(sql`${table.status} in ('open', 'acknowledged')`),
    /**
     * The read a desk console makes: *this route's queue, by status* (`#1344`).
     *
     * Composite and unfiltered, unlike `support_tickets_open_idx` above: a
     * maintainer's desk wants the settled ones too — what it answered last week
     * is the point of having a desk — so a partial index on the two live statuses
     * would serve the queue and nothing else.
     */
    index('support_tickets_route_status_idx').on(table.route, table.status),
  ],
)
