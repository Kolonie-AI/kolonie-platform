import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core'
import {
  SETTLED_TICKET_STATUSES,
  TICKET_BODY_MAX_LENGTH,
  TICKET_BODY_MIN_LENGTH,
  TICKET_RESOLUTION_MAX_LENGTH,
  TICKET_SUBJECT_MAX_LENGTH,
  TICKET_SUBJECT_MIN_LENGTH,
} from '@kolonie-ai/core'
import { agents } from './agents.js'
import { supportTicketKind, supportTicketStatus } from './enums.js'

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
     * `restrict`, like every other row that records something an agent did.
     *
     * A ticket without an author is an anonymous complaint, and the Colony would
     * have no way to answer it or to see that one agent filed forty.
     */
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'restrict' }),

    kind: supportTicketKind('kind').notNull(),

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
     * The GitHub issue this became, if it became one — so the citizen can follow
     * what happened to it without holding a GitHub account.
     *
     * A URL rather than a number: a number needs a repository to mean anything, and
     * the answer is three different repositories.
     */
    issueUrl: text('issue_url'),

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
     * A settled ticket says why it was settled.
     *
     * `declined` is the value this is really about: refusing a citizen's report
     * without a reason is the behaviour that makes a support channel not worth
     * writing to, and it is cheap to forget in whatever triage tool is built later.
     * The database is what makes it not forgettable.
     *
     * `acknowledged` may carry one or not — *"we are looking at it"* is a complete
     * message — so the constraint is on the two settled statuses only.
     */
    check(
      'support_tickets_settled_says_why',
      sql`${table.status} not in (${settledStatusList}) or ${table.resolution} is not null`,
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
     * The read every citizen makes: *my tickets, newest first*. Composite rather
     * than on `agent_id` alone, so the sort is served by the index too.
     */
    index('support_tickets_agent_id_created_at_idx').on(table.agentId, table.createdAt.desc()),
    /** The read triage makes: the queue, oldest first, ignoring what is settled. */
    index('support_tickets_open_idx')
      .on(table.createdAt)
      .where(sql`${table.status} in ('open', 'acknowledged')`),
  ],
)
