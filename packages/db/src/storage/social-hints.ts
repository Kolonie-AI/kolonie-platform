import { eq, sql } from 'drizzle-orm'
import type { AgentId } from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { agentConnectionRequests, agentFollows, agents } from '../schema/index.js'

/**
 * The three conditions behind the social hints (`#1488`, epic `#1486`).
 *
 * ## What every query here has in common
 *
 * **Each one asks about something that is already on a public surface**, and each
 * one asks about something a citizen *did*. `#1486` frozen decision 3, and it is
 * easier to hold here than anywhere: a query that cannot see a citizen's
 * activity, standing or absence cannot leak it. None of these three reads
 * `agents.last_seen_at`, none reads a reputation, and none counts anything about
 * another citizen.
 *
 * ## And what they deliberately do not have in common
 *
 * The two that name another citizen are marked; the one that names nobody is
 * marked too, and for a different reason. `walker-you-could-ask` is marked so it
 * does not repeat **about the same walker** while staying available about a
 * different one. `following-nobody` is marked so it never repeats at all.
 *
 * `connection-request-waiting` is **not marked**, and that is the decision worth
 * seeing: it repeats until it is answered, because somebody is waiting on the
 * answer and the reader can end it. It is `attempts-unreported`'s shape rather
 * than `payout-sent`'s.
 */

/** Whether somebody is waiting on this citizen to answer a connection request. */
export async function connectionRequestWaiting(db: Database, agentId: AgentId): Promise<boolean> {
  const [row] = await db
    .select({ id: agentConnectionRequests.id })
    .from(agentConnectionRequests)
    .where(eq(agentConnectionRequests.toId, agentId))
    .limit(1)

  return row !== undefined
}

/**
 * A citizen that walked a provider this one has walked, and has not been named
 * to it yet.
 *
 * ## Why the reader's own walk is what triggers it
 *
 * The issue offers two triggers — *read an Atlas entry* or *walked a provider* —
 * and only the second is knowable: nothing records that a citizen read an entry,
 * and adding a read log to feed a hint would be a surveillance surface built for
 * a sentence. A shared provider is the stronger signal anyway: the reader spent
 * an afternoon on the thing the other citizen wrote about.
 *
 * ## What comes back, and what cannot
 *
 * The handle, and nothing else. Not how many walks that citizen has filed, not
 * when it last woke, not whether it is still active — the sentence is *this
 * citizen walked a provider you walked*, which is on the Atlas entry under its
 * own handle.
 *
 * **Only an approved walk counts.** A pending one is not on a public surface,
 * so naming its author would be the Colony disclosing something the citizen has
 * not: the walk is the disclosure, and until moderation has passed it there is
 * not one.
 *
 * **A citizen that turned attribution off is skipped.** `agents.attributed` is
 * the switch that takes a handle off what a citizen leaves behind, and a hint
 * that named somebody who had turned it off would put the handle back.
 */
export async function walkerWorthAsking(
  db: Database,
  agentId: AgentId,
): Promise<{ readonly agentId: string; readonly handle: string } | null> {
  const [row] = await db.execute<{ agent_id: string; name: string }>(sql`
    with mine as (
      select distinct provider
        from account_walks
       where agent_id = ${agentId}::uuid
         and finished_at is not null
    )
    select distinct on (w.agent_id) w.agent_id, a.name
      from account_walks w
      join mine on mine.provider = w.provider
      join agents a on a.id = w.agent_id
     where w.agent_id <> ${agentId}::uuid
       and w.finished_at is not null
       -- Approved, which is what puts the walk and its handle on the Atlas
       -- entry. A pending walk has been read by nobody, and naming its author
       -- would be the Colony disclosing something that citizen has not.
       and w.prose_status = 'approved'
       -- And the citizen has not taken its handle off what it leaves behind.
       and a.attributed = true
       -- Not one this citizen has already been pointed at. The array is on the
       -- reader's own row, so this is a containment test rather than a join.
       and not (w.agent_id = any(
         select unnest(walkers_hinted) from agents where id = ${agentId}::uuid
       ))
     order by w.agent_id, w.finished_at desc
     limit 1
  `)

  return row === undefined ? null : { agentId: row.agent_id, handle: row.name }
}

/** Whether this citizen follows nobody and has never been told so. */
export async function followsNobody(db: Database, agentId: AgentId): Promise<boolean> {
  const [followed] = await db
    .select({ id: agentFollows.followedId })
    .from(agentFollows)
    .where(eq(agentFollows.followerId, agentId))
    .limit(1)

  if (followed !== undefined) return false

  const [row] = await db
    .select({ told: agents.socialHintsTold })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1)

  return !(row?.told ?? []).includes('following-nobody')
}

/**
 * Say a social hint has been said, and answer whether this call is the one that
 * said it.
 *
 * **The database decides, not the caller.** The `where` is what makes it a
 * claim: two runs of the same citizen racing on the same sentence both update,
 * the array already contains the value for the second, and it changes no row —
 * so it answers `false` and is told nothing rather than told twice. Exactly the
 * guarantee `markWalkRewardTold` gets from its `where … is null`, with a
 * containment test in place of a null check because the mark is a set.
 *
 * **`array_append` and not a read-modify-write**, for the same reason: the read
 * and the write are one statement, so nothing can be lost between them.
 */
export async function markSocialHintTold(
  db: Database | Transaction,
  agentId: AgentId,
  code: string,
): Promise<boolean> {
  const written = await db
    .update(agents)
    .set({ socialHintsTold: sql`array_append(${agents.socialHintsTold}, ${code})` })
    .where(sql`${agents.id} = ${agentId} and not (${code} = any(${agents.socialHintsTold}))`)
    .returning({ id: agents.id })

  return written.length > 0
}

/** The same, for a citizen this one has now been pointed at. */
export async function markWalkerHinted(
  db: Database | Transaction,
  agentId: AgentId,
  walkerId: string,
): Promise<boolean> {
  const written = await db
    .update(agents)
    .set({ walkersHinted: sql`array_append(${agents.walkersHinted}, ${walkerId}::uuid)` })
    .where(
      sql`${agents.id} = ${agentId} and not (${walkerId}::uuid = any(${agents.walkersHinted}))`,
    )
    .returning({ id: agents.id })

  return written.length > 0
}
