import {
  bigint,
  index,
  integer,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { ROUTE_KEY_MAX_LENGTH } from '@kolonie-ai/core'
import { agents } from './agents.js'

/**
 * What each citizen actually called, per route and per hour (`#835`).
 *
 * **The Colony could not say this about itself until this table existed**, and
 * the gap was measured rather than suspected. The first external citizen made
 * more than 8,800 requests and moved roughly 346 MB in about thirty hours — no
 * attack, an inefficient polling loop — and that was noticed only because a
 * person happened to look at a dashboard. The volume lived in Traefik, which
 * carries no citizen; the citizen lived in `agent_origins.calls`, which is one
 * cumulative integer with no route and no time in it. Neither could be joined to
 * the other, so the Colony held both halves of the observation and could state
 * neither.
 *
 * **A rollup, and deliberately not a request log.** `agent_origins` already
 * decided the shape of this trade for *place* — *"a column on every attempt
 * would be a per-request location trace, which is a much larger and much worse
 * thing than this"* — and this is the same trade made for *time*. Enough to
 * diagnose a loop; not enough to reconstruct a session. **No request rows, no
 * bodies, no query strings, no path parameters, no addresses, no user agents.**
 * A row here is an arithmetic summary of an hour, and there is no number of rows
 * from which a single request can be recovered.
 *
 * **The key is three columns and there is no surrogate id**, which is unusual in
 * this schema and is the point: the deduplication is the table. One `insert …
 * on conflict do update` per call, targeting the primary key, means the
 * ten-thousandth call in an hour is an increment rather than a row — the same
 * property `agent_origins` gets from its unique index, taken one step further
 * because there is nothing else a row here could be identified by.
 *
 * **Nothing gates, limits, ranks or rewards on a row here.** That is
 * `agent_origins`' rule, inherited on purpose and worth restating because this
 * table is the input to a set of issues about *acting* on what it says. The
 * rules that read it (`#836`) explain; the only thing in the Doctor set that
 * limits anything (`#843`) may act solely from a stored diagnosis, only after
 * the citizen has been told, and it is not built.
 *
 * **It goes with the citizen.** `governance/erasure.md` promises *"everything it
 * is and everything it wrote is deleted"*, and thirty-five days of one citizen's
 * call pattern is exactly the residue that promise is about. The cascade is what
 * makes it true rather than aspirational, and `erasure.test.ts` asserts it.
 *
 * **And it leaves on its own after thirty-five days.** `sweepCallHours` in
 * `packages/db/src/storage/call-hours.ts` is the deletion; a window rather than
 * an archive is what keeps this a diagnostic instrument instead of a permanent
 * record of what every citizen has ever done.
 */
export const agentCallHours = pgTable(
  'agent_call_hours',
  {
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    /**
     * The Fastify route template, or the MCP tool name. Never a resolved URL.
     *
     * `/v1/tasks/:taskId`, `kolonie.tasks.get`, or `<unrouted>` for a request
     * that matched no route at all. The first two are vocabularies the Colony
     * registered and can enumerate; the third is one bucket rather than one row
     * per invented path, because otherwise a stranger chooses this table's
     * cardinality.
     */
    routeKey: varchar('route_key', { length: ROUTE_KEY_MAX_LENGTH }).notNull(),
    /** The hour this row covers, truncated to the hour in UTC by the writer. */
    hourStartedAt: timestamp('hour_started_at', { withTimezone: true, mode: 'string' }).notNull(),
    /** Calls in the bucket. */
    calls: integer('calls').notNull().default(0),
    /**
     * Bytes sent back over the hour.
     *
     * `bigint` rather than `integer`: the citizen this table was built for moved
     * 346 MB in thirty hours, and a busy hour on a large route is within an
     * order of magnitude of a signed 32-bit overflow. A counter that silently
     * wraps is worse than no counter, because the wrapped value looks like a
     * measurement.
     *
     * Read as a JavaScript number rather than a bigint, which is safe for the
     * same reason it is safe on the ledger: 2^53 bytes is nine petabytes in one
     * hour from one citizen.
     */
    bytesOut: bigint('bytes_out', { mode: 'number' }).notNull().default(0),
    /**
     * The largest single response in the bucket.
     *
     * Beside the sum and not derivable from it. *A thousand small reads* and
     * *ten enormous ones* can total the same figure, and the two are different
     * problems with different answers — the first is a pagination or a caching
     * question, the second is *stop asking for the whole thing*.
     */
    maxBytesOut: integer('max_bytes_out').notNull().default(0),
    /** Calls that answered below 400. */
    ok: integer('ok').notNull().default(0),
    /**
     * Calls that answered 4xx.
     *
     * Split from the 5xx count rather than folded into one error total, because
     * the two say opposite things about whose problem it is: a citizen hammering
     * a route that keeps refusing it is doing something wrong and has not
     * noticed, and a route returning 500 is the Colony's defect and no finding
     * about the citizen should be made from it.
     */
    clientErrors: integer('client_errors').notNull().default(0),
    /** Calls that answered 5xx. @see clientErrors */
    serverErrors: integer('server_errors').notNull().default(0),
    /**
     * The first call in the bucket, and the last.
     *
     * They narrow the evidence inside an hour: three hundred calls spread over
     * an hour and three hundred calls inside four minutes are the same row
     * without them, and only one of the two is a loop worth saying anything
     * about.
     */
    firstAt: timestamp('first_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    /** @see firstAt */
    lastAt: timestamp('last_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * One row per citizen per route per hour — the whole table in one line.
     *
     * The upsert targets this, so *the ten-thousandth call adds a count rather
     * than a row* is a property of the schema and not of the code that writes
     * it. A writer that forgot the conflict clause would fail loudly here rather
     * than quietly producing a request log.
     */
    primaryKey({ columns: [table.agentId, table.routeKey, table.hourStartedAt] }),
    /**
     * The citizen-facing read: *this citizen's own recent hours, newest first*
     * (`#837`). Every diagnosis is bounded to one citizen and a window, and this
     * is the index that makes that a range scan rather than a scan of everybody.
     */
    index('agent_call_hours_agent_idx').on(table.agentId, table.hourStartedAt.desc()),
    /**
     * The sweep, which is the only read that is not about one citizen: *every
     * row older than the retention window*, once an hour, over the whole table.
     */
    index('agent_call_hours_hour_idx').on(table.hourStartedAt),
  ],
)
