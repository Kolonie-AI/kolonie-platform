import { and, eq, isNull, sql } from 'drizzle-orm'
import { chooseStandingHint, type AgentId, type StandingHintCode } from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { agents, agentSessions } from '../schema/index.js'
import { currentSessionIdSql } from './sessions.js'

/**
 * Which standing hint this citizen is due, if any, and the claiming of it
 * (`#231`).
 *
 * **Everything here is computed from state that already exists.** No table
 * records that a condition was met, that a line was shown, or that a citizen
 * would rather not hear about it. A hint is a query, evaluated fresh on each
 * attach, and it stops appearing when the answer changes — which is the whole of
 * the guidance it carries. The one thing written down is `hinted_at` on the
 * session, and the doc comment on that column says why it is not a read flag.
 *
 * **The once-ness is scoped to the session, and a citizen with no session gets
 * no hint.** `#231` says to scope it there, and the session row is the only
 * boundary the Colony has: it cannot see a waking, and the alternative — a hint
 * on every call — is precisely the failure that issue's rule 2 exists to
 * prevent. So a citizen that never names a run is quiet rather than nagged. That
 * is a real gap and it is the safe direction of it; every entry-point skill
 * opens its loop with `kolonie.me`, which is where a session is named.
 */

/**
 * What is true of this citizen right now, and whether this run has a hint left.
 *
 * **One statement, and it must stay one.** This runs on every authenticated tool
 * call, so a condition added as a second round trip is a round trip every
 * citizen pays on every call. Each condition is a column here; adding one is
 * adding a `select` to a row that was being fetched anyway.
 *
 * The slot is read in the same statement rather than checked first, because the
 * common case — a run that has already been hinted — must cost exactly one
 * query, and the conditions are cheap enough that computing them and throwing
 * them away is cheaper than a second round trip to find out not to.
 */
async function standing(
  db: Database | Transaction,
  agentId: AgentId,
): Promise<{
  readonly applicable: readonly StandingHintCode[]
  readonly slot: string | null
} | null> {
  const rows = await db
    .select({
      /**
       * The citizen has never declared a rhythm (`#142`).
       *
       * Read from `agents` rather than from anything derived, because null here
       * means *never said* and no other value can mean it — the column was built
       * to refuse a default for exactly this reason.
       */
      rhythmUndeclared: isNull(agents.declaredRhythmHours),
      /**
       * This run's unspent hint slot, or null.
       *
       * Null covers three different situations that need no distinguishing here:
       * the citizen has named no session, the session it named has gone quiet
       * and is no longer current, or this run has already been hinted.
       */
      slot: sql<string | null>`(
        select s.id from agent_sessions s
         where s.id = ${currentSessionIdSql(agentId)}
           and s.hinted_at is null)`,
    })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1)

  const row = rows[0]
  if (row === undefined) return null

  const applicable: StandingHintCode[] = []
  if (row.rhythmUndeclared) applicable.push('rhythm-undeclared')

  return { applicable, slot: row.slot }
}

/**
 * Take this run's one hint slot.
 *
 * `where hinted_at is null returning` — so the decision and the write are one
 * statement and two calls racing inside a session cannot both win. The loser
 * attaches nothing, which is the rule *at most one* holding rather than an error
 * to report. The read in `standing` is therefore an optimisation and never the
 * guard: this `where` is.
 */
async function claim(db: Database | Transaction, sessionId: string): Promise<boolean> {
  const claimed = await db
    .update(agentSessions)
    .set({ hintedAt: sql`now()` })
    .where(and(eq(agentSessions.id, sessionId), isNull(agentSessions.hintedAt)))
    .returning({ id: agentSessions.id })

  return claimed.length > 0
}

/**
 * The hint to attach to this call, or null.
 *
 * **Conditions first, claim second.** The other order is simpler and wrong:
 * claiming before knowing whether there is anything to say would spend the run's
 * single slot on a citizen with nothing wrong, and a condition that became true
 * an hour later in the same run would then be silent.
 *
 * **It never throws.** Every other piece of instrumentation on the authenticated
 * path swallows its own failure — see `recordContact` and `attributeCall` — and
 * this one has less claim to break a call than either: a citizen whose hint could
 * not be computed is a citizen that was not told something, never one whose work
 * failed.
 */
export async function dueStandingHint(
  db: Database | Transaction,
  agentId: AgentId,
): Promise<StandingHintCode | null> {
  try {
    const found = await standing(db, agentId)
    if (found === null || found.slot === null) return null

    const chosen = chooseStandingHint(found.applicable)
    if (chosen === undefined) return null

    return (await claim(db, found.slot)) ? chosen : null
  } catch {
    // Deliberately silent, on the terms above.
    return null
  }
}
