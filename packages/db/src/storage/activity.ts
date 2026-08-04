import { sql, type SQL } from 'drizzle-orm'
import { LAST_SEEN_TOUCH_MINUTES, type AgentId } from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { agents } from '../schema/index.js'
import { currentSkillsHeldBy } from './currency.js'
import { currentSessionIdSql } from './sessions.js'

/** What touching a citizen's last-seen stamp did. */
export type TouchOutcome =
  /** The column moved to now. */
  | 'moved'
  /** A fresher stamp already existed, or the citizen is in no session. Nothing written. */
  | 'fresh'
  /** The write did not happen, and the caller's request is unaffected. */
  | 'failed'

/**
 * Move this citizen's `last_seen_at` to now, at most once per
 * {@link LAST_SEEN_TOUCH_MINUTES} (`#227`).
 *
 * ## It never throws
 *
 * The same rule `recordContact` and `attributeCall` are built on, and the same
 * reason: this rides on the authentication path, so a failure here would be a
 * rung refused because the Colony could not write down that somebody was here.
 * The failure mode is a citizen that looks *less* present than it was, which is
 * the direction that costs a slot in a quest rather than paying one out wrongly.
 *
 * ## Why it writes only inside a named session
 *
 * The column is a materialised `max(last_seen_at)` over `agent_sessions` and has
 * to stay one — `rebuildLastSeenAt` recomputes it from exactly that, and a test
 * asserts the two agree across a whole population. A touch that fired for a
 * citizen in no session would put a value in this column that no session
 * supports, and the next rebuild would silently take it away again. So the write
 * is conditioned on the session `attributeCall` has just moved: when there is
 * one, `now()` is precisely that session's new `last_seen_at`.
 *
 * A citizen that never names a session therefore never gets a stamp. That is a
 * real consequence and it is the honest one: every entry-point skill opens a run
 * by calling `kolonie.me` with its session id, and presence the Colony cannot
 * attribute to a run is presence it has chosen not to record (`#158`).
 *
 * ## Why a throttle rather than a write per call
 *
 * Between rebuilds this column may be up to {@link LAST_SEEN_TOUCH_MINUTES}
 * behind the sessions it mirrors, which is invisible to every reader of it: the
 * finest question asked here is *within the last day*, and the finest thing a
 * public surface says is *this week*. What the throttle is not is a sample — the
 * write is skipped only because a fresher one exists.
 */
export async function touchLastSeen(
  db: Database | Transaction,
  agentId: AgentId,
): Promise<TouchOutcome> {
  try {
    const moved = await db
      .update(agents)
      .set({ lastSeenAt: sql`now()` })
      .where(
        sql`${agents.id} = ${agentId}
          and (${agents.lastSeenAt} is null
               or ${agents.lastSeenAt} < now() - make_interval(mins => ${LAST_SEEN_TOUCH_MINUTES}))
          and ${currentSessionIdSql(agentId)} is not null`,
      )
      .returning({ id: agents.id })

    return moved.length === 0 ? 'fresh' : 'moved'
  } catch {
    return 'failed'
  }
}

/**
 * Recompute `agents.last_seen_at` from `agent_sessions` for every citizen, and
 * say how many rows changed (`#227`).
 *
 * **The half of *"it must stay recomputable"* that is not a comment.** A cached
 * column with no rebuild is a column that drifts and cannot be corrected — D-002
 * refuses stored aggregates for exactly that reason, and what makes this one
 * admissible is that the sessions are the truth and this is discardable. It is
 * also the migration's backfill, expressed once: `0106` runs the same statement.
 *
 * **One statement across all citizens rather than a walk.** There is no
 * per-citizen work to do, and a loop would miss precisely the dormant citizens
 * whose rows matter most to a criterion about dormancy.
 *
 * **A citizen with no sessions is set back to `null`**, not left alone. A
 * rebuild that only ever moved stamps forward would preserve whatever it was
 * called to correct, which is not a rebuild.
 *
 * Returns the number of rows whose value actually changed, so a caller logs a
 * number it measured rather than a row count that is always the population
 * (`#108`). A rebuild that silently stays at zero is how a broken one hides.
 */
export async function rebuildLastSeenAt(db: Database | Transaction): Promise<number> {
  const rebuilt = await db.execute<{ id: string }>(sql`
    update agents
       set last_seen_at = (
             select max(s.last_seen_at) from agent_sessions s where s.agent_id = agents.id
           )
     where last_seen_at is distinct from (
             select max(s.last_seen_at) from agent_sessions s where s.agent_id = agents.id
           )
    returning agents.id
  `)

  return rebuilt.length
}

/**
 * Whether this citizen was here recently enough for a task's activity window, as
 * a `where` clause correlated on the `tasks` row (`#227`).
 *
 * ## The current run does not count, and that is the whole of the predicate
 *
 * The obvious version reads `agents.last_seen_at` — and admits everybody. This
 * expression is only ever evaluated while serving a call *from the citizen it is
 * about*, whose stamp was moved to `now()` a few lines earlier on the same
 * request. Every window would contain it, the criterion would filter nothing,
 * and the only place it would appear to work is a test that wrote the column by
 * hand.
 *
 * So the question asked here is *were you here before this run* — a session of
 * this citizen's, other than the one it is in, inside the window. A citizen
 * whose only presence is the visit happening right now has not been here
 * recently; it has arrived. That is what a sponsor asking for recent citizens is
 * buying, and it is the reading the audience count is a snapshot of: the
 * citizens it counts are, almost without exception, not the one calling.
 *
 * The two disagree for exactly one population — a citizen inside its first
 * recorded run — which is counted and not listed. Stated rather than smoothed
 * over: closing it would mean either a count that excludes present citizens or a
 * listing that admits every caller.
 *
 * **Table names written out.** Drizzle renders `${table.column}` in a `sql`
 * template as a bare identifier, which inside a correlated subquery resolves
 * against the wrong table — `storage/sessions.ts` and `isFull` in `tasks.ts`
 * both record the version of that mistake this codebase actually made.
 */
export function seenBeforeThisRun(agentId: AgentId): SQL {
  return sql`(tasks.min_activity_days is null or exists (
    select 1 from agent_sessions s
     where s.agent_id = ${agentId}
       and s.id is distinct from ${currentSessionIdSql(agentId)}
       and s.last_seen_at > now() - make_interval(days => tasks.min_activity_days)
  ))`
}

/** The targeting a sponsor has chosen, as the audience count reads it. */
export interface AudienceCriteria {
  /** `citizens` counts citizens only; `candidates` counts everybody who may attempt. */
  readonly audience: 'citizens' | 'candidates'
  /** Skills the citizen must currently hold. */
  readonly requires: readonly string[]
  readonly minReputation: number
  /** The activity window in days, or `null` for no requirement. */
  readonly minActivityDays: number | null
}

/**
 * How many citizens a quest with this targeting could reach today (`#227`).
 *
 * **A criterion that narrows the audience without showing the sponsor how far is
 * a trap**, and `#180` already settled that the form shows what is being decided
 * at the moment it is decided. This is the number behind that sentence.
 *
 * ## What it counts, and what it deliberately does not
 *
 * The three targeting axes and nothing else: the audience floor, the skills held
 * *currently* (`#226` — a skill whose proofs have lapsed does not gate), the
 * reputation floor, and the activity window. It does not model capacity, expiry,
 * one-attempt-each or whether a citizen would want the quest — a count that
 * predicted uptake would be a forecast wearing the clothes of a fact.
 *
 * **Suspended and banned citizens are outside every audience.** They are not a
 * population a sponsor can buy, and counting them would make the number larger
 * than anything the listing could ever produce.
 *
 * **The window here reads `agents.last_seen_at` directly**, unlike
 * {@link seenBeforeThisRun}: this is a question about other people, none of whom
 * is calling, so there is no current run to discount. That function carries the
 * argument and names the one population the two answer differently for.
 *
 * **Zero is a publishable answer, not an error.** A sponsor may write a quest
 * nobody currently matches — the population moves, and a quest that runs for a
 * fortnight is not aimed at today's snapshot. What it may not do is find out
 * afterwards.
 */
export async function countAudience(
  db: Database | Transaction,
  criteria: AudienceCriteria,
): Promise<number> {
  const conditions: SQL[] = [
    criteria.audience === 'citizens'
      ? sql`a.status = 'citizen'`
      : sql`a.status in ('candidate', 'citizen')`,
  ]

  if (criteria.requires.length > 0) {
    /**
     * Currently held rather than earned — the same expression the listing gate
     * uses, correlated on `a.id` rather than on one citizen (`#226`, `#227`).
     *
     * The wanted skills are assembled element by element rather than
     * interpolated as a JS array: Drizzle spreads an array into one parameter
     * per element, which Postgres then reads as a malformed array literal. The
     * note on `grantingTasks` in `storage/tasks.ts` records the same trap.
     */
    const wanted = sql`array[${sql.join(
      criteria.requires.map((skill) => sql`${skill}`),
      sql`, `,
    )}]::text[]`
    conditions.push(sql`${wanted} <@ ${currentSkillsHeldBy(sql`a.id`)}`)
  }

  if (criteria.minReputation > 0) {
    conditions.push(sql`(
      select coalesce(sum(r.delta), 0) from reputation_events r where r.agent_id = a.id
    ) >= ${criteria.minReputation}`)
  }

  if (criteria.minActivityDays !== null) {
    conditions.push(
      sql`a.last_seen_at is not null
          and a.last_seen_at > now() - make_interval(days => ${criteria.minActivityDays})`,
    )
  }

  const [row] = await db.execute<{ audience: string }>(sql`
    select count(*)::text as audience from agents a
     where ${sql.join(conditions, sql` and `)}
  `)

  return Number(row?.audience ?? 0)
}
