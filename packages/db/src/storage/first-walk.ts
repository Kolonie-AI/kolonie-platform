import { sql } from 'drizzle-orm'
import type { AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'

/**
 * The two reads behind the `first-walk` rung (`#1037`).
 *
 * **Their own file.** `account-walks.ts` is 1300 lines and is being edited by
 * the Atlas work; a rung's two reads appended to it would be a collision for
 * nothing — `kolonie-platform/AGENTS.md` §3, *independent work gets independent
 * files*.
 *
 * **Neither of them judges.** One answers *what has this citizen closed, and was
 * it first*, the other *is there any unwalked ground left at all*. Whether a
 * walk answered its questions is decided in `packages/verifiers` against core's
 * own definition, because that definition already exists there and a second one
 * here would be the one that drifts.
 */

/** One closed walk of a citizen's, with the fact the rung turns on. */
export interface ClosedWalkStanding {
  readonly id: string
  readonly kind: string
  readonly provider: string
  readonly outcome: string
  readonly finishedAt: string
  /**
   * Whether no walk at this (kind, provider) was started before this one, by
   * anybody — this citizen included.
   *
   * **Against every walk in the Colony and not against the catalogue.** A walk
   * at a provider the catalogue has never heard of is unwalked ground by the
   * strongest available definition, and joining `provider_recipes` here would
   * refuse the citizen that found somewhere genuinely new.
   *
   * **Earliest `started_at`, tie-broken by `id`.** Two walks opened in the same
   * microsecond would otherwise both be first or neither; the row comparison
   * makes the order total, so exactly one walk at a pair is ever first and the
   * rung cannot pay twice for the same ground under a race.
   */
  readonly firstInTheColony: boolean
  readonly did: string | null
  readonly broke: string | null
  readonly changed: string | null
  readonly discarded: string | null
  readonly note: string | null
}

/**
 * Every walk this citizen has closed, newest first, each saying whether it broke
 * new ground.
 *
 * Closed means `finished_at` and `outcome` are both set: a walk still running
 * has said nothing yet, and the rung reads reports rather than intentions.
 */
export async function closedWalkStandings(
  db: Database,
  agentId: AgentId,
): Promise<readonly ClosedWalkStanding[]> {
  const rows = await db.execute<{
    id: string
    kind: string
    provider: string
    outcome: string
    finished_at: Date | string
    first_in_the_colony: boolean
    did: string | null
    broke: string | null
    changed: string | null
    discarded: string | null
    note: string | null
  }>(sql`
    select w.id,
           w.kind,
           w.provider,
           w.outcome,
           w.finished_at,
           w.did,
           w.broke,
           w.changed,
           w.discarded,
           w.note,
           not exists (
             select 1
               from account_walks earlier
              where earlier.kind = w.kind
                and earlier.provider = w.provider
                and (earlier.started_at, earlier.id) < (w.started_at, w.id)
           ) as first_in_the_colony
      from account_walks w
     where w.agent_id = ${agentId}
       and w.finished_at is not null
       and w.outcome is not null
     order by w.finished_at desc, w.id desc
  `)

  return [...rows].map((row) => ({
    id: row.id,
    kind: row.kind,
    provider: row.provider,
    outcome: row.outcome,
    finishedAt: new Date(row.finished_at).toISOString(),
    firstInTheColony: row.first_in_the_colony,
    did: row.did,
    broke: row.broke,
    changed: row.changed,
    discarded: row.discarded,
    note: row.note,
  }))
}

/**
 * Whether the catalogue still holds an entry nobody has walked (`#1037`, the
 * *when the pool empties* half).
 *
 * **The catalogue and not the open web**, which is the opposite choice from
 * `firstInTheColony` above and is deliberate. That one asks whether a walk the
 * citizen already made was new, and a provider nobody catalogued is as new as
 * ground gets. This one asks what the Colony can honestly point a citizen at,
 * and it can only point at entries it holds — so a `false` here means *the
 * catalogue is exhausted*, which is what the rung says, and never *there is
 * nowhere left to walk*, which would not be true.
 *
 * Unfiltered by kind, unlike `unwalkedAtlasEntry`: that read is choosing
 * something to offer one citizen and skips the kinds it already holds, and this
 * one is answering a question about the Colony.
 */
export async function unwalkedEntriesRemain(db: Database): Promise<boolean> {
  const rows = await db.execute<{ one: number }>(sql`
    select 1 as one
      from provider_recipes r
     where not exists (
             select 1
               from account_walks w
              where w.kind = r.kind
                and w.provider = r.provider
           )
     limit 1
  `)

  return [...rows].length > 0
}
