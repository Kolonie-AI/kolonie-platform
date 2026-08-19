import { and, eq, gt, lt, sql } from 'drizzle-orm'
import {
  DIAGNOSIS_RETENTION_DAYS,
  ThrottleSchema,
  callHourOf,
  type AgentId,
  type SupportTicket,
  type Throttle,
  type ThrottlePlan,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { agentCallHours } from '../schema/call-hours.js'
import { supportTickets } from '../schema/support.js'
import { throttles } from '../schema/throttles.js'
import { toTimestamp } from './rows.js'
import { toTicket } from './support.js'

/**
 * Writing, reading and clearing the one limit the Colony applies (`#843`).
 *
 * **The write takes a {@link ThrottlePlan} and nothing else.** That type is
 * minted by `planThrottle` in `packages/core/src/doctor/throttle.ts` and by no
 * other expression in the system — it carries a key whose `unique symbol` that
 * module declares and does not export, so a caller here cannot build one, cast
 * to one or spread one together. This is the answer to *a future caller
 * bypasses the guard*: there is no second way in, and the compiler is what says
 * so rather than a comment somebody has to read.
 *
 * **The read is what the request path does, and it is built for the citizen who
 * is not throttled.** Almost every call in the Colony is made by somebody with
 * no limit at all, and that call must cost one index probe that finds nothing.
 * Only when a live row exists does anything count anything.
 */

/** What applying a throttle ended in. */
export type ApplyThrottleOutcome =
  | { readonly outcome: 'applied'; readonly throttle: Throttle }
  /**
   * Another pass got there first.
   *
   * The unique index on `(diagnosis_id, ordinal)` is what makes this a losing
   * insert rather than a second limit. Two runners racing produce one throttle,
   * which is the property that matters: a citizen must never be narrowed twice
   * for one finding because the Colony was deployed mid-pass.
   */
  | { readonly outcome: 'raced' }

/**
 * Apply a throttle the guard planned.
 *
 * **It re-decides nothing.** Every precondition was checked in `planThrottle`,
 * and repeating one here would be the beginning of two places that disagree.
 * What this adds is the two things only the database can say: that no other pass
 * wrote the same ordinal, and that the row satisfies the constraints on the
 * table.
 */
export async function applyThrottle(
  db: Database | Transaction,
  plan: ThrottlePlan,
): Promise<ApplyThrottleOutcome> {
  const [inserted] = await db
    .insert(throttles)
    .values({
      agentId: plan.agentId,
      diagnosisId: plan.diagnosisId,
      routeKeys: [...plan.routeKeys],
      callsPerHour: plan.callsPerHour,
      ordinal: plan.ordinal,
      // The plan's `kind` came off a diagnosis row, so the enum accepts it.
      kind: plan.kind as (typeof throttles.$inferInsert)['kind'],
      policyVersion: plan.policyVersion,
      appliedAt: plan.appliedAt,
      expiresAt: plan.expiresAt,
    })
    .onConflictDoNothing({ target: [throttles.diagnosisId, throttles.ordinal] })
    .returning()

  if (inserted === undefined) return { outcome: 'raced' }

  return { outcome: 'applied', throttle: rowToThrottle(inserted) }
}

/**
 * What the guard needs to know about a diagnosis's throttling history.
 *
 * Read from the rows rather than counted in the runner, so a restart cannot
 * reset the escalation and a citizen cannot earn a shorter throttle by being
 * limited during a deployment.
 */
export interface ThrottleHistory {
  /** How many have been applied for this diagnosis, expired or not. */
  readonly previousThrottles: number
  /** Whether one is in force at `now`. */
  readonly throttleInForce: boolean
}

/** @see ThrottleHistory */
export async function throttleHistoryFor(
  db: Database | Transaction,
  diagnosisId: string,
  now: Date,
): Promise<ThrottleHistory> {
  const [row] = await db
    .select({
      applied: sql<number>`count(*)::int`,
      live: sql<number>`count(*) filter (where ${throttles.expiresAt} > ${now.toISOString()})::int`,
    })
    .from(throttles)
    .where(eq(throttles.diagnosisId, diagnosisId))

  return {
    previousThrottles: row?.applied ?? 0,
    throttleInForce: (row?.live ?? 0) > 0,
  }
}

/**
 * The limits in force for one citizen at this moment, if any.
 *
 * **`expires_at > now` is the whole of the expiry mechanism.** Nothing has to
 * run for a throttle to lift: it stops being returned here the instant it
 * expires, whether or not the runner is up and whether or not the sweep has
 * ever run. `#843` asks for self-expiry by construction, and this predicate is
 * the construction.
 *
 * **`now` is an argument** — the rule every clock in the Doctor follows, and
 * here it is what makes *a throttle expires without any process running*
 * assertable against a fixture rather than by waiting six hours.
 */
export async function liveThrottlesFor(
  db: Database | Transaction,
  agentId: AgentId,
  now: Date,
): Promise<Throttle[]> {
  const rows = await db
    .select()
    .from(throttles)
    .where(and(eq(throttles.agentId, agentId), gt(throttles.expiresAt, now.toISOString())))

  return rows.map(rowToThrottle)
}

/** What the enforcement check answers. */
export type ThrottleCheck =
  /** No live limit covers this route. The overwhelming majority of calls. */
  | { readonly outcome: 'allowed' }
  /** A live limit covers it and the citizen is within it. */
  | { readonly outcome: 'within'; readonly throttle: Throttle }
  /** A live limit covers it and the hour's allowance is spent. */
  | { readonly outcome: 'refused'; readonly throttle: Throttle }

/**
 * Whether this citizen may call this route right now (`#843`).
 *
 * **One index probe for an unthrottled citizen, and that is the case worth
 * optimising.** The first query hits `throttles_agent_live_idx` and returns
 * nothing for nearly everybody; the count against `agent_call_hours` happens
 * only when a live row actually names the route being called.
 *
 * **It counts the rollup rather than a counter of its own.** The bucket is the
 * same `(agent, route, hour)` row the finding was computed from, which means the
 * limit is enforced against exactly the number the citizen was told about — and
 * means there is no second counter to drift, to reset on deploy or to forget to
 * cascade on erasure.
 *
 * **It never throws on a missing bucket.** No row is zero calls, which is the
 * honest reading and also the safe one: a rollup write that failed must not turn
 * into a refusal the citizen cannot explain.
 */
export async function checkThrottle(
  db: Database | Transaction,
  agentId: AgentId,
  routeKey: string,
  now: Date,
): Promise<ThrottleCheck> {
  const live = await liveThrottlesFor(db, agentId, now)
  if (live.length === 0) return { outcome: 'allowed' }

  const covering = live.find((throttle) => throttle.routeKeys.includes(routeKey))
  if (covering === undefined) return { outcome: 'allowed' }

  const [bucket] = await db
    .select({ calls: agentCallHours.calls })
    .from(agentCallHours)
    .where(
      and(
        eq(agentCallHours.agentId, agentId),
        eq(agentCallHours.routeKey, routeKey),
        eq(agentCallHours.hourStartedAt, callHourOf(now).toISOString()),
      ),
    )
    .limit(1)

  const calls = bucket?.calls ?? 0

  return calls >= covering.callsPerHour
    ? { outcome: 'refused', throttle: covering }
    : { outcome: 'within', throttle: covering }
}

/**
 * Tell the citizen and its operator that a limit was applied (`#843`).
 *
 * **A second colony-authored notice path, beside `openColonyNotice`.** That one
 * demands a submission of the citizen's, because the notices it was built for
 * (`#473`) are about one thing the Colony did to one thing the citizen filed. A
 * throttle has no submission and never will — it follows from a diagnosis, which
 * follows from a rollup — so it would either have to invent a reference or leave
 * the citizen unnotified, and `#843` requires the notice.
 *
 * **The narrowness is kept rather than dropped.** The rule that made
 * `openColonyNotice` safe was not *a submission* specifically, it was *a notice
 * names one thing that belongs to the addressed citizen and the write path
 * refuses one that does not*. So this checks the throttle is the citizen's, and
 * refuses in the same shape.
 *
 * **Authored by the citizen, because `support_tickets.agent_id` is not null.**
 * The same construction `openColonyNotice` uses, and the same reason
 * colony-scoped diagnoses escalate to an issue instead (`#869`): the ticket is
 * the citizen's own thread and it leaves with them when they do.
 *
 * **Once per throttle.** The ticket id is written back onto the throttle row, so
 * a second pass over the same throttle finds it already attached and sends
 * nothing — the fact lives where the throttle lives rather than in a process's
 * memory, which is what `#842` established for the telling and what makes both
 * survivable across a restart.
 */
export async function openThrottleNotice(
  db: Database | Transaction,
  notice: { throttleId: string; agentId: AgentId; subject: string; body: string },
): Promise<OpenThrottleNoticeOutcome> {
  const [owned] = await db
    .select({ id: throttles.id, supportTicketId: throttles.supportTicketId })
    .from(throttles)
    .where(and(eq(throttles.id, notice.throttleId), eq(throttles.agentId, notice.agentId)))
    .limit(1)

  if (owned === undefined) return { outcome: 'no-such-throttle' }
  if (owned.supportTicketId !== null) return { outcome: 'already-sent' }

  const [inserted] = await db
    .insert(supportTickets)
    .values({
      agentId: notice.agentId,
      kind: 'notice',
      // The other notice path, and `desk` for the same reason as
      // `openColonyNotice` (`#1344`): a throttle notice says what one named
      // citizen was doing too often, which is nobody else's business.
      route: 'desk',
      subject: notice.subject,
      body: notice.body,
      // Settled on arrival, like every notice: nothing is pending and nothing is
      // expected back. Replying is a citizen's own new ticket, which is the
      // appeal route `kolonie.support.open` is kept unthrottled for.
      status: 'resolved',
    })
    .returning()

  if (inserted === undefined) throw new Error('inserting a throttle notice returned no row')

  await db
    .update(throttles)
    .set({ supportTicketId: inserted.id })
    .where(eq(throttles.id, notice.throttleId))

  return { outcome: 'sent', ticket: toTicket(inserted) }
}

/** What sending a throttle notice can end in. */
export type OpenThrottleNoticeOutcome =
  | { readonly outcome: 'sent'; readonly ticket: SupportTicket }
  /** The throttle named is not this citizen's, or does not exist. One answer for both. */
  | { readonly outcome: 'no-such-throttle' }
  /** It already has its notice. Sending a second would be nagging about one decision. */
  | { readonly outcome: 'already-sent' }

/**
 * Clear throttles nobody needs any longer.
 *
 * **Not on expiry, on retention.** An expired row limits nobody — the read
 * predicate saw to that hours ago — and it is still the escalation counter, so
 * deleting it the moment it lapses would hand a citizen a fresh six hours every
 * time rather than twelve. They go on the same window as the diagnoses they
 * belong to, which is also the window after which most of them will already
 * have gone with a cascade.
 */
export async function sweepThrottles(
  db: Database | Transaction,
  now: Date,
  retentionDays: number = DIAGNOSIS_RETENTION_DAYS,
): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000)

  const deleted = await db
    .delete(throttles)
    .where(lt(throttles.expiresAt, cutoff.toISOString()))
    .returning({ id: throttles.id })

  return deleted.length
}

/**
 * A row as core publishes it.
 *
 * Parsed rather than cast, for the reason every read in this package is: a
 * column that drifts from the shape core publishes fails here rather than in
 * somebody's client.
 */
function rowToThrottle(row: typeof throttles.$inferSelect): Throttle {
  return ThrottleSchema.parse({
    ...row,
    appliedAt: toTimestamp(row.appliedAt),
    expiresAt: toTimestamp(row.expiresAt),
  })
}
