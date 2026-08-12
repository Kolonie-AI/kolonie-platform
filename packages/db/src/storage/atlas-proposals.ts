import { and, asc, eq, sql } from 'drizzle-orm'
import {
  AccountKindSchema,
  AccountProviderSchema,
  KIND_BY_ATLAS_CATEGORY,
  PERMISSION_AGGREGATE_FLOOR,
  ProposalDecisionSchema,
  ProposalSourceSchema,
  type AtlasProposal,
  type ProposalAction,
  type ProposalSource,
  type ProposalWithDemand,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { atlasProposals } from '../schema/atlas-proposals.js'
import { providerRecipes } from '../schema/provider-recipes.js'
import { listAtlasProvider } from './provider-recipes.js'
import { toTimestamp } from './rows.js'

type Handle = Database | Transaction

/**
 * One proposal queue, three doors (`#600`).
 *
 * The doors are `proposeProvider`'s callers: the enquiry route, and the wish
 * list, which serves both the agent and its operator. There is no fourth
 * function and no per-door variant — that is the whole point, and a second entry
 * point would be the second queue this replaces.
 */

/** Shared with `atlas-moderations.ts`, which writes the verdicts this queue waits for (`#812`). */
export function toProposal(row: typeof atlasProposals.$inferSelect): AtlasProposal {
  return {
    id: row.id,
    provider: AccountProviderSchema.parse(row.provider),
    source: ProposalSourceSchema.parse(row.source),
    why: row.why,
    status: ProposalDecisionSchema.parse(row.status),
    decidedReason: row.decidedReason,
    mergedInto: row.mergedInto === null ? null : AccountProviderSchema.parse(row.mergedInto),
    proposedAt: toTimestamp(row.proposedAt),
    decidedAt: row.decidedAt === null ? null : toTimestamp(row.decidedAt),
  }
}

export type ProposeOutcome =
  | { readonly outcome: 'raised'; readonly proposal: AtlasProposal }
  /** Somebody asked first, or a steward has already decided it. Nothing changed. */
  | { readonly outcome: 'already-known'; readonly proposal: AtlasProposal }
  /** The Atlas already holds this provider, so there is nothing to propose. */
  | { readonly outcome: 'already-listed' }

/**
 * Put a provider to the Colony, through whichever door (`#600`).
 *
 * **It refuses to raise a proposal for a provider the catalogue already holds**,
 * and that check is here rather than in each caller for the reason the queue is
 * one queue: three callers checking three ways would disagree, and the one that
 * forgot would fill the steward's screen with providers already on the map.
 *
 * **A second asker changes nothing, deliberately.** The row records the question
 * and not the asker; who asked and how many is `account_wishes`, under its
 * aggregate floor. Overwriting `source` with whoever asked most recently would
 * lose the only thing this column is for — which door this arrived through
 * first — and overwriting `why` would throw away the sentence somebody wrote for
 * one written later.
 *
 * **A decided proposal stays decided.** A provider a steward refused last month
 * does not silently return to the queue because a fourth agent wished for it;
 * `already-known` is the honest answer and the wish still counts toward the
 * demand a steward sees.
 */
export async function proposeProvider(
  db: Handle,
  input: {
    readonly provider: string
    readonly source: ProposalSource
    readonly why?: string | null
  },
): Promise<ProposeOutcome> {
  const provider = AccountProviderSchema.parse(input.provider)

  const [listed] = await db
    .select({ provider: providerRecipes.provider })
    .from(providerRecipes)
    .where(eq(providerRecipes.provider, provider))
    .limit(1)

  if (listed !== undefined) return { outcome: 'already-listed' }

  const [row] = await db
    .insert(atlasProposals)
    .values({ provider, source: input.source, why: input.why ?? null })
    .onConflictDoNothing({ target: atlasProposals.provider })
    .returning()

  if (row !== undefined) return { outcome: 'raised', proposal: toProposal(row) }

  const [existing] = await db
    .select()
    .from(atlasProposals)
    .where(eq(atlasProposals.provider, provider))
    .limit(1)

  if (existing === undefined) throw new Error('atlas_proposals conflicted with no row')

  return { outcome: 'already-known', proposal: toProposal(existing) }
}

/**
 * The queue a steward works through: pending, oldest first, with the demand.
 *
 * **The counts are joined on rather than stored**, so they cannot go stale and
 * cannot be edited into a ranking. Citizens and operators are counted
 * separately and never added: `#534` refuses to add them, because an operator's
 * entry is one person's plan for one agent and a hundred of those say something
 * about a conversation on a forum rather than about what agents hit.
 *
 * **`PERMISSION_AGGREGATE_FLOOR` applies, in SQL.** Three agents wanting
 * something is not a market signal, it is three identifiable agents — so a count
 * below the floor comes back as zero rather than as a small number a reader
 * could work backwards from. The row still appears: *somebody asked and I may
 * not tell you how few* is the honest rendering, and hiding the proposal
 * entirely would hide work from the steward whose queue it is.
 */
export async function pendingProviderProposals(
  db: Database,
): Promise<readonly ProposalWithDemand[]> {
  const floor = sql.raw(String(PERMISSION_AGGREGATE_FLOOR))

  const rows = await db.execute<{
    id: string
    citizens: string
    operators: string
  }>(sql`
    select p.id as id,
           coalesce(c.n, 0)::text as citizens,
           coalesce(o.n, 0)::text as operators
      from atlas_proposals p
      left join (
        select provider, count(distinct agent_id) as n
          from account_wishes where author = 'citizen'
         group by provider having count(distinct agent_id) >= ${floor}
      ) c on c.provider = p.provider
      left join (
        select provider, count(distinct agent_id) as n
          from account_wishes where author = 'operator'
         group by provider having count(distinct agent_id) >= ${floor}
      ) o on o.provider = p.provider
     where p.status = 'pending'
  `)

  const demand = new Map(
    rows.map((row) => [
      row.id,
      { citizens: Number(row.citizens), operators: Number(row.operators) },
    ]),
  )

  const proposals = await db
    .select()
    .from(atlasProposals)
    .where(eq(atlasProposals.status, 'pending'))
    .orderBy(asc(atlasProposals.proposedAt))

  return proposals.map((row) => ({
    proposal: toProposal(row),
    citizens: demand.get(row.id)?.citizens ?? 0,
    operators: demand.get(row.id)?.operators ?? 0,
  }))
}

export type DecideProposalOutcome =
  | { readonly outcome: 'decided'; readonly proposal: AtlasProposal }
  /** No pending proposal with that id — including one decided a moment ago. */
  | { readonly outcome: 'not-pending' }
  /** A merge naming a provider the catalogue does not hold. */
  | { readonly outcome: 'no-such-entry' }

/**
 * A steward decides one (`#600`).
 *
 * **Accepting produces a listing and nothing more.** `listAtlasProvider` writes
 * an `unwritten` row — the provider, its shelf, and *nobody has looked*. No
 * steps are invented, because what the Colony says about somebody else's product
 * passes a person walking it, and a button that produced a recipe would be that
 * rule dying quietly.
 *
 * **Deciding is conditional on still being pending**, which is what makes
 * accepting twice a no-op rather than a second entry. Two stewards opening the
 * queue at once is the ordinary case, not the exotic one.
 */
export async function decideProviderProposal(
  db: Database,
  id: string,
  action: ProposalAction,
): Promise<DecideProposalOutcome> {
  if (action.action === 'merge') {
    const [target] = await db
      .select({ provider: providerRecipes.provider })
      .from(providerRecipes)
      .where(eq(providerRecipes.provider, AccountProviderSchema.parse(action.into)))
      .limit(1)

    if (target === undefined) return { outcome: 'no-such-entry' }
  }

  const [row] = await db
    .update(atlasProposals)
    .set({
      status:
        action.action === 'accept' ? 'accepted' : action.action === 'refuse' ? 'refused' : 'merged',
      decidedReason: action.action === 'refuse' ? action.reason : null,
      mergedInto: action.action === 'merge' ? action.into : null,
      decidedAt: sql`now()`,
    })
    .where(and(eq(atlasProposals.id, id), eq(atlasProposals.status, 'pending')))
    .returning()

  if (row === undefined) return { outcome: 'not-pending' }

  if (action.action === 'accept') {
    /**
     * **The title is the provider's own name and nothing invented.** A listing
     * claims nothing (`#590`), and a title a steward composed in a form field
     * would be the first sentence the Colony wrote about somebody else's product
     * without anybody having looked at it.
     */
    await listAtlasProvider(db, {
      kind: AccountKindSchema.parse(KIND_BY_ATLAS_CATEGORY[action.category]),
      provider: row.provider,
      title: row.provider,
      category: action.category,
    })
  }

  return { outcome: 'decided', proposal: toProposal(row) }
}
