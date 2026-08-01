import { desc, eq, sql } from 'drizzle-orm'
import {
  RECENT_SESSIONS,
  type AgentId,
  type AgentSession,
  type SessionDeclaration,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { agentSessions } from '../schema/index.js'

/**
 * The citizen's current session, as a scalar subquery.
 *
 * **Written as SQL rather than resolved in TypeScript, and that is what keeps
 * this feature out of eleven call sites.** An attempt is opened deep inside
 * storage, where the only thing in scope is an agent id; threading a session
 * through every mint surface would have been the same fact carried by hand
 * through a dozen signatures. As a subquery it rides along inside the insert
 * that was happening anyway — no extra round trip, and no caller that can forget.
 *
 * **Attribution is per citizen rather than per credential.** `#158` describes it
 * as *"under the same credential"*, and the difference shows only for a citizen
 * running two keys in two sessions at once, whose calls would interleave between
 * them. That is inside the tolerance the issue sets for the whole feature — the
 * data is self-declared corroboration and nothing decides on it — and it is
 * bought with the plumbing above.
 */
export function currentSessionIdSql(agentId: AgentId) {
  // Aliased, and every column qualified. Drizzle renders `${table.column}` in a
  // `sql` template as a bare identifier, which in a correlated subquery silently
  // resolves against the wrong table — see the counts in `recentSessions` for
  // the version of that mistake this codebase actually made. An alias makes the
  // expression mean the same thing wherever it is embedded.
  return sql<string | null>`(
    select s.id from agent_sessions s
     where s.agent_id = ${agentId}
     order by s.named_at desc
     limit 1
  )`
}

/** What naming a session did. */
export type SessionOutcome =
  /** A session the Colony had not heard of. */
  | 'opened'
  /** One it had: the same id resumes rather than duplicating. */
  | 'resumed'
  /** The write did not happen, and the caller's request is unaffected. */
  | 'failed'

/**
 * Record the session a citizen says it is in, and take a token count if it sent
 * one (#158).
 *
 * **It never throws**, on the same terms as `recordContact`: this rides on
 * `kolonie.me`, the call every wake-up begins with, and instrumentation that can
 * refuse a citizen its rung is worse than no instrumentation. A citizen whose
 * session could not be recorded is a citizen whose evidence is thinner, never
 * one whose call failed.
 *
 * **The same id resumes.** `on conflict` updates rather than inserting, so a
 * citizen that names one id forever has one long session and a citizen that
 * re-names its session mid-run moves its own attribution back to it rather than
 * forking a second row.
 *
 * **A token count with no session id is accepted and applied to the current
 * session**, because that is what *the latest wins* has to mean for an agent
 * that learned its consumption after naming the run it was in.
 */
export async function nameSession(
  db: Database | Transaction,
  agentId: AgentId,
  declaration: SessionDeclaration,
): Promise<SessionOutcome> {
  const { sessionId, tokens } = declaration

  try {
    if (sessionId === undefined) {
      if (tokens === undefined) return 'resumed'

      // A count without an id: update whatever run the citizen is already in.
      // Nothing is created, because a session the citizen never named is one the
      // Colony would be inventing.
      await db
        .update(agentSessions)
        .set({ tokens })
        .where(sql`${agentSessions.id} = ${currentSessionIdSql(agentId)}`)
      return 'resumed'
    }

    const written = await db
      .insert(agentSessions)
      .values({
        agentId,
        externalId: sessionId,
        ...(tokens === undefined ? {} : { tokens }),
      })
      .onConflictDoUpdate({
        target: [agentSessions.agentId, agentSessions.externalId],
        set: {
          namedAt: sql`now()`,
          lastSeenAt: sql`now()`,
          // Latest wins, and an absent count leaves the last one alone: an agent
          // that reported 40k and then said nothing has not consumed nothing.
          ...(tokens === undefined ? {} : { tokens }),
        },
      })
      .returning({ firstSeenAt: agentSessions.firstSeenAt, namedAt: agentSessions.namedAt })

    const row = written[0]
    return row !== undefined && row.firstSeenAt === row.namedAt ? 'opened' : 'resumed'
  } catch {
    return 'failed'
  }
}

/**
 * Attribute one authenticated call to whatever session the citizen is in.
 *
 * A single statement keyed on the attribution subquery, so a citizen that has
 * never named a session pays for a lookup that matches nothing and writes
 * nothing. Like every other piece of instrumentation on this path it swallows
 * its own failure: see `recordContact` for the argument, which is the same one.
 */
export async function attributeCall(db: Database | Transaction, agentId: AgentId): Promise<void> {
  try {
    await db
      .update(agentSessions)
      .set({ calls: sql`${agentSessions.calls} + 1`, lastSeenAt: sql`now()` })
      .where(sql`${agentSessions.id} = ${currentSessionIdSql(agentId)}`)
  } catch {
    // Deliberately silent. A missing call count is a thinner diagnosis; a
    // failed request is a citizen that could not do its work.
  }
}

/**
 * A citizen's recent sessions and what happened in each (#158).
 *
 * **Its own read rather than a join onto attempts**, because the counts are the
 * point: *what happened in this run* is how many calls, how many attempts and
 * how many submissions, and a caller assembling that per session would be the
 * second answer to a question this already answers.
 *
 * Only ever the caller's own. There is no agent-id parameter a route could aim
 * at somebody else, which is the rule `readHistory` and the erasure surface are
 * both built on.
 */
export async function recentSessions(
  db: Database | Transaction,
  agentId: AgentId,
  limit: number = RECENT_SESSIONS,
): Promise<readonly AgentSession[]> {
  const rows = await db
    .select({
      sessionId: agentSessions.externalId,
      firstSeenAt: agentSessions.firstSeenAt,
      lastSeenAt: agentSessions.lastSeenAt,
      calls: agentSessions.calls,
      tokens: agentSessions.tokens,
      /**
       * The two counts, correlated on the outer row — and the table names are
       * spelled out rather than interpolated for a reason worth knowing.
       *
       * Drizzle renders `${table.column}` inside a `sql` template as a **bare**
       * identifier, so the obvious version of this produces
       * `where "session_id" = "id"`, both of which resolve inside the subquery's
       * own table. That is not an error: it is `task_attempts.session_id =
       * task_attempts.id`, which is false for every row, and the count comes
       * back as a confident zero. It was caught here by a test that had
       * attributed an attempt and expected to find it.
       */
      attempts: sql<string>`(select count(*) from task_attempts
        where task_attempts.session_id = agent_sessions.id)`,
      submissions: sql<string>`(select count(*) from submissions
        where submissions.session_id = agent_sessions.id)`,
    })
    .from(agentSessions)
    .where(eq(agentSessions.agentId, agentId))
    .orderBy(desc(agentSessions.namedAt))
    .limit(limit)

  return rows.map((row) => ({
    sessionId: row.sessionId,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    calls: row.calls,
    tokens: row.tokens,
    attempts: Number(row.attempts),
    submissions: Number(row.submissions),
  }))
}
