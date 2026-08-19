import { and, desc, eq, gt, lt, sql } from 'drizzle-orm'
import {
  ABUSIVE_SUSPEND_MIN_COUNT,
  ABUSIVE_SUSPEND_MIN_RATE,
  ABUSIVE_SUSPEND_REPEAT_WINDOW_DAYS,
  ABUSIVE_SUSPEND_WINDOW_DAYS,
  ABUSIVE_WARN_MIN_COUNT,
  CONTRIBUTION_VERDICT_RETENTION_DAYS,
  ContributionSurfaceSchema,
  unrecordedSuspensionStanding,
  type AgentId,
  type ContributionQualityAnswer,
  type ContributionSurface,
  type ContributionVerdict,
  type SuspensionStanding,
  type Timestamp,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { agents, contributionVerdicts } from '../schema/index.js'
import {
  lapseExpiredSuspensions,
  latestSuspensionStartedAt,
  suspendCitizen,
  suspensionStandingOf,
} from './citizenship.js'

/**
 * One ledger row, as a moderation path hands it over (`#1259`).
 *
 * Written inside the transaction that applied the verdict — a ledger row that
 * can be lost on its own is a denominator that quietly drifts. Callers skip the
 * write on `stale`: the verdict was never applied.
 */
export interface ContributionVerdictInput {
  readonly agentId: AgentId
  readonly surface: ContributionSurface
  readonly verdict: ContributionVerdict
  /** Required shape for a refusal; omit (or leave undefined) on an approval. */
  readonly reason?: string | undefined
}

/**
 * Append one row to the contribution verdict ledger.
 *
 * Takes `Database | Transaction` so every caller can write it inside the
 * transaction that applied the verdict.
 */
export async function insertContributionVerdict(
  db: Database | Transaction,
  input: ContributionVerdictInput,
): Promise<void> {
  await db.insert(contributionVerdicts).values({
    agentId: input.agentId,
    surface: input.surface,
    verdict: input.verdict,
    reason: input.verdict === 'approved' ? null : (input.reason ?? null),
  })
}

/**
 * Delete rows past the retention window (`#1259`).
 *
 * `now` is an argument, like `sweepDiagnoses`: a retention boundary that cannot
 * be tested without waiting for one is not tested.
 */
export async function sweepContributionVerdicts(
  db: Database | Transaction,
  now: Date,
  retentionDays: number = CONTRIBUTION_VERDICT_RETENTION_DAYS,
): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString()

  const deleted = await db
    .delete(contributionVerdicts)
    .where(lt(contributionVerdicts.decidedAt, cutoff))
    .returning({ id: contributionVerdicts.id })

  return deleted.length
}

/** One citizen's judged-contribution tally inside the suspension window (`#1261`). */
export interface AbusiveRateTally {
  readonly agentId: AgentId
  readonly abusive: number
  readonly total: number
}

/**
 * Whether both suspension bounds hold for a tally (`#1261`).
 *
 * Exported so the boundary tests assert the same predicate the sweep uses —
 * a test that reimplements `>= 5 && > 0.4` would keep passing while the sweep
 * moved underneath it.
 */
export function meetsAbusiveSuspendBounds(tally: {
  readonly abusive: number
  readonly total: number
}): boolean {
  if (tally.total <= 0) return false
  return (
    tally.abusive >= ABUSIVE_SUSPEND_MIN_COUNT &&
    tally.abusive / tally.total > ABUSIVE_SUSPEND_MIN_RATE
  )
}

/**
 * Effective window start for one citizen's rate / quality reads (`#1261`, `#1262`).
 *
 * Later of (now − 90 days) and the most recent timed suspension's `started_at`.
 */
async function abusiveRateWindowSince(
  db: Database | Transaction,
  agentId: AgentId,
  now: Date,
): Promise<string> {
  const windowStart = new Date(
    now.getTime() - ABUSIVE_SUSPEND_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString()
  const floor = await latestSuspensionStartedAt(db, agentId)
  return floor !== null && floor > windowStart ? floor : windowStart
}

/**
 * Count judged contributions for one citizen inside the effective window (`#1261`).
 *
 * The window starts at the later of (now − 90 days) and the most recent timed
 * suspension's `started_at`. Verdicts at or before that suspension do not
 * recount; punishing the same rows twice is not something we would defend.
 */
export async function abusiveRateTallyFor(
  db: Database | Transaction,
  agentId: AgentId,
  now: Date,
): Promise<AbusiveRateTally> {
  const since = await abusiveRateWindowSince(db, agentId, now)

  const [row] = await db
    .select({
      abusive: sql<number>`count(*) filter (where ${contributionVerdicts.verdict} = 'abusive')::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(contributionVerdicts)
    .where(
      and(eq(contributionVerdicts.agentId, agentId), gt(contributionVerdicts.decidedAt, since)),
    )

  return {
    agentId,
    abusive: row?.abusive ?? 0,
    total: row?.total ?? 0,
  }
}

/**
 * Citizens that currently meet both abusive-rate bounds (`#1261`).
 *
 * Only `candidate` and `citizen` — an already-suspended agent is not suspended
 * again, and a ban is a decision a person took. The rate floor per citizen is
 * applied in SQL so a prolific Colony is not loaded into memory to be filtered.
 */
export async function agentsMeetingAbusiveSuspendBounds(
  db: Database | Transaction,
  now: Date,
): Promise<AbusiveRateTally[]> {
  const windowStart = new Date(
    now.getTime() - ABUSIVE_SUSPEND_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString()

  /**
   * Per agent: decided_at must be after both the 90-day cutoff and any prior
   * timed suspension's started_at. `coalesce(max(started_at), '-infinity')`
   * makes the "no prior suspension" case just the 90-day window.
   */
  const rows = await db.execute<{
    agent_id: string
    abusive: number
    total: number
  }>(sql`
    with floors as (
      select
        a.id as agent_id,
        greatest(
          ${windowStart}::timestamptz,
          coalesce(
            (select max(s.started_at) from citizenship_suspensions s where s.agent_id = a.id),
            '-infinity'::timestamptz
          )
        ) as since
      from agents a
      where a.status in ('candidate', 'citizen')
    ),
    tallies as (
      select
        f.agent_id,
        count(*) filter (where v.verdict = 'abusive')::int as abusive,
        count(*)::int as total
      from floors f
      inner join contribution_verdicts v
        on v.agent_id = f.agent_id
       and v.decided_at > f.since
      group by f.agent_id
    )
    select agent_id, abusive, total
    from tallies
    where abusive >= ${ABUSIVE_SUSPEND_MIN_COUNT}
      and abusive::float / total > ${ABUSIVE_SUSPEND_MIN_RATE}
  `)

  return rows.map((row) => ({
    agentId: row.agent_id as AgentId,
    abusive: Number(row.abusive),
    total: Number(row.total),
  }))
}

/** What one daily abusive-suspension pass did (`#1261`). */
export interface AbusiveSuspensionSweepResult {
  readonly lapsed: number
  readonly suspended: number
  readonly tickets: number
}

/**
 * Daily pass: lapse expired timed suspensions, then impose new ones (`#1261`).
 *
 * Lapses first so a citizen whose fourteen days just ended is not immediately
 * re-suspended on the same rows — those rows sit at or before the suspension's
 * `started_at` and the rate floor excludes them. `now` is an argument for the
 * same reason the retention sweep takes one.
 */
export async function sweepAbusiveRateSuspensions(
  db: Database,
  now: Date,
): Promise<AbusiveSuspensionSweepResult> {
  const { lapsed } = await lapseExpiredSuspensions(db, now)

  const meeting = await agentsMeetingAbusiveSuspendBounds(db, now)
  let suspended = 0
  let tickets = 0

  for (const tally of meeting) {
    const ticketBody = await buildThirdStrikeTicketBody(db, tally.agentId, now, tally)

    const result = await db.transaction((tx) =>
      suspendCitizen(tx, {
        agentId: tally.agentId,
        source: 'abusive-rate',
        at: now,
        ticketBody,
      }),
    )

    if (result.outcome === 'suspended') {
      suspended += 1
      if (result.ticketId !== null) tickets += 1
    }
  }

  return { lapsed, suspended, tickets }
}

/**
 * Build the third-strike ticket body: citizen name, tally, and recent abusive
 * reasons. Always long enough for the ticket body minimum; unused when the
 * suspension is not a third strike.
 */
async function buildThirdStrikeTicketBody(
  db: Database,
  agentId: AgentId,
  now: Date,
  tally: AbusiveRateTally,
): Promise<string> {
  const [agent] = await db
    .select({ name: agents.name })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1)

  const windowStart = new Date(
    now.getTime() - ABUSIVE_SUSPEND_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString()
  const floor = await latestSuspensionStartedAt(db, agentId)
  const since = floor !== null && floor > windowStart ? floor : windowStart

  const abusiveRows = await db
    .select({
      surface: contributionVerdicts.surface,
      reason: contributionVerdicts.reason,
      decidedAt: contributionVerdicts.decidedAt,
    })
    .from(contributionVerdicts)
    .where(
      and(
        eq(contributionVerdicts.agentId, agentId),
        eq(contributionVerdicts.verdict, 'abusive'),
        gt(contributionVerdicts.decidedAt, since),
      ),
    )

  const history =
    abusiveRows.length === 0
      ? '(no abusive rows in the current window)'
      : abusiveRows
          .map(
            (row) =>
              `- ${row.decidedAt.slice(0, 10)} ${row.surface}: ${row.reason ?? '(no reason)'}`,
          )
          .join('\n')

  return (
    `Citizen ${agent?.name ?? agentId} (${agentId}) has reached a third citizenship ` +
    `suspension inside ${ABUSIVE_SUSPEND_REPEAT_WINDOW_DAYS} days. Abusive rate now: ` +
    `${tally.abusive}/${tally.total}. No automatic ban — a maintainer decides.\n\n` +
    `Abusive verdict history in the current window:\n${history}`
  )
}

/**
 * The suspension standing a citizen is owed, row or no row (`#1341`).
 *
 * `null` means *not suspended*. A `suspended` status with no open row is the
 * walk-prose shape (`#1097`), and it arrives as the `unrecorded` standing —
 * word for word the one `kolonie.me` hands over, because a citizen comparing
 * the two surfaces is comparing sentences and not schemas.
 */
async function suspensionStanding(
  db: Database | Transaction,
  agentId: AgentId,
): Promise<SuspensionStanding | null> {
  const { suspended, row } = await suspensionStandingOf(db, agentId)
  if (!suspended) return null
  return row === null ? unrecordedSuspensionStanding() : row
}

/**
 * The citizen's own contribution-quality ledger (`#1262`).
 *
 * **Changes nothing** — a pure read, on the same terms as `kolonie.doctor`.
 * Counts by surface; reasons only on `abusive` rows; `useless` counted and
 * labelled as counting toward nothing. Standing uses the same floored window
 * the suspend sweep does.
 *
 * ## The suspension it reports is the citizen's, not this ledger's (`#1341`)
 *
 * It read `citizenship_suspensions` and nothing else, so a citizen suspended by
 * the walk-prose rule — which writes `agents.status` and no row — was told
 * `suspension: null` here minutes after `kolonie.me` told it it was suspended.
 * The counts above genuinely cannot see that rule; the status can, and does.
 * {@link suspensionStandingOf} is the same read `kolonie.me` and the digest
 * make, so all three now answer one fact once.
 */
export async function contributionQualityFor(
  db: Database | Transaction,
  agentId: AgentId,
  now: Date,
): Promise<ContributionQualityAnswer> {
  const since = await abusiveRateWindowSince(db, agentId, now)

  const surfaceRows = await db
    .select({
      surface: contributionVerdicts.surface,
      approved: sql<number>`count(*) filter (where ${contributionVerdicts.verdict} = 'approved')::int`,
      useless: sql<number>`count(*) filter (where ${contributionVerdicts.verdict} = 'useless')::int`,
      abusive: sql<number>`count(*) filter (where ${contributionVerdicts.verdict} = 'abusive')::int`,
    })
    .from(contributionVerdicts)
    .where(
      and(eq(contributionVerdicts.agentId, agentId), gt(contributionVerdicts.decidedAt, since)),
    )
    .groupBy(contributionVerdicts.surface)

  const bySurface = {} as ContributionQualityAnswer['bySurface']
  for (const surface of ContributionSurfaceSchema.options) {
    bySurface[surface] = { approved: 0, useless: 0, abusive: 0 }
  }
  for (const row of surfaceRows) {
    const surface = row.surface as ContributionSurface
    bySurface[surface] = {
      approved: Number(row.approved),
      useless: Number(row.useless),
      abusive: Number(row.abusive),
    }
  }

  let approved = 0
  let useless = 0
  let abusive = 0
  for (const counts of Object.values(bySurface)) {
    approved += counts.approved
    useless += counts.useless
    abusive += counts.abusive
  }
  const judged = approved + useless + abusive

  const abusiveRows = await db
    .select({
      surface: contributionVerdicts.surface,
      reason: contributionVerdicts.reason,
      decidedAt: contributionVerdicts.decidedAt,
    })
    .from(contributionVerdicts)
    .where(
      and(
        eq(contributionVerdicts.agentId, agentId),
        eq(contributionVerdicts.verdict, 'abusive'),
        gt(contributionVerdicts.decidedAt, since),
      ),
    )
    .orderBy(desc(contributionVerdicts.decidedAt))

  const suspension = await suspensionStanding(db, agentId)

  return {
    windowDays: ABUSIVE_SUSPEND_WINDOW_DAYS,
    bySurface,
    totals: { approved, useless, abusive, judged },
    abusiveReasons: abusiveRows.map((row) => ({
      surface: row.surface as ContributionSurface,
      reason: row.reason,
      decidedAt: row.decidedAt as Timestamp,
    })),
    standing: {
      abusive,
      judged,
      rate: judged === 0 ? null : abusive / judged,
      warnAt: ABUSIVE_WARN_MIN_COUNT,
      suspendMinCount: ABUSIVE_SUSPEND_MIN_COUNT,
      suspendMinRate: ABUSIVE_SUSPEND_MIN_RATE,
      meetsSuspendBounds: meetsAbusiveSuspendBounds({ abusive, total: judged }),
      measures: 'abusive-verdict-rate',
      uselessCountsToward: 'nothing',
    },
    suspension,
  }
}

/**
 * When the abusive-quality wakeup warning was last shown (`#1262`).
 *
 * `null` means never. Read-only; the stamp is {@link markAbusiveQualityWarned}.
 */
export async function abusiveQualityWarnedAt(
  db: Database | Transaction,
  agentId: AgentId,
): Promise<Date | null> {
  const [row] = await db
    .select({ at: agents.abusiveQualityWarnedAt })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1)

  return row?.at === null || row?.at === undefined ? null : new Date(row.at)
}

/**
 * Record that the wakeup just showed the abusive-quality warning (`#1262`).
 *
 * A sender-side stamp only — nothing about standing, reputation or skills reads
 * it. Safe to call twice; the later timestamp wins.
 */
export async function markAbusiveQualityWarned(
  db: Database | Transaction,
  agentId: AgentId,
  at: Date,
): Promise<void> {
  await db
    .update(agents)
    .set({ abusiveQualityWarnedAt: at.toISOString(), updatedAt: at.toISOString() })
    .where(eq(agents.id, agentId))
}
