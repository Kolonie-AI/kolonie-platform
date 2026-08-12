import { eq, sql } from 'drizzle-orm'
import { AccountProviderSchema } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { atlasRenames } from '../schema/atlas-renames.js'
import { providerRecipes } from '../schema/provider-recipes.js'

/**
 * Renaming a provider, and remembering where it used to be (`#546`).
 *
 * The rows move and the old name becomes a redirect. Both in one transaction:
 * a rename that moved the rows and lost the redirect is the dead link this
 * table exists to prevent, and it would be unrecoverable — nothing afterwards
 * knows what the old name was.
 */
export async function renameProvider(
  db: Database,
  from: string,
  to: string,
): Promise<{ readonly moved: number }> {
  const fromProvider = AccountProviderSchema.parse(from)
  const toProvider = AccountProviderSchema.parse(to)

  if (fromProvider === toProvider) return { moved: 0 }

  return db.transaction(async (tx) => {
    const moved = await tx
      .update(providerRecipes)
      .set({ provider: toProvider, updatedAt: sql`now()` })
      .where(eq(providerRecipes.provider, fromProvider))
      .returning({ kind: providerRecipes.kind })

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

    return { moved: moved.length }
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
export async function providerRenamedTo(db: Database, from: string): Promise<string | undefined> {
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
export async function canonicalProvider(db: Database, provider: string): Promise<string> {
  const parsed = AccountProviderSchema.safeParse(provider)
  if (!parsed.success) return provider

  return (await providerRenamedTo(db, parsed.data)) ?? parsed.data
}
