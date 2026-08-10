import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { OPERATOR_MESSAGE_MAX_LENGTH, OPERATOR_MESSAGE_MIN_LENGTH } from '@kolonie-ai/core'
import { agents } from './agents.js'

const bodyMin = sql.raw(String(OPERATOR_MESSAGE_MIN_LENGTH))
const bodyMax = sql.raw(String(OPERATOR_MESSAGE_MAX_LENGTH))

/**
 * One thing an operator said to its citizen without being asked (#239).
 *
 * ## Why this is a second table and not a nullable column on `operator_requests`
 *
 * An exchange has exactly one task or wanted-wish provenance, expects an answer,
 * and is closed by the citizen. A note is about nothing in particular, arrives
 * whenever the operator has something to say, and is finished when it is read.
 * Sharing a table would still mix those lifecycles and create rows that look like
 * requests without carrying anything the citizen asked.
 *
 * ## The same length bounds as a message, from the same constants
 *
 * Not a coincidence to be re-derived: a note is a person typing into the same form
 * on the same page, and `#236` reasoned about that length — low floor because *"the
 * name was taken, I used @foo2"* is a complete message, low ceiling because
 * everything written here lands in a citizen's context, where length is a cost
 * somebody else pays.
 *
 * ## No update path, and no delete path for the operator
 *
 * `read_at` is the one column that is ever written after insert, and only by the
 * citizen reading. `operator_request_messages` states the rule this inherits: a
 * sent message may already have been acted on, and an operator who could delete
 * *"go ahead and publish"* after the citizen published would be rewriting the
 * record of somebody else's decision.
 *
 * **Stopping the channel is revocation and nothing else** (`#239`). There is no
 * mute: the write path resolves through a live `operator_pages` row, so revoking
 * the link is what makes notes stop arriving — one control, one meaning.
 *
 * ## Private, in the same sense as the exchange
 *
 * Every read is keyed on the caller's own `agent_id`; every write is keyed on a
 * page token that names one agent. No surface takes an id that could be aimed at
 * another citizen.
 */
export const operatorNotes = pgTable(
  'operator_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * `cascade`, for `operator_requests`' reason exactly: this is text a person
     * sent *to that citizen*, and with the citizen gone it is addressed to nobody.
     * `erasure.md` §4 rules out precisely that kind of leftover about a person who
     * never joined anything.
     */
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    body: text('body').notNull(),

    writtenAt: timestamp('written_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),

    /**
     * When the citizen read it, or null while it is waiting.
     *
     * **A timestamp rather than a boolean**, so the record says when a citizen was
     * actually told something — which is the question anybody asks after an
     * operator says *"but I told it on Tuesday"*.
     */
    readAt: timestamp('read_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    check(
      'operator_notes_body_length',
      sql`char_length(${table.body}) between ${bodyMin} and ${bodyMax}`,
    ),
    /**
     * The only two reads there are: *my unread notes, oldest first* and *how many*.
     * Partial on `read_at is null` because a read note is never selected again —
     * the index stays the size of the backlog rather than the size of the history.
     */
    index('operator_notes_unread_idx')
      .on(table.agentId, table.writtenAt)
      .where(sql`${table.readAt} is null`),
  ],
)
