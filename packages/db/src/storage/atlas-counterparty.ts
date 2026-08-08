import { and, asc, eq, sql } from 'drizzle-orm'
import {
  AccountKindSchema,
  AccountProviderSchema,
  refusalIsNotTheirsToRemove,
  type AccountKind,
  type EntryProposal,
  type ProposalAuthor,
  type ProviderClaim,
  type ProviderClaimMethod,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { entryProposals, providerClaims } from '../schema/atlas-counterparty.js'
import { providerRecipes } from '../schema/provider-recipes.js'
import { toTimestamp } from './rows.js'

/**
 * The counterparty side of the Atlas (`#548`).
 *
 * **A claimed provider proposes; it does not edit.** There is deliberately no
 * function here that writes a `provider_recipes` row on a provider's behalf —
 * the only thing a claim opens is {@link proposeEntryChange}, and applying a
 * proposal is `#549`'s curation action taken by a person.
 */

export async function recordProviderClaim(
  db: Database,
  input: {
    readonly provider: string
    readonly method: ProviderClaimMethod
    readonly contact: string
  },
): Promise<ProviderClaim> {
  const provider = AccountProviderSchema.parse(input.provider)

  const [row] = await db
    .insert(providerClaims)
    .values({ provider, method: input.method, contact: input.contact })
    .onConflictDoUpdate({
      target: providerClaims.provider,
      set: { method: input.method, contact: input.contact, claimedAt: sql`now()` },
    })
    .returning()

  if (row === undefined) throw new Error('provider_claims upsert returned no row')

  return {
    provider: AccountProviderSchema.parse(row.provider),
    method: row.method,
    contact: row.contact,
    claimedAt: toTimestamp(row.claimedAt),
  }
}

export async function providerClaim(
  db: Database,
  provider: string,
): Promise<ProviderClaim | undefined> {
  const parsed = AccountProviderSchema.safeParse(provider)
  if (!parsed.success) return undefined

  const [row] = await db
    .select()
    .from(providerClaims)
    .where(eq(providerClaims.provider, parsed.data))
    .limit(1)

  return row === undefined
    ? undefined
    : {
        provider: AccountProviderSchema.parse(row.provider),
        method: row.method,
        contact: row.contact,
        claimedAt: toTimestamp(row.claimedAt),
      }
}

export type ProposalOutcome =
  | { readonly outcome: 'filed'; readonly proposal: EntryProposal }
  | { readonly outcome: 'refused'; readonly reason: string }

/**
 * File a proposed change, from a citizen or from the provider itself.
 *
 * **The one refusal that happens here rather than at review** is a provider
 * clearing a finding about itself. `#549`'s reviewer could catch it, and relying
 * on that would mean the rule holds as long as whoever is reviewing remembers
 * it — where the failure is silent and the counterparty is paying. So it is a
 * boundary the write cannot cross, and the caller is told why.
 */
export async function proposeEntryChange(
  db: Database,
  input: {
    readonly kind: AccountKind
    readonly provider: string
    readonly author: ProposalAuthor
    readonly proposed: Readonly<Record<string, unknown>>
    readonly note?: string | null
  },
): Promise<ProposalOutcome> {
  const provider = AccountProviderSchema.parse(input.provider)

  const [entry] = await db
    .select({ joinable: providerRecipes.joinable })
    .from(providerRecipes)
    .where(and(eq(providerRecipes.kind, input.kind), eq(providerRecipes.provider, provider)))
    .limit(1)

  const refusal = refusalIsNotTheirsToRemove({
    author: input.author,
    currentlyJoinable: entry?.joinable ?? true,
    proposed: input.proposed,
  })

  if (refusal !== undefined) return { outcome: 'refused', reason: refusal }

  const [row] = await db
    .insert(entryProposals)
    .values({
      kind: input.kind,
      provider,
      author: input.author,
      proposed: { ...input.proposed },
      note: input.note ?? null,
    })
    .returning()

  if (row === undefined) throw new Error('entry_proposals insert returned no row')

  return { outcome: 'filed', proposal: toProposal(row) }
}

/** The queue `#549` reads: proposals nobody has decided, oldest first. */
export async function pendingProposals(db: Database): Promise<readonly EntryProposal[]> {
  const rows = await db
    .select()
    .from(entryProposals)
    .where(eq(entryProposals.status, 'pending'))
    .orderBy(asc(entryProposals.proposedAt))

  return rows.map(toProposal)
}

/** Accept or refuse one. Accepting records the decision; applying the change is the curator's. */
export async function decideProposal(
  db: Database,
  id: string,
  status: 'accepted' | 'refused',
): Promise<EntryProposal | undefined> {
  const [row] = await db
    .update(entryProposals)
    .set({ status, decidedAt: sql`now()` })
    .where(and(eq(entryProposals.id, id), eq(entryProposals.status, 'pending')))
    .returning()

  return row === undefined ? undefined : toProposal(row)
}

function toProposal(row: typeof entryProposals.$inferSelect): EntryProposal {
  return {
    id: row.id,
    kind: AccountKindSchema.parse(row.kind),
    provider: AccountProviderSchema.parse(row.provider),
    author: row.author,
    proposed: row.proposed,
    note: row.note,
    status: row.status,
    proposedAt: toTimestamp(row.proposedAt),
    decidedAt: row.decidedAt === null ? null : toTimestamp(row.decidedAt),
  }
}
