import { and, eq, inArray, sql } from 'drizzle-orm'
import { AccountProviderSchema } from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { accounts as agentAccounts } from '../schema/accounts.js'
import { accountWalks } from '../schema/account-walks.js'
import { atlasRenames } from '../schema/atlas-renames.js'
import { providerBriefings } from '../schema/provider-briefings.js'
import { providerRecipes } from '../schema/provider-recipes.js'
import { providerReports } from '../schema/provider-reports.js'

/** What a rename moved, per table (`#845`). */
export interface RenameOutcome {
  /** Recipes. Named `moved` since `#546`, and kept so callers do not have to change. */
  readonly moved: number
  readonly walks: number
  readonly accounts: number
  readonly reports: number
  /** Briefings emptied and queued for recomposition, rather than moved. */
  readonly briefings: number
}

/**
 * Renaming a provider, and remembering where it used to be (`#546`).
 *
 * The rows move and the old name becomes a redirect. Both in one transaction:
 * a rename that moved the rows and lost the redirect is the dead link this
 * table exists to prevent, and it would be unrecoverable — nothing afterwards
 * knows what the old name was.
 *
 * ## Every provider-keyed table, not only the recipes (`#845`)
 *
 * This moved `provider_recipes` and left every other row filed under the old
 * string. Because each read and each write resolves forward through
 * {@link canonicalProvider}, those rows were not merely mislabelled — **nothing
 * reached them again.** Walks filed under `twitter` became unreachable and the
 * Atlas would answer *nobody has walked this* about a provider it had walked;
 * `agent_accounts` and `provider_reports` split into two rows, so a provider
 * audience paying to see its own numbers under `#548` would get the part written
 * since the rename with nothing in the answer saying so.
 *
 * The redirect cannot cover it. `atlasRenames` maps old → new, which is what
 * makes a read of `twitter` find the recipe now filed under `x`; it cannot make
 * a read of `x` find rows still filed under `twitter`, and making
 * `canonicalProvider` fan out over every historical name would push the cost
 * onto every read to fix a write that happens rarely.
 *
 * **In the transaction that already exists**, because it already carries the
 * argument: a rename that moved half is worse than one that moved none, and
 * nothing afterwards knows which half.
 *
 * Not triggered by anything in production — no rename has been run there — so
 * this is a correctness fix ahead of the first one rather than a repair.
 */
export async function renameProvider(
  db: Database,
  from: string,
  to: string,
): Promise<RenameOutcome> {
  const fromProvider = AccountProviderSchema.parse(from)
  const toProvider = AccountProviderSchema.parse(to)

  if (fromProvider === toProvider) {
    return { moved: 0, walks: 0, accounts: 0, reports: 0, briefings: 0 }
  }

  return db.transaction(async (tx) => {
    const moved = await tx
      .update(providerRecipes)
      .set({ provider: toProvider, updatedAt: sql`now()` })
      .where(eq(providerRecipes.provider, fromProvider))
      .returning({ kind: providerRecipes.kind })

    /**
     * **A citizen's own rows, and the rename does not change what any citizen
     * said** — only the name it is filed under. Both are read through
     * `canonicalProvider` or aggregated on the raw column, and either way a row
     * left behind is a row that has left the total.
     */
    const walks = await tx
      .update(accountWalks)
      .set({ provider: toProvider })
      .where(eq(accountWalks.provider, fromProvider))
      .returning({ kind: accountWalks.kind })

    const accounts = await tx
      .update(agentAccounts)
      .set({ provider: toProvider })
      .where(eq(agentAccounts.provider, fromProvider))
      .returning({ id: agentAccounts.id })

    const reports = await tx
      .update(providerReports)
      .set({ provider: toProvider })
      .where(eq(providerReports.provider, fromProvider))
      .returning({ kind: providerReports.kind })

    /**
     * **A briefing is recomposed, not moved** (`#845`).
     *
     * `provider_briefings` is keyed by `(kind, provider)`, so a briefing may
     * already exist at the target and the collision has to be decided rather
     * than left to the primary key. Picking one of two by age would publish a
     * write-up of half the evidence under a name that now covers all of it — and
     * a briefing is *derived*, so there is a right answer: compose it again from
     * the merged walks.
     *
     * Which is what this does, using the machinery that already exists for it.
     * Every briefing on either side of an affected kind is dropped and one
     * empty, dirty row is left at the target; `staleProviderBriefings` picks it
     * up and the next synthesis writes it from the walks that are now all in one
     * place. The schema documents that exact state — *"an empty array here means
     * the row was created by the dirty-marking and no synthesis has run yet"* —
     * so nothing reads it as a briefing that says nothing.
     *
     * **The kinds come from the walks and not from the briefing rows**, because
     * the target's own briefing is stale too once walks have arrived under it,
     * even where the old name had no briefing of that kind to collide with. And
     * from the walks and not from the recipes: a briefing is composed from what
     * citizens walked, so a recipe moving on its own changes nothing about what
     * the write-up would say.
     */
    const affectedKinds = [...new Set(walks.map((walk) => walk.kind))]

    let briefings = 0
    if (affectedKinds.length > 0) {
      const dropped = await tx
        .delete(providerBriefings)
        .where(
          and(
            inArray(providerBriefings.kind, affectedKinds),
            inArray(providerBriefings.provider, [fromProvider, toProvider]),
          ),
        )
        .returning({ kind: providerBriefings.kind })
      briefings = dropped.length

      await tx
        .insert(providerBriefings)
        .values(affectedKinds.map((kind) => ({ kind, provider: toProvider })))
        .onConflictDoUpdate({
          target: [providerBriefings.kind, providerBriefings.provider],
          set: { dirty: true },
        })
    }

    /**
     * **Every earlier hop is repointed, so a chain is never followed at read
     * time.** `twitter` → `x` → `xcom` must leave `twitter` pointing at `xcom`
     * and not at `x`: a redirect that redirects costs a crawler a second round
     * trip per page, and the third rename would cost a third.
     */
    await tx
      .update(atlasRenames)
      .set({ toProvider })
      .where(eq(atlasRenames.toProvider, fromProvider))

    await tx
      .insert(atlasRenames)
      .values({ fromProvider, toProvider, reason: 'renamed' })
      .onConflictDoUpdate({
        target: atlasRenames.fromProvider,
        set: { toProvider, reason: 'renamed', renamedAt: sql`now()` },
      })

    return {
      moved: moved.length,
      walks: walks.length,
      accounts: accounts.length,
      reports: reports.length,
      briefings,
    }
  })
}

/** What {@link aliasProvider} did, or why it would not. */
export type AliasOutcome =
  | { readonly outcome: 'recorded'; readonly alias: string; readonly provider: string }
  /** The alias already names an entry of its own, so resolving it would hide one. */
  | { readonly outcome: 'shadows-an-entry'; readonly kinds: readonly string[] }
  /** A name cannot mean itself, and after flattening this one would. */
  | { readonly outcome: 'points-at-itself' }

/**
 * Recording that two live names are one provider (`#772`).
 *
 * **Not a rename, and the difference is a fact about the world rather than a
 * preference.** `clawhub.com` redirects to `clawhub.ai`: both resolve, both are
 * things an agent will type, and neither is dead. A rename would claim the first
 * one stopped existing, which is the kind of wrong a catalogue is read to avoid.
 *
 * **It refuses to shadow an entry.** If the alias already carries recipes of its
 * own, recording it would make those rows unreachable through every read that
 * resolves — the entry would still be in the table and nothing would ever return
 * it. That is the one failure mode of alias resolution that is worse than the
 * fragmentation it fixes, so it is refused rather than merged: merging two walked
 * entries is a curation decision with a person's judgement in it, and
 * `renameProvider` is the call that takes it deliberately.
 *
 * **The target is flattened first**, for the reason `renameProvider` repoints
 * earlier hops: aliasing `a` to `b` where `b` is itself an alias of `c` records
 * `a → c`, so no read ever follows two hops.
 */
export async function aliasProvider(
  db: Database,
  alias: string,
  provider: string,
): Promise<AliasOutcome> {
  const fromProvider = AccountProviderSchema.parse(alias)
  const asked = AccountProviderSchema.parse(provider)

  return db.transaction(async (tx) => {
    const [target] = await tx
      .select({ toProvider: atlasRenames.toProvider })
      .from(atlasRenames)
      .where(eq(atlasRenames.fromProvider, asked))
      .limit(1)

    const toProvider = target?.toProvider ?? asked

    if (fromProvider === toProvider) return { outcome: 'points-at-itself' } as const

    const shadowed = await tx
      .select({ kind: providerRecipes.kind })
      .from(providerRecipes)
      .where(eq(providerRecipes.provider, fromProvider))

    if (shadowed.length > 0) {
      return { outcome: 'shadows-an-entry', kinds: shadowed.map((one) => one.kind) } as const
    }

    /** Anything that pointed at the alias now points past it — one hop, always. */
    await tx
      .update(atlasRenames)
      .set({ toProvider })
      .where(eq(atlasRenames.toProvider, fromProvider))

    await tx
      .insert(atlasRenames)
      .values({ fromProvider, toProvider, reason: 'alias' })
      .onConflictDoUpdate({
        target: atlasRenames.fromProvider,
        set: { toProvider, reason: 'alias', renamedAt: sql`now()` },
      })

    return { outcome: 'recorded', alias: fromProvider, provider: toProvider } as const
  })
}

/** Where a provider name points now, or nothing if it means itself. */
export async function providerRenamedTo(
  db: Database | Transaction,
  from: string,
): Promise<string | undefined> {
  const parsed = AccountProviderSchema.safeParse(from)
  if (!parsed.success) return undefined

  const [row] = await db
    .select({ toProvider: atlasRenames.toProvider })
    .from(atlasRenames)
    .where(eq(atlasRenames.fromProvider, parsed.data))
    .limit(1)

  return row?.toProvider
}

/**
 * The name the Colony files this provider under (`#772`).
 *
 * **Every provider-keyed surface resolves through this before it reads or
 * writes**, which is the whole of what the issue asks for: a walk filed under
 * `clawhub.com` and a recipe read for `clawhub.ai` have to reach one row, or the
 * catalogue answers *nobody has looked* about something it already knows.
 *
 * **It answers with the name it was given when nothing is recorded**, rather than
 * with `undefined`. A caller that has to decide what to do with an empty answer
 * is a caller that will forget once, and the forgotten one is a write — which
 * fragments silently instead of failing.
 *
 * An unparseable name is returned untouched: rejecting it is the caller's own
 * validation, and answering a different question here would hide it.
 */
export async function canonicalProvider(
  db: Database | Transaction,
  provider: string,
): Promise<string> {
  const parsed = AccountProviderSchema.safeParse(provider)
  if (!parsed.success) return provider

  return (await providerRenamedTo(db, parsed.data)) ?? parsed.data
}
