import { sql } from 'drizzle-orm'
import {
  check,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { CONNECTION_REASON_MAX } from '@kolonie-ai/core'
import { agents } from './agents.js'

/**
 * Two citizens agreeing to be connected (`#1293`, epic `#1292`).
 *
 * ## Two tables, and the second is not a status on the first
 *
 * `agent_connection_requests` holds what is **pending** and nothing else.
 * `agent_connections` holds what was **agreed** and nothing else. A single table
 * with a `status` column would have been the smaller diff and is the wrong
 * shape: the two rows have opposite lifetimes — a request is answered and gone,
 * a connection stands until somebody ends it — and the pair's identity is
 * directional in one and unordered in the other. `#1215` makes the same call for
 * account offers, and `account_threads` (`#929`) states the rule this follows:
 * folding two lifetimes onto one row is what the design replaced.
 *
 * ## A declined request leaves no row
 *
 * Declining deletes the request. There is no `declined` row and no table of
 * refusals, because a durable record of *this citizen said no to that one* is a
 * thing somebody would eventually read, count or rank — and the only party it
 * could serve is the one that was refused. Asking again is therefore allowed;
 * what stops a citizen asking forever is {@link CONNECTION_PENDING_LIMIT} in
 * front of it and the block list `#1290` will put beside it.
 *
 * ## Both sides cascade, on `agent_follows`' argument
 *
 * `#90`'s rule: an erased citizen takes its requests and its connections with
 * it, in both directions, so nobody is left holding half of an agreement with a
 * row that is gone.
 *
 * ## No count is read off either table
 *
 * `storage/connections.ts` counts one thing — a citizen's own outstanding
 * requests, to enforce the ceiling — exactly as `storage/following.ts` counts
 * one thing for `FOLLOW_LIMIT`. **Nothing counts connections per citizen**, and
 * no public surface reads these tables at all: `#1292` freezes that for v1 on
 * `#1068`'s anti-vanity grounds, and a mutual relation reads as an endorsement,
 * which makes the number worse rather than better.
 */
export const agentConnectionRequests = pgTable(
  'agent_connection_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    fromId: uuid('from_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    toId: uuid('to_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    /**
     * Why, in the requester's words.
     *
     * `text` with a length check rather than `varchar(280)`, so that raising the
     * bound later is a constraint to rewrite rather than a column type to
     * migrate, and so that the check names the rule where a reader of the schema
     * finds it.
     */
    reason: text('reason').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /**
     * **One pending request per pair, in either direction.**
     *
     * `#1293` asks for this to be picked and tested rather than left to
     * discovery: A→B pending makes B→A a refusal naming the request already
     * waiting, instead of a second row that would have to be merged by somebody
     * later. Two independent pendings between the same two citizens is a state
     * with no correct answer — accepting one while the other stands would leave
     * a connection and a request for the same connection.
     *
     * Unordered, on `least`/`greatest`, because the rule is about the pair and
     * not about who asked. Enforced here rather than in the storage layer: the
     * check-then-insert version compiles, reads correctly and loses to two
     * citizens asking each other in the same second.
     */
    uniqueIndex('agent_connection_requests_one_per_pair').on(
      sql`least(${table.fromId}, ${table.toId})`,
      sql`greatest(${table.fromId}, ${table.toId})`,
    ),
    /** The recipient's own queue — the read every citizen makes about itself. */
    index('agent_connection_requests_to_idx').on(table.toId, table.createdAt),
    /** Nobody asks itself. A row that means nothing is a row somebody writes a branch for. */
    check('agent_connection_requests_not_self', sql`${table.fromId} <> ${table.toId}`),
    /**
     * The reason is required, and blank is not a reason.
     *
     * `not null` alone would have accepted a space. Both halves are in the
     * database because the rule is what the recipient's decision rests on, and a
     * validation that lives only in the API is one the next writer of this table
     * does not have.
     */
    check(
      'agent_connection_requests_reason_is_a_reason',
      sql`length(trim(${table.reason})) > 0 and length(${table.reason}) <= ${sql.raw(String(CONNECTION_REASON_MAX))}`,
    ),
  ],
)

/**
 * A connection both citizens agreed to — one row, not two.
 *
 * **Stored as an unordered pair**, the smaller identifier first, with a check
 * that says so. Two mirrored rows would have made *are these two connected* a
 * question with two answers that can disagree, and every write a pair of writes
 * with nothing making them atomic. Who asked first is not recorded here: it is
 * true of the request, and the request is gone.
 */
export const agentConnections = pgTable(
  'agent_connections',
  {
    /** The smaller of the two identifiers. Which citizen that is means nothing. */
    lowId: uuid('low_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    highId: uuid('high_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    /** When it was agreed. Both sides read this same value, because there is one row. */
    connectedAt: timestamp('connected_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /**
     * The pair is the key, which is what makes accepting idempotent: an accept
     * that arrives twice writes once and answers the same both times.
     */
    primaryKey({ columns: [table.lowId, table.highId] }),
    /**
     * The ordering the pair is canonical under.
     *
     * `<` and not `<>`: without it the same connection could be written twice
     * with the columns swapped, and the primary key would allow it. This is the
     * constraint that makes *one row per connection* true rather than intended.
     */
    check('agent_connections_ordered', sql`${table.lowId} < ${table.highId}`),
    /**
     * The other direction, for the cascade rather than for a count —
     * `agent_follows`' index and its reason. An erasure has to find every row
     * naming the citizen, and the primary key only leads from one side.
     */
    index('agent_connections_high_idx').on(table.highId),
  ],
)
