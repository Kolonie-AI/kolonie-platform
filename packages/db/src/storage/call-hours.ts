import { and, desc, eq, gte, lt, sql } from 'drizzle-orm'
import {
  CALL_HOUR_RETENTION_DAYS,
  CallHourSchema,
  callHourOf,
  ROUTE_KEY_MAX_LENGTH,
  UNROUTED_ROUTE_KEY,
  type AgentId,
  type CallHour,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { agentCallHours } from '../schema/call-hours.js'
import { toTimestamp } from './rows.js'

/**
 * One authenticated call, as the seam that saw it finish describes it (`#835`).
 *
 * **Everything here is known only after the response**, which is why this is a
 * value passed to one function rather than three fields set at three moments.
 * The status and the size do not exist when the citizen is authenticated, and
 * the citizen does not exist when the route is matched.
 */
export interface ObservedCall {
  /**
   * The route template or the MCP tool name, already resolved by the caller.
   *
   * **Never a URL, and this module does not check that** — it cannot, since
   * `/v1/health` is a legitimate template and also a legitimate path. What keeps
   * a resolved URL out of this column is that the two seams that write here take
   * the template from Fastify's own router and the tool name from the MCP
   * registration, so neither has a resolved path in hand to pass by mistake.
   * `apps/api/src/call-rollup.ts` is where that is asserted.
   */
  readonly routeKey: string
  /** The HTTP status, or the MCP door's equivalent. */
  readonly status: number
  /** How many bytes went back, or 0 where the seam could not honestly say. */
  readonly bytesOut: number
  /** When the call finished. The bucket is derived from it, never passed in. */
  readonly at: Date
}

/**
 * What recording a call did. Read by tests; nothing branches on it.
 */
export type CallHourOutcome =
  /** The first call this citizen made to this route in this hour. */
  | 'opened'
  /** One more in a bucket that already existed. */
  | 'counted'
  /** The write did not happen, and the caller's request is unaffected. */
  | 'failed'

/**
 * Count one finished call against its citizen, its route and its hour.
 *
 * **It never throws**, on the same terms as `recordOrigin`, `attributeCall` and
 * `touchLastSeen`, and the rule those state is the rule here:
 * *"A missing call count is a thinner diagnosis; a failed request is a citizen
 * that could not do its work."* This is observability. Observability that can
 * stand between an agent and its rung is worse than none — and this one sits on
 * the response path of every authenticated call in the system, which is the
 * worst possible place for a write that can fail loudly.
 *
 * **One statement, and the bucketing happens inside Postgres.** The primary key
 * is what makes the second call in an hour an update, so there is no read
 * followed by a decision — which would be two round trips and a race between
 * them on the hottest path there is. Two concurrent calls to the same route in
 * the same hour therefore serialise on one row rather than producing two.
 *
 * **`first_at` is left alone on conflict and `last_at` moves**, for the reason
 * `recordOrigin` gives about its own pair: the two together are the evidence. An
 * hour whose calls all landed in four minutes and an hour whose calls were
 * spread across it are the same row without them, and only one of the two is a
 * loop.
 *
 * **`max_bytes_out` is a `greatest` and not an assignment**, so the largest
 * response in the bucket survives every smaller one that follows it. Writing it
 * plainly would make the column mean *the last response*, which is a fact
 * nobody asked for and which reads exactly like the fact somebody wanted.
 *
 * **A `route_key` longer than the column is truncated rather than refused.** The
 * bound is headroom over the longest route this API has, so reaching it means
 * something unexpected arrived at the seam; losing the tail of one key is a
 * thinner diagnosis, and refusing the write would be this function throwing on
 * the response path, which the first paragraph forbids.
 */
export async function recordCall(
  db: Database | Transaction,
  agentId: AgentId,
  call: ObservedCall,
): Promise<CallHourOutcome> {
  const routeKey = (call.routeKey === '' ? UNROUTED_ROUTE_KEY : call.routeKey).slice(
    0,
    ROUTE_KEY_MAX_LENGTH,
  )
  const bytesOut = Number.isFinite(call.bytesOut) ? Math.max(0, Math.trunc(call.bytesOut)) : 0
  const at = call.at.toISOString()

  const ok = call.status < 400 ? 1 : 0
  const clientErrors = call.status >= 400 && call.status < 500 ? 1 : 0
  const serverErrors = call.status >= 500 ? 1 : 0

  try {
    const written = await db
      .insert(agentCallHours)
      .values({
        agentId,
        routeKey,
        hourStartedAt: callHourOf(call.at).toISOString(),
        calls: 1,
        bytesOut,
        maxBytesOut: bytesOut,
        ok,
        clientErrors,
        serverErrors,
        firstAt: at,
        lastAt: at,
      })
      .onConflictDoUpdate({
        target: [agentCallHours.agentId, agentCallHours.routeKey, agentCallHours.hourStartedAt],
        set: {
          calls: sql`${agentCallHours.calls} + 1`,
          bytesOut: sql`${agentCallHours.bytesOut} + excluded.bytes_out`,
          maxBytesOut: sql`greatest(${agentCallHours.maxBytesOut}, excluded.max_bytes_out)`,
          ok: sql`${agentCallHours.ok} + excluded.ok`,
          clientErrors: sql`${agentCallHours.clientErrors} + excluded.client_errors`,
          serverErrors: sql`${agentCallHours.serverErrors} + excluded.server_errors`,
          // The last call in a bucket may arrive out of order by milliseconds
          // under concurrency; `greatest` means the stamp is the latest one
          // seen rather than the last one written.
          lastAt: sql`greatest(${agentCallHours.lastAt}, excluded.last_at)`,
        },
      })
      .returning({ calls: agentCallHours.calls })

    return written[0]?.calls === 1 ? 'opened' : 'counted'
  } catch {
    return 'failed'
  }
}

/**
 * This citizen's own hours, newest first, over a bounded window (`#835`, `#837`).
 *
 * **Only ever the caller's own.** There is no surface anywhere that answers this
 * about another citizen and no agent-id parameter a route could aim at somebody
 * else beyond the one the authenticated caller supplies about itself — the same
 * rule `recentOrigins` and `recentSessions` are built on, and the constraint
 * `#837` inherits verbatim from the Trello card: *shows only its own data, never
 * the behaviour of other citizens*.
 *
 * **The window is a required argument and there is no default.** A read of this
 * table with no lower bound is a scan of thirty-five days for a question that is
 * always about a handful of hours, and a default would be the value every caller
 * gets without having decided anything.
 */
export async function callHoursSince(
  db: Database | Transaction,
  agentId: AgentId,
  since: Date,
): Promise<readonly CallHour[]> {
  const rows = await db
    .select({
      routeKey: agentCallHours.routeKey,
      hourStartedAt: agentCallHours.hourStartedAt,
      calls: agentCallHours.calls,
      bytesOut: agentCallHours.bytesOut,
      maxBytesOut: agentCallHours.maxBytesOut,
      ok: agentCallHours.ok,
      clientErrors: agentCallHours.clientErrors,
      serverErrors: agentCallHours.serverErrors,
      firstAt: agentCallHours.firstAt,
      lastAt: agentCallHours.lastAt,
    })
    .from(agentCallHours)
    .where(
      and(
        eq(agentCallHours.agentId, agentId),
        gte(agentCallHours.hourStartedAt, since.toISOString()),
      ),
    )
    .orderBy(desc(agentCallHours.hourStartedAt))

  // Parsed rather than cast, for the reason `recentOrigins` gives: a column that
  // drifts from the shape core publishes fails here rather than in somebody's
  // client. The timestamps go through `toTimestamp` because Postgres renders
  // them in its own format and `TimestampSchema` asks for ISO 8601.
  return rows.map((row) =>
    CallHourSchema.parse({
      ...row,
      hourStartedAt: toTimestamp(row.hourStartedAt),
      firstAt: toTimestamp(row.firstAt),
      lastAt: toTimestamp(row.lastAt),
    }),
  )
}

/**
 * Every citizen that made a call since a moment (`#839`).
 *
 * **The runner's whole work list**, and the only read in this module that is not
 * about one citizen. A pass that walked `agents` instead would diagnose every
 * citizen the Colony has ever had, almost all of whom have made no call in the
 * window — hundreds of empty diagnoses per hour to learn nothing.
 *
 * Distinct over the index the sweep already uses, so it is a range scan rather
 * than a scan of the table.
 */
export async function citizensWithCallsSince(
  db: Database | Transaction,
  since: Date,
): Promise<readonly AgentId[]> {
  const rows = await db
    .selectDistinct({ agentId: agentCallHours.agentId })
    .from(agentCallHours)
    .where(gte(agentCallHours.hourStartedAt, since.toISOString()))

  return rows.map((row) => row.agentId as AgentId)
}

/**
 * Delete every bucket older than the retention window (`#835`).
 *
 * **The clock is an argument.** A sweep that read `now()` for itself could not be
 * tested against a boundary without waiting for one, and the boundary is the
 * only interesting thing about a retention rule.
 *
 * **It deletes and does not archive.** There is no colder table to move a row
 * to, and inventing one would keep the thing the window exists to stop keeping.
 * The history that matters after thirty-five days is a *diagnosis* (`#838`),
 * which is a judgement with its own retention and its own reasons — not the
 * arithmetic it was made from.
 *
 * Returns how many rows went, so the caller can log a number rather than
 * announcing that it swept.
 */
export async function sweepCallHours(
  db: Database | Transaction,
  now: Date,
  retentionDays: number = CALL_HOUR_RETENTION_DAYS,
): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000)

  const deleted = await db
    .delete(agentCallHours)
    .where(lt(agentCallHours.hourStartedAt, cutoff.toISOString()))
    .returning({ routeKey: agentCallHours.routeKey })

  return deleted.length
}
