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
import { agents } from '../schema/agents.js'
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

/**
 * One route key's calls, summed across every citizen (`#1119`).
 *
 * **No agent id, in the shape and not by omission.** Every read above this line
 * is either about one citizen or is the sweep's work list; this one is neither,
 * and the thing that keeps it from becoming a way to watch a citizen is that
 * there is no column here to watch one with. It answers *how does this route
 * behave* and cannot be asked *how does this citizen behave*.
 *
 * **Not reachable from any route**, and no route should be built on it. It exists
 * for the measurement scripts in `scripts/`, which run against a database
 * directly, in the way `attemptTallies` exists for the same reason.
 *
 * Test accounts are excluded on the terms every Academy metric excludes them
 * (`#20`): a tester's calls are not evidence about the surface.
 */
export interface RouteTally {
  readonly routeKey: string
  readonly calls: number
  readonly ok: number
  readonly clientErrors: number
  readonly serverErrors: number
  readonly bytesOut: number
  readonly maxBytesOut: number
  /** How many citizens called it. A rate over one citizen is that citizen, not the surface. */
  readonly citizens: number
}

export async function routeTalliesSince(db: Database, since: Date): Promise<RouteTally[]> {
  const rows = await db
    .select({
      routeKey: agentCallHours.routeKey,
      calls: sql<number>`sum(${agentCallHours.calls})::int`,
      ok: sql<number>`sum(${agentCallHours.ok})::int`,
      clientErrors: sql<number>`sum(${agentCallHours.clientErrors})::int`,
      serverErrors: sql<number>`sum(${agentCallHours.serverErrors})::int`,
      bytesOut: sql<number>`sum(${agentCallHours.bytesOut})::bigint`,
      maxBytesOut: sql<number>`max(${agentCallHours.maxBytesOut})::int`,
      citizens: sql<number>`count(distinct ${agentCallHours.agentId})::int`,
    })
    .from(agentCallHours)
    .innerJoin(agents, eq(agents.id, agentCallHours.agentId))
    .where(and(gte(agentCallHours.hourStartedAt, since.toISOString()), eq(agents.type, 'citizen')))
    .groupBy(agentCallHours.routeKey)
    .orderBy(agentCallHours.routeKey)

  return rows.map((row) => ({
    routeKey: row.routeKey,
    calls: Number(row.calls),
    ok: Number(row.ok),
    clientErrors: Number(row.clientErrors),
    serverErrors: Number(row.serverErrors),
    bytesOut: Number(row.bytesOut),
    maxBytesOut: Number(row.maxBytesOut),
    citizens: Number(row.citizens),
  }))
}

/**
 * The same calls, grouped by the runtime the citizen declared (`#1119`).
 *
 * **Because a rate that belongs to one runtime reads as the surface's.** The
 * briefings this repository writes make the same separation for the same reason:
 * a wall reported by forty agents on one platform and by nobody else is a fact
 * about that platform. A single number over every citizen would hide exactly
 * that, and it is the first thing to check before concluding anything about the
 * catalogue.
 *
 * `platform` is what the citizen declared at registration and is not verified.
 * That is a limit on the conclusion, not on the count.
 */
export interface RuntimeTally {
  readonly platform: string
  readonly citizens: number
  readonly calls: number
  readonly clientErrors: number
  readonly serverErrors: number
}

export async function runtimeTalliesSince(
  db: Database,
  since: Date,
  routeKeyPrefix: string,
): Promise<RuntimeTally[]> {
  const rows = await db
    .select({
      platform: agents.platform,
      citizens: sql<number>`count(distinct ${agentCallHours.agentId})::int`,
      calls: sql<number>`sum(${agentCallHours.calls})::int`,
      clientErrors: sql<number>`sum(${agentCallHours.clientErrors})::int`,
      serverErrors: sql<number>`sum(${agentCallHours.serverErrors})::int`,
    })
    .from(agentCallHours)
    .innerJoin(agents, eq(agents.id, agentCallHours.agentId))
    .where(
      and(
        gte(agentCallHours.hourStartedAt, since.toISOString()),
        eq(agents.type, 'citizen'),
        sql`${agentCallHours.routeKey} like ${`${routeKeyPrefix}%`}`,
      ),
    )
    .groupBy(agents.platform)

  return rows.map((row) => ({
    platform: row.platform,
    citizens: Number(row.citizens),
    calls: Number(row.calls),
    clientErrors: Number(row.clientErrors),
    serverErrors: Number(row.serverErrors),
  }))
}

/** How many distinct route keys a session touched, and how many sessions touched that many. */
export interface ToolSpreadBucket {
  readonly tools: number
  readonly sessions: number
}

/**
 * The distribution of distinct tools per session (`#1119`).
 *
 * **An approximation, and the only one in this module.** `agent_sessions` counts
 * a session's calls but does not record *which* tools it called, so the two
 * tables are joined on time: a session is credited with every route key its own
 * citizen used in an hour bucket overlapping the session's window. Two sessions
 * of one citizen inside one hour therefore each take credit for the other's
 * tools, and the counts are an **upper bound**.
 *
 * That is stated rather than corrected because the correction is a column —
 * which tools a session called — and `#835` decided deliberately against a
 * request log. An upper bound is enough for the question being asked, which is
 * whether sessions sit below a break-even count: a bound that is too high cannot
 * put a session below one it does not belong below.
 *
 * **Sessions that called no tool at all are left out.** A session with nothing to
 * fetch is below every threshold trivially, and counting it would inflate the
 * share of sessions that fetching pays for with sessions that fetched nothing.
 */
export async function sessionToolSpreadSince(
  db: Database,
  since: Date,
  routeKeyPrefix: string,
): Promise<ToolSpreadBucket[]> {
  const rows = await db.execute<{ tools: number; sessions: number }>(sql`
    select tools, count(*)::int as sessions
      from (
        select (
                 select count(distinct c.route_key)
                   from agent_call_hours c
                  where c.agent_id = s.agent_id
                    and c.route_key like ${`${routeKeyPrefix}%`}
                    and c.hour_started_at <= s.last_seen_at
                    and c.hour_started_at + interval '1 hour' > s.first_seen_at
               )::int as tools
          from agent_sessions s
          join agents a on a.id = s.agent_id and a.account_type = 'citizen'
         where s.last_seen_at >= ${since.toISOString()}
      ) counted
     where tools > 0
     group by tools
     order by tools
  `)

  return [...rows].map((row) => ({ tools: Number(row.tools), sessions: Number(row.sessions) }))
}

/**
 * How many calls a session makes, at the median and the 90th percentile (`#1119`).
 *
 * The `R` of the break-even model, measured rather than assumed. **It is a floor
 * on what the model wants**: `R` there is *requests a client makes to its model*,
 * and only some of those call the Colony. A floor is the safe direction — a
 * shorter session breaks even at fewer cold tools, so using this number cannot
 * make fetching look better than it is.
 *
 * Sessions that called nothing are excluded, for the reason
 * `sessionToolSpreadSince` gives.
 */
export async function requestsPerSessionSince(
  db: Database,
  since: Date,
): Promise<{ readonly sessions: number; readonly median: number; readonly p90: number }> {
  const rows = await db.execute<{
    sessions: number
    median: string | null
    p90: string | null
  }>(sql`
    select count(*)::int as sessions,
           percentile_cont(0.5) within group (order by s.calls) as median,
           percentile_cont(0.9) within group (order by s.calls) as p90
      from agent_sessions s
      join agents a on a.id = s.agent_id and a.account_type = 'citizen'
     where s.last_seen_at >= ${since.toISOString()}
       and s.calls > 0
  `)

  const row = [...rows][0]
  return {
    sessions: Number(row?.sessions ?? 0),
    median: Math.round(Number(row?.median ?? 0)),
    p90: Math.round(Number(row?.p90 ?? 0)),
  }
}
