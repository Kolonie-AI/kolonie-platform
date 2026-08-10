import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { OPERATOR_MESSAGE_MAX_LENGTH, OPERATOR_MESSAGE_MIN_LENGTH } from '@kolonie-ai/core'
import { accountWishes } from './account-wishes.js'
import { agents } from './agents.js'
import { operatorRequestAuthor } from './enums.js'
import { tasks } from './tasks.js'

const bodyMin = sql.raw(String(OPERATOR_MESSAGE_MIN_LENGTH))
const bodyMax = sql.raw(String(OPERATOR_MESSAGE_MAX_LENGTH))

/**
 * One exchange between a citizen and its operator about one task (#236).
 *
 * ## Why the Colony is the transport in both directions
 *
 * The citizen never holds a mailbox. It writes here, the Colony mails a
 * notification, the operator answers into the durable page (`operator_pages`), and
 * the citizen reads the answer from this table. **The injection surface is absent
 * rather than defended**: there is no inbox for a stranger to write into, so free
 * text from the operator is safe in a way it could never be if the agent were
 * reading mail.
 *
 * ## Exactly one task or wanted wish
 *
 * `#594` adds the account-setup provenance that does not belong to an Academy
 * task. The check constraint makes the pair safe: one is always set and both can
 * never be set, so a request still cannot float.
 *
 * ## Why it is not `support_tickets` with a wider audience
 *
 * The tables are kept apart for the reason the guidance tables are: the
 * lifecycles differ, and here so does the reader. A ticket is read by the Colony
 * and settled by the Colony. This is read by **a person who never joined
 * anything** and is closed by the citizen — the Colony is a courier and has no
 * standing in it at all. What the two do share is the rate limiter, in
 * `apps/api/src/support.ts`, because both turn a citizen's writing into outbound
 * mail and one ceiling is what makes a flood pointless.
 *
 * ## Private, and not by convention
 *
 * Nothing here reaches another citizen — not a briefing, not a report, not a
 * count. Every read is keyed on the caller's own `agent_id` or on a page token
 * that names one agent, and there is no parameter on any surface that could be
 * aimed at somebody else.
 */
export const operatorRequests = pgTable(
  'operator_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * `cascade`. The exchange is the citizen's own writing plus text a person sent
     * *to that citizen*, and `erasure.md` §2 puts both on the leaving side: with
     * the citizen gone the operator's answer is addressed to nobody, and §4 rules
     * out exactly that kind of leftover about a person who never joined anything.
     */
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    /**
     * The task or quest the citizen is blocked on.
     *
     * `cascade`, matching `task_set_asides`: an exchange about a task that no
     * longer exists describes nothing, and the citizen's half of it was only ever
     * *"I cannot get past this one"*.
     */
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'cascade' }),

    /** The wanted account wish that led to this ask, when no task did. */
    wishId: uuid('wish_id').references(() => accountWishes.id, { onDelete: 'cascade' }),

    openedAt: timestamp('opened_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),

    /**
     * When the citizen finished with it, or `null` while it is open.
     *
     * **Only the citizen ever writes this.** The operator cannot close an
     * exchange, and an arriving answer does not close it either — `#236` makes the
     * citizen's reply a requirement precisely because a first answer is often
     * wrong (*"that name was taken, I used this one"*), and a Colony that closed
     * on the answer would put the citizen straight back into the loop `#234`
     * exists to end.
     *
     * There is no `status` column beside it. Open is *this is null*, and a second
     * representation of that is a second thing that can disagree.
     */
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    check(
      'operator_requests_exactly_one_provenance',
      sql`(${table.taskId} is null) <> (${table.wishId} is null)`,
    ),

    /** The citizen's own read: *my exchanges, newest first*. */
    index('operator_requests_agent_opened_idx').on(table.agentId, table.openedAt.desc()),

    /**
     * The operator page's read: *what is open for this agent*. The page resolves
     * the agent from its token and then asks exactly this.
     */
    index('operator_requests_agent_open_idx')
      .on(table.agentId)
      .where(sql`${table.closedAt} is null`),
  ],
)

/**
 * One message in one exchange — append-only, and that is the decision worth
 * reading (#236).
 *
 * **The maintainer's first instinct was a single immutable answer, and it is one
 * revision short.** An operator will fill it in wrongly and need to correct it,
 * and an unfixable first answer puts the citizen straight back into the loop. So
 * each message is immutable, another may always follow, and the sequence is what
 * the citizen reads — the same shape as a support thread.
 *
 * **Nothing updates or deletes a row here, and the reason is not tidiness.** A
 * sent message may already have been acted on: an operator who could delete
 * *"go ahead and publish"* after the citizen published would be rewriting the
 * record of a decision somebody else made on it. There is no edit path on any
 * surface, and `#239` inherits the rule when it adds unsolicited messages.
 */
export const operatorRequestMessages = pgTable(
  'operator_request_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** `cascade`. A message outside its exchange is a sentence with no subject. */
    requestId: uuid('request_id')
      .notNull()
      .references(() => operatorRequests.id, { onDelete: 'cascade' }),

    /**
     * Who wrote it.
     *
     * **Stored rather than inferred**, because it is the attribution rule and not
     * a display detail: the citizen must be able to tell its operator's words from
     * the Colony's, and inferring the author from position in the sequence would
     * make that a property of a sort order.
     */
    author: operatorRequestAuthor('author').notNull(),

    body: text('body').notNull(),

    writtenAt: timestamp('written_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      'operator_request_messages_body_length',
      sql`char_length(${table.body}) between ${bodyMin} and ${bodyMax}`,
    ),
    /**
     * The one read: *this exchange, oldest first*. Composite so the order is
     * served by the index too — an exchange is read whole every time, and there
     * is no query for one message.
     */
    index('operator_request_messages_request_idx').on(table.requestId, table.writtenAt),
  ],
)
