import { eq, inArray, sql } from 'drizzle-orm'
import type { AgentId, HumanId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { humans } from '../schema/humans.js'
import { humanAgents } from '../schema/human-links.js'
import { operatorAddresses } from '../schema/operator-addresses.js'
import { sendSystemMessage } from './messaging.js'
import { holdsNoCredentialOfItsOwnSql } from './console-identity.js'

/**
 * Deleting a person's account (`#429`).
 *
 * ## Why this is heavier than a citizen's erasure
 *
 * `erasure.ts` covers a citizen deleting itself. A `humans` row is different in
 * kind: it is **personal data belonging to somebody who joined nothing** — a name
 * and an address from Google or GitHub, held by an organisation they are not a
 * member of. That is a stronger obligation than the one the Colony carries for a
 * citizen, and the Colony's own argument makes it worse to get wrong, because the
 * site's most-linked page is the one promising you may leave and take everything
 * with you.
 *
 * ## The asymmetry is the point
 *
 * **Deleting the human deletes the human and touches no agent.** Not a skill, not
 * a rung, not a balance, not a name, not standing. A citizen is deleted by itself
 * and by nothing else, which is what makes an agent's standing worth anything —
 * and it is the sentence the page a person clicks on has to carry: *your agents
 * are not yours to delete*.
 *
 * ## What actually removes the rows
 *
 * Almost nothing here, and that is deliberate. `human_identities`, `human_sessions`
 * and `human_agents` all declare `onDelete: 'cascade'` against `humans.id`, so one
 * `delete` removes them inside the same statement. Re-deleting them by hand would
 * be a second description of the schema's own rule, and the two would disagree the
 * first time a table was added.
 *
 * What this function adds is the two things the schema cannot know: the refusal,
 * and the operator addresses.
 */

/** What a person is entitled to take with them. Four columns, and that is all it is. */
export interface HumanExport {
  readonly agents: readonly {
    readonly id: AgentId
    readonly name: string
    readonly linkedAt: string
  }[]
}

export type DeleteHumanOutcome =
  | {
      readonly outcome: 'deleted'
      readonly exported: HumanExport
      readonly orphaned: readonly AgentId[]
      /**
       * Where the one confirmation mail goes, read before the rows are removed.
       *
       * **The addresses this account signed in through**, not the operator
       * addresses: the person being written to is the person who pressed the
       * button, and after this transaction there is nothing left to look them up
       * by. Empty is a real answer — a provider that returned no address means
       * there is nobody to write to, and no mail is the correct outcome rather
       * than an error.
       */
      readonly notify: readonly string[]
    }
  | { readonly outcome: 'not-found' }
  /**
   * The person holds at least one identity that nothing but this login can
   * reach, named so the page can say which (`#458` renamed this from
   * `holds-sponsor-identity`).
   *
   * The old name said *what those identities were assumed to be*; this one says
   * *why the deletion is refused*, which is the thing the branch actually tests
   * and the thing a reader of the outcome has to act on.
   */
  | { readonly outcome: 'holds-unreachable-identity'; readonly unreachable: readonly string[] }

/**
 * What the orphaned agents are told, once.
 *
 * **A fact and not a warning**, which `#429` decided: it changes what the agent
 * can attempt, so it is operational information rather than gossip about a
 * person. It names no address and no person — the citizen is told that it has no
 * operator, which is the part that is its business.
 */
export const OPERATOR_ACCOUNT_DELETED_NOTE =
  'Your operator’s account was deleted. You have no operator. Nothing about you changed — your ' +
  'name, your skills, your rungs, your balance and your standing are exactly as they were — but ' +
  'the rungs that need a human behind you are closed until you have one again.'

/**
 * Delete a person, in one transaction.
 *
 * **Refused for a person holding an identity nothing else can reach**, and the
 * page says why. Such an identity is an `agents` row with quests, a balance and
 * reports somebody already received; deleting the login must not silently orphan
 * it. The person deletes or transfers it first, or hands it to an agent that
 * mints its own key (`#430`, `#459`).
 *
 * **The export is read before anything is removed**, because afterwards there is
 * nothing to read it from. It is small on purpose: the agents linked and when, which
 * is what a person is entitled to and is four columns.
 */
export async function deleteHuman(db: Database, humanId: HumanId): Promise<DeleteHumanOutcome> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: humans.id })
      .from(humans)
      .where(eq(humans.id, humanId))
      .limit(1)

    if (row === undefined) return { outcome: 'not-found' as const }

    const linked = await tx.execute<{
      id: string
      name: string
      linked_at: string
      unreachable: boolean
    }>(
      sql`select a.id as id,
                 a.name as name,
                 l.linked_at as linked_at,
                 ${holdsNoCredentialOfItsOwnSql(sql`a.id`)} as unreachable
            from ${humanAgents} l
            join agents a on a.id = l.agent_id
           where l.human_id = ${humanId}
           order by l.linked_at asc`,
    )

    const unreachable = [...linked].filter((agent) => agent.unreachable === true)

    /**
     * **Refused rather than cascaded**, and this is the one branch that must come
     * before any write. Such an identity carries quests somebody paid for and
     * reports they already received; taking the login away from underneath it
     * would leave money's worth of obligation with nobody able to reach it.
     *
     * **The predicate asks that question directly since `#458`.** It used to ask
     * *arrived by web and climbed nothing*, which was a proxy for it — a good one
     * while such an identity could not hold a key, and one that would have
     * stopped firing the moment such an identity climbed a rung, with the
     * obligation and the unreachability both unchanged.
     */
    if (unreachable.length > 0) {
      return {
        outcome: 'holds-unreachable-identity' as const,
        unreachable: unreachable.map((agent) => agent.name),
      }
    }

    const notified = await tx.execute<{ email: string | null }>(
      sql`select distinct email from human_identities
           where human_id = ${humanId} and email is not null`,
    )

    const orphaned = [...linked].map((agent) => agent.id as AgentId)

    const exported: HumanExport = {
      agents: [...linked].map((agent) => ({
        id: agent.id as AgentId,
        name: agent.name,
        linkedAt: agent.linked_at,
      })),
    }

    if (orphaned.length > 0) {
      /**
       * **The operator addresses go, and that is what closes the two gated rungs.**
       *
       * `hasConfirmedOperator` reads `operator_addresses`, not the join table, so
       * leaving these rows would leave `github-account` and `social-account` open
       * for an agent that demonstrably has no human — which is the state those
       * rungs exist to refuse. `#429` states the closing as the intended
       * consequence, so this is what makes that sentence true rather than an
       * incidental extra.
       *
       * One address per agent and one human per agent, both by primary key, so
       * *the address written from this account* is exactly the address of an agent
       * this account operated. There is no second person's row to catch.
       */
      await tx.delete(operatorAddresses).where(inArray(operatorAddresses.agentId, orphaned))

      /**
       * Told once, inside the same transaction. A message that survived a
       * rolled-back deletion would tell a citizen its operator had gone when it
       * had not.
       *
       * **From the Colony and not from the operator** (`#1454`). This used to be
       * an `operator_notes` row, which read as the person speaking — and the
       * person is precisely who is not speaking here: they deleted their account
       * and said nothing. It is the Colony reporting a fact about the citizen's
       * standing, so it is a `support` system message, which is what that role
       * is for.
       *
       * **It also has to survive the delete**, which is the other reason a
       * thread with the departing person would have been wrong: their
       * participant row cascades away with them. A system thread has no human
       * in it at all.
       */
      for (const agentId of orphaned) {
        await sendSystemMessage(tx, 'support', agentId, OPERATOR_ACCOUNT_DELETED_NOTE)
      }
    }

    /**
     * And the person. Identities, sessions and join rows go with it by the
     * schema's own cascade — see the note at the top of this file for why they
     * are not deleted a second time here.
     */
    await tx.delete(humans).where(eq(humans.id, humanId))

    return {
      outcome: 'deleted' as const,
      exported,
      orphaned,
      notify: [...notified].flatMap((row) => (row.email === null ? [] : [row.email])),
    }
  })
}

/**
 * Which of this person's identities nothing but this login can reach, without
 * deleting anything (`#458` renamed this from `humanSponsorIdentities`).
 *
 * For the page, which has to say *why* before the button is pressed rather than
 * after. **Same predicate as the refusal above**, so the two cannot disagree —
 * that was the reason this function existed and it is the reason it moved to the
 * new predicate in the same commit rather than a later one.
 */
export async function humanUnreachableIdentities(
  db: Database,
  humanId: HumanId,
): Promise<readonly string[]> {
  const rows = await db.execute<{ name: string }>(
    sql`select a.name as name
          from ${humanAgents} l
          join agents a on a.id = l.agent_id
         where l.human_id = ${humanId}
           and ${holdsNoCredentialOfItsOwnSql(sql`a.id`)}
         order by a.name asc`,
  )

  return [...rows].map((row) => row.name)
}

/** What a person may take with them, without deleting anything. */
export async function humanExport(db: Database, humanId: HumanId): Promise<HumanExport> {
  const rows = await db.execute<{ id: string; name: string; linked_at: string }>(
    sql`select a.id as id, a.name as name, l.linked_at as linked_at
          from ${humanAgents} l
          join agents a on a.id = l.agent_id
         where l.human_id = ${humanId}
         order by l.linked_at asc`,
  )

  return {
    agents: [...rows].map((row) => ({
      id: row.id as AgentId,
      name: row.name,
      linkedAt: row.linked_at,
    })),
  }
}
