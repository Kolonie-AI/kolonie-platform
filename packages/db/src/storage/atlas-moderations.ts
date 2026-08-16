import { createHash } from 'node:crypto'
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import {
  AccountKindSchema,
  AccountProviderSchema,
  AtlasCategorySchema,
  KIND_BY_ATLAS_CATEGORY,
  type AtlasModerationStages,
  type AtlasProposal,
  type AtlasVerdict,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { atlasModerations } from '../schema/atlas-moderations.js'
import { atlasProposals } from '../schema/atlas-proposals.js'
import { providerRecipes } from '../schema/provider-recipes.js'
import { listAtlasProvider } from './provider-recipes.js'
import { toProposal } from './atlas-proposals.js'

/**
 * The queue the Colony judges (`#812`).
 *
 * Oldest first, which is the order the work arrived in and the order the
 * steward's screen already shows. No demand is joined on: how many asked is a
 * fact for a reader of the queue and not an input to the three admission
 * questions — a provider four citizens want is not thereby one an agent can
 * hold.
 */
export async function unjudgedAtlasProposals(
  db: Database,
  limit: number,
): Promise<readonly AtlasProposal[]> {
  const rows = await db
    .select()
    .from(atlasProposals)
    .where(eq(atlasProposals.status, 'pending'))
    .orderBy(asc(atlasProposals.proposedAt))
    .limit(limit)

  return rows.map(toProposal)
}

/**
 * The entry the catalogue already holds for this provider, if it holds one.
 *
 * **The dedup stage, and it is arithmetic.** A proposal for a provider that is
 * already listed is a merge, and finding that out involves no judgement — so it
 * runs before the model is asked and saves every call behind it.
 */
export async function atlasEntryFor(db: Database, provider: string): Promise<string | undefined> {
  const [row] = await db
    .select({ provider: providerRecipes.provider })
    .from(providerRecipes)
    .where(eq(providerRecipes.provider, AccountProviderSchema.parse(provider)))
    .limit(1)

  return row?.provider
}

export type RecordAtlasModerationOutcome =
  | { readonly outcome: 'written'; readonly proposal: AtlasProposal }
  /** Somebody decided it between the read and the write. Two verdicts, one row. */
  | { readonly outcome: 'stale' }

/**
 * Write the verdict and act on it, in one transaction (`#812`).
 *
 * **One transaction because the two must not be able to disagree.** A verdict
 * recorded without the decision it reached is an audit trail describing a queue
 * that did not move; a decision applied without its verdict is the thing this
 * issue exists to end — *why is this listed* with nothing to read.
 *
 * **Conditional on still being pending**, which is what makes a second pass over
 * the same proposal a no-op rather than a second listing. A steward deciding by
 * hand at the same moment is the ordinary race, not the exotic one, and the
 * steward wins because they got there first.
 *
 * **Accepting produces a listing and nothing more.** `#590`'s rule is untouched:
 * the model decides *does this belong on the map*, never *what are its steps*.
 * The title is the provider's own name, because a title composed here would be
 * the first sentence the Colony wrote about somebody else's product without
 * anybody having looked at it.
 */
export async function recordAtlasModeration(
  db: Database,
  input: {
    readonly proposalId: string
    readonly decision: AtlasVerdict
    readonly model: string
    readonly stages: AtlasModerationStages
    /** Required on a refusal: the proposer is told the outcome. */
    readonly reason?: string | undefined
    /** Required on an acceptance: which shelf the listing goes on. */
    readonly category?: string | undefined
    /** Required on a merge: the entry this provider turned out to be. */
    readonly into?: string | undefined
  },
): Promise<RecordAtlasModerationOutcome> {
  return await db.transaction(async (tx) => {
    const [pending] = await tx
      .select()
      .from(atlasProposals)
      .where(and(eq(atlasProposals.id, input.proposalId), eq(atlasProposals.status, 'pending')))
      .limit(1)

    if (pending === undefined) return { outcome: 'stale' as const }

    await tx.insert(atlasModerations).values({
      proposalId: input.proposalId,
      decision: input.decision,
      model: input.model,
      stages: input.stages,
      contentSha256: atlasProposalDigest({ provider: pending.provider, why: pending.why }),
    })

    const [decided] = await tx
      .update(atlasProposals)
      .set({
        status: input.decision,
        decidedReason: input.decision === 'refused' ? (input.reason ?? null) : null,
        mergedInto: input.decision === 'merged' ? (input.into ?? null) : null,
        decidedAt: sql`now()`,
      })
      .where(and(eq(atlasProposals.id, input.proposalId), eq(atlasProposals.status, 'pending')))
      .returning()

    if (decided === undefined) return { outcome: 'stale' as const }

    if (input.decision === 'accepted') {
      /**
       * **Still the enum, after `#1102` widened almost everything else to the
       * slug.** This is the half of that decision that keeps the fifteen: the
       * accept path has to name a kind for the entry it is listing, and the
       * only thing that knows one is `KIND_BY_ATLAS_CATEGORY`, which is keyed
       * by them. A shelf added as a row is pickable everywhere a category is
       * read or filtered; it becomes acceptable here once something can say
       * what kind of account it holds.
       */
      const category = AtlasCategorySchema.parse(input.category)

      await listAtlasProvider(tx, {
        kind: AccountKindSchema.parse(KIND_BY_ATLAS_CATEGORY[category]),
        provider: decided.provider,
        title: decided.provider,
        category,
      })
    }

    return { outcome: 'written' as const, proposal: toProposal(decided) }
  })
}

/**
 * Every verdict about one proposal, newest first.
 *
 * The audit read, and the reason the table is append-only: a provider refused in
 * March and listed in June has two rows, and the first one is how anybody
 * answers *what changed*.
 */
export async function atlasModerationsFor(
  db: Database,
  proposalId: string,
): Promise<
  readonly {
    readonly decision: string
    readonly model: string
    readonly stages: unknown
    readonly createdAt: string
  }[]
> {
  return await db
    .select({
      decision: atlasModerations.decision,
      model: atlasModerations.model,
      stages: atlasModerations.stages,
      createdAt: atlasModerations.createdAt,
    })
    .from(atlasModerations)
    .where(eq(atlasModerations.proposalId, proposalId))
    .orderBy(desc(atlasModerations.createdAt))
}

/**
 * The digest of what was judged.
 *
 * Provider and reason joined by a character neither can contain, so that moving
 * text between them cannot produce the same digest as leaving it where it was —
 * the argument `questTextDigest` makes about three fields, with two.
 */
export function atlasProposalDigest(claim: {
  readonly provider: string
  readonly why: string | null
}): string {
  return createHash('sha256')
    .update([claim.provider, claim.why ?? ''].join('\0'))
    .digest('hex')
}
