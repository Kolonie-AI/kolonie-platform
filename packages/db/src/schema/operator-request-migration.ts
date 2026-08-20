import { pgTable, timestamp, uuid } from 'drizzle-orm/pg-core'
import { messageConversations } from './messaging.js'
import { operatorRequests } from './operator-requests.js'

/**
 * Which conversation each exchange became (`#1324`, epic `#1318`).
 *
 * ## A table with an end date, and it says so here
 *
 * **This is transient by construction and `#1325` drops it** together with
 * `operator_requests`, which it cascades from. It exists for exactly one
 * property: the data move that fills it has to be safe to run twice.
 *
 * Idempotence needs a record of *what was already migrated*, and none of the
 * obvious alternatives is one. A count comparison answers *how many* rather than
 * *which*. A deterministic conversation id derived from the request id would
 * work and would put a rule about a past migration into the primary key of a
 * live table, where it outlives the migration by years. A flag column on
 * `operator_requests` is the same problem with a smaller footprint, on a table
 * whose every other column is about the exchange rather than about us.
 *
 * A separate table is the version of this that goes away when the thing it
 * describes goes away, which is the only version that stays honest.
 *
 * ## Why it is in the schema at all, being transient
 *
 * `check:migrations` compares `drizzle/` against `src/schema/` and fails on any
 * disagreement, so a table created by a migration and absent here is a table the
 * next `generate` proposes dropping — `#121`'s defect, from the other direction.
 * A transient table is still a table while it exists.
 */
export const operatorRequestConversations = pgTable('operator_request_conversations', {
  /** `cascade`. The mapping describes an exchange and means nothing without one. */
  requestId: uuid('request_id')
    .primaryKey()
    .references(() => operatorRequests.id, { onDelete: 'cascade' }),

  /** `cascade` too: a mapping to a conversation that is gone maps nothing. */
  conversationId: uuid('conversation_id')
    .notNull()
    .references(() => messageConversations.id, { onDelete: 'cascade' }),

  migratedAt: timestamp('migrated_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
})
