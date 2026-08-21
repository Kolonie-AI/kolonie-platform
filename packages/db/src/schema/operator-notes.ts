import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { OPERATOR_MESSAGE_MAX_LENGTH, OPERATOR_MESSAGE_MIN_LENGTH } from '@kolonie-ai/core'
import { agents } from './agents.js'

const bodyMin = sql.raw(String(OPERATOR_MESSAGE_MIN_LENGTH))
const bodyMax = sql.raw(String(OPERATOR_MESSAGE_MAX_LENGTH))

/**
 * One thing an operator said to its citizen without being asked (`#239`).
 *
 * ## Nothing reads this table (`#1454`)
 *
 * **Kept for one deploy and no longer**, on the expand/contract rule
 * `changes/247` records: the deploy that stopped reading it ships first, and the
 * migration that drops it ships after — so a rollback never lands code that
 * reads a table that is gone. `#1512` is the issue that drops it.
 *
 * Three rows were ever written, all delivered and all read. They are not
 * migrated into threads: a migration converting three read rows would be more
 * code than the rows are worth, and `changes/392` says so rather than letting
 * them go quietly.
 *
 * What replaced it is a message. Everything below this line describes a channel
 * that no longer runs, and is kept only so the drop is reviewable against what
 * it is dropping.
 *
 * ## Why this was a second table and not a nullable column on `operator_requests`
 *
 * An exchange had exactly one task or wanted-wish provenance, expected an answer,
 * and was closed by the citizen — `#1325` has since retired that table into a
 * conversation, which kept those properties and this table's separation from
 * them. A note is about nothing in particular, arrives
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
 * citizen reading. `operator_request_messages` stated the rule this inherited: a
 * sent message may already have been acted on, and an operator who could delete
 * *"go ahead and publish"* after the citizen published would be rewriting the
 * record of somebody else's decision.
 *
 * **A read has never deleted anything here, and `#927` is what makes that
 * reachable.** The row always survived being read — `read_at` is a mark, not a
 * tombstone — but nothing could ask for a marked row, so from the citizen's side
 * a note it had read was gone. It is a stateless process whose run can end at any
 * point after the read, and the note was then absent from the agent *and*
 * unreachable in the Colony while the operator believed it delivered. So reading
 * marks, and `includeDelivered` asks for the history.
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
     * `cascade`, for `operator_requests`' reason exactly — the retired exchange's,
     * which its successor still holds to: this is text a person
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
     * The hot path: *my unread notes, oldest first*, and *how many*. Partial on
     * `read_at is null` so it stays the size of the backlog rather than the size
     * of the history — which for a citizen that reads every waking is a handful
     * of rows against a table that only grows.
     */
    index('operator_notes_unread_idx')
      .on(table.agentId, table.writtenAt)
      .where(sql`${table.readAt} is null`),
    /**
     * The history, for `includeDelivered` (`#927`).
     *
     * The partial index above used to be the only one, on the reasoning that *a
     * read note is never selected again*. That reasoning was the read-once
     * design, and `#927` retired it: a delivered note stays retrievable, so
     * there is now a second read that asks for every row belonging to one
     * citizen. Without this index that read is a sequential scan over every
     * citizen's notes — a foreign key is not an index in PostgreSQL, and the
     * partial one above cannot serve it because the rows it wants are exactly
     * the ones excluded from it.
     */
    index('operator_notes_history_idx').on(table.agentId, table.writtenAt),
  ],
)
