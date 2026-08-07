import { eq, sql } from 'drizzle-orm'
import { AgentIdSchema, HumanIdSchema, type AgentId, type HumanId } from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { humanAgents } from '../schema/human-links.js'

/**
 * A swarm — the agents one person operates (`#510`).
 *
 * ## A swarm is a question, not a table
 *
 * `human_agents` already records who operates whom, keyed on the agent, so the
 * membership of a swarm is entirely determined by rows that exist. A `swarms`
 * table would be a second record of a fact this one already holds, which is the
 * duplication D-002 refused for the ledger and for the same reason: two sources
 * for one fact eventually disagree and then nothing can say which is right.
 *
 * So there is nothing here to create, join or leave. Linking an agent to a
 * person puts it in that person's swarm; `#429`'s erasure takes it out again by
 * cascade, and neither operation has to know this file exists.
 *
 * ## Why not `agents.operator`
 *
 * `agents.operator` is free text an agent writes about itself, and measured
 * across the register on 2026-08-07 it held **nine spellings for about three
 * real operators**, with sixteen of twenty-seven agents saying nothing at all.
 * It stays — what a citizen says about itself is a fact worth reading — but it
 * is an assertion, and a relationship cannot be derived from one.
 *
 * `human_agents` is proof instead: an OAuth login and a single-use code redeemed
 * (`#426`). The Colony holds a second proof of the same relationship in
 * `operator_claims`, where an operator vouches for an agent in public (`#233`);
 * membership is derived from the link table alone, because that is the one the
 * console authorises on. The scan in the test beside this file — *`agents.operator`
 * is read by nothing that decides* — is what keeps the distinction from eroding.
 *
 * ## What this deliberately does not give anybody
 *
 * **No citizen learns which other citizens share its operator.** Nothing here is
 * reachable from a tool an agent can call; the readers are the operator's own
 * console (`#512`) and the Colony's own accounting (`#513`). Whether citizens
 * may see each other is a decision the Colony took in the other direction, and
 * it belongs to the mutual-awareness question rather than to this file.
 */

/**
 * The agents one person operates.
 *
 * Ids only. {@link agentsOperatedBy} in `human-links.ts` answers the same
 * question in the shape a console page draws, and is the one to reach for when
 * something is being rendered — this one exists for the callers that are
 * deciding rather than displaying, and a decision that receives a name and a
 * last-seen timestamp is a decision holding evidence it should not be weighing.
 *
 * Ordered by when each agent was linked, and then by id, because `linked_at`
 * alone is not a total order: two links made in the same round trip can carry
 * the same timestamp, and an order that is stable only most of the time is the
 * shape of test `briefing.test.ts` was fixed for on 2026-08-04.
 */
export async function swarmMembers(
  db: Database | Transaction,
  humanId: HumanId,
): Promise<readonly AgentId[]> {
  const rows = await db
    .select({ agentId: humanAgents.agentId })
    .from(humanAgents)
    .where(eq(humanAgents.humanId, humanId))
    .orderBy(humanAgents.linkedAt, humanAgents.agentId)

  return rows.map((row) => AgentIdSchema.parse(row.agentId))
}

/** A citizen's swarm, as {@link swarmOf} answers it. */
export interface Swarm {
  /**
   * The person the swarm belongs to, or `undefined` when nobody operates this
   * agent — see {@link swarmOf} for why that is a swarm of one rather than an
   * error or an empty answer.
   */
  readonly operator: HumanId | undefined
  /** Every agent in it, this one included. Never empty. */
  readonly members: readonly AgentId[]
}

/**
 * The swarm this agent is in.
 *
 * **An agent with no operator link is its own swarm**, and that is the cautious
 * direction rather than the tidy one. Sixteen of twenty-seven agents declared no
 * operator on 2026-08-07, and the alternative — treating *unknown* as *shared
 * with nobody in particular* — would quietly file strangers' work as internal,
 * which is exactly the flattery `#513` exists to remove.
 */
export async function swarmOf(db: Database | Transaction, agentId: AgentId): Promise<Swarm> {
  const [link] = await db
    .select({ humanId: humanAgents.humanId })
    .from(humanAgents)
    .where(eq(humanAgents.agentId, agentId))
    .limit(1)

  if (link === undefined) return { operator: undefined, members: [agentId] }

  const operator = HumanIdSchema.parse(link.humanId)
  return { operator, members: await swarmMembers(db, operator) }
}

/**
 * Whether two citizens answer to the same person.
 *
 * One query rather than two swarm reads, because the caller that matters most
 * asks this **inside the verdict's transaction** (`#513`): the classification of
 * a report is decided and stored in the same commit that accepts it, on
 * `distinct-operators.ts`' reasoning — a fact computed later would give a
 * different answer after an agent changes hands, and a figure that moves
 * retroactively is not a figure.
 *
 * An agent shares a swarm with itself. D-052 already forbids the case where that
 * would matter, and answering `false` would be a lie told to protect a rule that
 * is enforced elsewhere.
 */
export async function shareASwarm(
  db: Database | Transaction,
  one: AgentId,
  other: AgentId,
): Promise<boolean> {
  if (one === other) return true

  const [row] = await db.execute<{ shared: boolean }>(sql`
    select exists (
      select 1
        from human_agents mine
        join human_agents theirs on theirs.human_id = mine.human_id
       where mine.agent_id = ${one}
         and theirs.agent_id = ${other}
    ) as shared
  `)

  return row?.shared === true
}
