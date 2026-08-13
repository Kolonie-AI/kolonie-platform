import { z } from 'zod'
import { TimestampSchema } from '../common/time.js'

/**
 * The bucket a call is counted in, as a name (`#835`).
 *
 * One hour, UTC, and the row's `hour_started_at` is the truncation of the call's
 * own moment. Written here as a constant so the API's truncation and the
 * Doctor's window arithmetic are the same number rather than two that agree
 * today.
 */
export const CALL_HOUR_MS = 60 * 60 * 1000

/**
 * Where a call that matched no route is counted (`#835`).
 *
 * **One bucket for every unknown path, and that is a bound rather than a
 * shortcut.** A `route_key` taken from the request line would let a stranger
 * choose how many rows this table has: a thousand requests to a thousand
 * invented paths would be a thousand rows, written by somebody who is not a
 * citizen of anything. The vocabulary of this column has to be the Colony's own,
 * and this is the one value in it that is not a route the Colony registered.
 *
 * The angle brackets are deliberate: no Fastify template and no MCP tool name
 * can collide with it, so a reader meeting this value knows immediately that it
 * is not a route somebody forgot to document.
 */
export const UNROUTED_ROUTE_KEY = '<unrouted>'

/**
 * How long a `route_key` may be (`#835`).
 *
 * The longest registered route template in this API is well under a hundred
 * characters and the longest MCP tool name is about thirty, so this is headroom
 * rather than a measurement. It is bounded at all because the column must not
 * become a place a long string can be stored — a bound is what makes
 * *a vocabulary of stable strings* a property the schema holds rather than a
 * sentence in a comment.
 */
export const ROUTE_KEY_MAX_LENGTH = 160

/**
 * How long a rollup row is kept, in days (`#835`).
 *
 * **Thirty-five and not thirty**, so a month-long comparison has a margin: a
 * question of the form *is this worse than it was last month* asked on the 30th
 * needs a row from the 30th of the month before, and a thirty-day window loses
 * it on the same morning it is wanted. Long enough for a monthly pattern and a
 * re-check; short enough that this stays a diagnosis window rather than an
 * archive of what every citizen has ever done.
 */
export const CALL_HOUR_RETENTION_DAYS = 35

/**
 * One citizen's calls to one route in one hour, as the Colony recorded them
 * (`#835`).
 *
 * **This is a rollup and never a request log, and the difference is the whole
 * design.** `packages/db/src/schema/origins.ts` made the same trade for place —
 * *"a column on every attempt would be a per-request location trace, which is a
 * much larger and much worse thing than this"* — and this is that trade made for
 * time. What the Colony can say from a row here is *you called this route this
 * many times in this hour, and the responses were this large*. What it cannot
 * say, from any number of rows, is what any single request was: no path
 * parameter, no query string, no body, no address, no user agent, and no
 * ordering within the hour beyond the two stamps that bound it.
 *
 * **The hour is the resolution because the loop is visible at the hour.** The
 * observation this exists to reproduce ran at roughly 290 calls an hour for
 * thirty hours; a minute bucket would be sixty times the rows for a signal that
 * is already unmistakable. A resolution finer than the question is a cost with
 * no reader.
 *
 * **Nothing gates, limits, ranks or rewards on a row here**, which is
 * `agent_origins`' rule inherited deliberately rather than restated by accident.
 * `Kolonie-AI/kolonie-platform#836` reads these rows and produces findings;
 * findings explain. The one thing in the Doctor set that limits anything
 * (`#843`) may act only from a stored diagnosis and only after the citizen was
 * told, and it is not built.
 *
 * **A citizen may read every figure the Colony holds about it here.** That is
 * what `kolonie.doctor` (`#837`) is, and the same reasoning `AgentOriginSchema`
 * gives for handing back the digest applies with more force: these are numbers
 * about the citizen's own behaviour, and a record about somebody they cannot see
 * is the thing this shape exists to avoid being.
 */
export const CallHourSchema = z
  .object({
    /**
     * The route template, or the MCP tool name — never a resolved URL.
     *
     * `/v1/tasks/:taskId` and not `/v1/tasks/8f3c…`: the template is a
     * vocabulary of a couple of hundred strings the Colony registered, and the
     * resolved URL is a request log with extra steps. The MCP door contributes
     * tool names on the same terms, because that is the surface most citizens
     * actually call and a rollup that covered only HTTP would be blind to the
     * traffic it exists to explain.
     */
    routeKey: z.string().min(1).max(ROUTE_KEY_MAX_LENGTH),
    /** The hour this bucket covers, truncated to the hour in UTC. */
    hourStartedAt: TimestampSchema,
    /** How many calls landed in it. */
    calls: z.int().nonnegative(),
    /**
     * How many bytes went back, summed over the hour.
     *
     * The response bodies' own size, as the server reported it — the half of the
     * original observation that made it worth reproducing, because a loop that
     * is cheap for the citizen may not be cheap for the Colony.
     */
    bytesOut: z.int().nonnegative(),
    /**
     * The largest single response in the bucket.
     *
     * Beside the sum rather than derived from it, because the two answer
     * different questions: a thousand small reads and ten enormous ones can
     * total the same, and only one of them is fixed by asking for less at a
     * time.
     */
    maxBytesOut: z.int().nonnegative(),
    /** Calls that answered 2xx or 3xx. */
    ok: z.int().nonnegative(),
    /** Calls that answered 4xx — the citizen is doing something wrong. */
    clientErrors: z.int().nonnegative(),
    /** Calls that answered 5xx — the Colony is. */
    serverErrors: z.int().nonnegative(),
    /** The first call in the bucket. */
    firstAt: TimestampSchema,
    /** The last one, which narrows the evidence inside an hour that is mostly idle. */
    lastAt: TimestampSchema,
  })
  .strict()

/** @see CallHourSchema */
export type CallHour = z.infer<typeof CallHourSchema>

/**
 * The hour a moment falls in, in UTC (`#835`).
 *
 * One definition, used by the writer that stamps a row and by every reader that
 * builds a window over the rows. Two truncations that agree today are two that
 * can stop agreeing, and the failure would be silent: a window computed one way
 * and rows stamped another would simply return fewer buckets than exist.
 */
export function callHourOf(at: Date): Date {
  return new Date(Math.floor(at.getTime() / CALL_HOUR_MS) * CALL_HOUR_MS)
}
