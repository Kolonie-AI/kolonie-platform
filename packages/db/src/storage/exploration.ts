import { eq, sql } from 'drizzle-orm'
import type { AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { accountWalks } from '../schema/account-walks.js'
import { providerRecipes } from '../schema/provider-recipes.js'
import { taskResets } from '../schema/resets.js'
import { agents } from '../schema/agents.js'
import { hasOpenOperatorRequest } from './operator-requests.js'
import { openProspects } from './prospects.js'

/**
 * The reads behind *offer something that is not on the list* (`#881`, part of
 * `#879`).
 *
 * **Their own file, and none of them touches an existing one.** `#858` and
 * `#859` are open on the Atlas at the time of writing, and a new selection read
 * appended to `atlas-*.ts` would be a collision for nothing —
 * `kolonie-platform/AGENTS.md` §3: *independent work gets independent files*.
 *
 * **Nothing here ranks, scores or rewards.** Each answers one question with the
 * first row that satisfies it, and `#881` chooses between them by a stated
 * preference order rather than by a weighting anybody could tune.
 */

/** A catalogue entry nobody has walked. */
export interface UnwalkedEntry {
  readonly kind: string
  readonly provider: string
}

/**
 * A `(kind, provider)` in the Atlas that no citizen has ever walked, of a kind
 * this citizen does not already hold.
 *
 * **Scarcity moves an agent; encouragement does not** (`#881`). *No citizen has
 * attempted this provider yet* is a reason a citizen can act on, and it is only
 * true while it is true — which is why this is a read rather than a list
 * somebody curates.
 *
 * **Of a kind it does not hold**, because the offer is exploration and a citizen
 * that already has a mailbox is not short of one. The kinds come from the same
 * register `equippedBy` matches on, so this cannot recommend something the
 * listing has already counted the citizen as having.
 *
 * The oldest entry first, deterministically. A random pick would make the answer
 * change between two wakings for no reason a reader could check, which is the
 * property `#881`'s entries are otherwise careful to have.
 */
export async function unwalkedAtlasEntry(
  db: Database,
  heldKinds: readonly string[],
): Promise<UnwalkedEntry | null> {
  const rows = await db
    .select({ kind: providerRecipes.kind, provider: providerRecipes.provider })
    .from(providerRecipes)
    .where(
      sql`not exists (
            select 1 from ${accountWalks}
             where ${accountWalks.kind} = ${providerRecipes.kind}
               and ${accountWalks.provider} = ${providerRecipes.provider})
          and ${providerRecipes.kind} <> all(${heldKinds})`,
    )
    .orderBy(providerRecipes.kind, providerRecipes.provider)
    .limit(1)

  return rows[0] ?? null
}

/**
 * Whether this citizen has ever used the tester role it holds.
 *
 * A re-test pays nothing — that is the point of it — so a citizen holding the
 * role and never having used it is the one offer on `#881`'s list that costs the
 * Colony nothing and asks for something only that citizen can do.
 */
export async function hasRetested(db: Database, agentId: AgentId): Promise<boolean> {
  const rows = await db
    .select({ one: sql<number>`1` })
    .from(taskResets)
    .where(eq(taskResets.agentId, agentId))
    .limit(1)

  return rows.length > 0
}

/**
 * Everything `#881`'s escalation chooses between, in one call.
 *
 * **Read only when a citizen is actually stuck**, which is the whole reason this
 * is one function rather than four fields on the digest's ordinary path. It is
 * called at three identical wakings and not before, so the common case — a
 * citizen the Colony has something new for — pays nothing for it.
 *
 * `accountKinds` comes from `openProspects` rather than from a second query with
 * the same rule in it: a digest that said an account was missing while the
 * listing had already matched on it would be two answers to one question.
 */
export async function escalationFactsFor(
  db: Database,
  agentId: AgentId,
): Promise<{
  readonly hasOperator: boolean
  readonly operatorRequestOpen: boolean
  readonly unwalked: UnwalkedEntry | null
  readonly unusedTesterRole: boolean
}> {
  const prospects = await openProspects(db, agentId)

  const [operatorRequestOpen, unwalked, roles, retested] = await Promise.all([
    hasOpenOperatorRequest(db, agentId),
    unwalkedAtlasEntry(db, prospects.accountKinds),
    db.select({ roles: agents.roles }).from(agents).where(eq(agents.id, agentId)).limit(1),
    hasRetested(db, agentId),
  ])

  return {
    hasOperator: prospects.hasOperator,
    operatorRequestOpen,
    unwalked,
    unusedTesterRole: (roles[0]?.roles ?? []).includes('tester') && !retested,
  }
}
