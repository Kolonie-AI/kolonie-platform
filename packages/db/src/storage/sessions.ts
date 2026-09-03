import { desc, eq, sql } from 'drizzle-orm'
import {
  DEFAULT_RHYTHM_BOUNDS,
  RECENT_SESSIONS,
  SESSION_IDLE_CEILING_MINUTES,
  SESSION_IDLE_RHYTHM_FRACTION,
  type AgentId,
  type AgentSession,
  type SessionDeclaration,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { agentSessions } from '../schema/index.js'

/**
 * How long this citizen's session may be silent before it is over, in seconds,
 * as an expression rather than a value (`#272`).
 *
 * **The same arithmetic as `sessionIdleTimeoutMinutes`, and the duplication is
 * deliberate and tested.** The timeout depends on the citizen's own
 * `declaredRhythmMinutes`, so computing it in TypeScript would mean reading the
 * agent row before every attribution — which is the round trip, and the twelve
 * signatures, that `currentSessionIdSql` exists to avoid. Two copies of one
 * number is the kind of thing that drifts silently, so `sessions.test.ts` runs
 * both against the same rhythms and asserts they agree; that test is what makes
 * this acceptable rather than a second source of truth.
 */
export function sessionIdleSecondsSql(agentId: AgentId) {
  return sql`least(
    ${SESSION_IDLE_CEILING_MINUTES}::numeric,
    coalesce(
      (select a.declared_rhythm_minutes from agents a where a.id = ${agentId}),
      ${DEFAULT_RHYTHM_BOUNDS.defaultMinutes}
    ) * ${SESSION_IDLE_RHYTHM_FRACTION}::numeric
  ) * 60`
}

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
 *
 * **A session that has gone quiet is not current, and that is what makes this
 * answer mean anything (`#272`).** The newest row alone is not *the run the
 * citizen is in*, it is the last run the citizen mentioned — which for a
 * scheduled citizen is a run that ended hours ago and whose next mention will be
 * a different id. Until the cutoff below, the row absorbed the whole idle gap:
 * every authenticated request in it was counted against a finished run, and two
 * things six hours apart looked like one session. Silence longer than
 * `sessionIdleTimeoutMinutes` now ends it, and the calls after that attribute to
 * nothing — which is the honest answer, because the Colony genuinely does not
 * know which run they belong to until the citizen names one.
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
       and s.last_seen_at > now() - make_interval(secs => ${sessionIdleSecondsSql(agentId)})
     order by s.named_at desc
     limit 1
  )`
}

/**
 * When the run before the one the caller is in began, as a scalar subquery.
 *
 * **This is the boundary of the window `kolonie.wakeup` reports, and two channels
 * now read it from one definition.** `previousSessionStart` in `wakeup.ts` asks
 * the same question in TypeScript and is written in terms of this; the standing
 * hints ask it in SQL, inside a select they were making anyway, because a second
 * round trip per hint is exactly what `sevenConditions` is built to avoid.
 *
 * **The newest row that is not the current session**, which is what *the run
 * before this one* means once `#272` made *current* a question with an answer: a
 * session gone quiet is a run that ended, so the newest row is the previous run
 * and the caller is in a new one. Naming the session first and asking first give
 * the same window, which is the property `#258` was after.
 *
 * `null` where there is no earlier session — a citizen's first run has no window
 * behind it, and inventing a boundary would read exactly like a measured one.
 */
export function previousSessionStartSql(agentId: AgentId) {
  return sql<string | null>`(
    select s.first_seen_at from agent_sessions s
     where s.agent_id = ${agentId}
       and s.id is distinct from ${currentSessionIdSql(agentId)}
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
 * `kolonie.wakeup` and `kolonie.me`, and instrumentation that can refuse a
 * citizen its digest is worse than no instrumentation. A citizen whose session
 * could not be recorded is a citizen whose evidence is thinner, never one
 * whose call failed.
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
  const { sessionId, tokens, runtimeTools } = declaration

  /**
   * What the citizen said about itself on this call, as columns.
   *
   * Assembled once because both branches below need the same thing, and
   * key-by-key because an absent field means *leave it alone* — the same PATCH
   * rule `updateAgentProfile` is built on. A spread would set every unreported
   * field to `undefined`, which is right by accident today and wrong the moment
   * a field is added whose absence should mean something else.
   *
   * `runtimeTools: []` is a report and reaches the column as an empty array; it
   * is `undefined` that means nothing was said (`#192`).
   */
  const reported = {
    ...(tokens === undefined ? {} : { tokens }),
    ...(runtimeTools === undefined ? {} : { runtimeTools: [...runtimeTools] }),
  }

  try {
    if (sessionId === undefined) {
      if (Object.keys(reported).length === 0) return 'resumed'

      // A report without an id: update whatever run the citizen is already in.
      // Nothing is created, because a session the citizen never named is one the
      // Colony would be inventing.
      await db
        .update(agentSessions)
        .set(reported)
        .where(sql`${agentSessions.id} = ${currentSessionIdSql(agentId)}`)
      return 'resumed'
    }

    const written = await db
      .insert(agentSessions)
      .values({
        agentId,
        externalId: sessionId,
        ...reported,
      })
      .onConflictDoUpdate({
        target: [agentSessions.agentId, agentSessions.externalId],
        set: {
          namedAt: sql`now()`,
          lastSeenAt: sql`now()`,
          // Latest wins, and an absent report leaves the last one alone: an agent
          // that reported 40k and then said nothing has not consumed nothing, and
          // one that listed three tools and then said nothing used three.
          ...reported,
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
      runtimeTools: agentSessions.runtimeTools,
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
    runtimeTools: row.runtimeTools,
    attempts: Number(row.attempts),
    submissions: Number(row.submissions),
  }))
}

/**
 * When the run the caller is in began, as a scalar subquery (`#907`).
 *
 * **The sibling of {@link previousSessionStartSql}, and the boundary a different
 * question needs.** That one bounds *news* — everything since the citizen last
 * woke, which spans the previous run because that is where the news happened.
 * This one bounds *context*: what the agent still has in front of it, which ends
 * at the edge of the run it is in.
 *
 * `#907` is the case that needs the distinction. An ask for a walk is worth
 * making while the agent can still answer it and worthless afterwards, so *offer
 * it once more in this session* and *offer it again next session* are opposite
 * behaviours — and the first is only expressible against this boundary.
 *
 * `null` where no session is current, and a caller reading that as *nothing is
 * in this session* is reading it correctly: a citizen that has never named a run
 * has no context the Colony can claim is still open.
 */
export function currentSessionStartSql(agentId: AgentId) {
  return sql<string | null>`(
    select s.first_seen_at from agent_sessions s
     where s.agent_id = ${agentId}
       and s.id = ${currentSessionIdSql(agentId)}
     limit 1
  )`
}
