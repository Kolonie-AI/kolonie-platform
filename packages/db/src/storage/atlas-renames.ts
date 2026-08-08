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
      .values({ fromProvider, toProvider })
      .onConflictDoUpdate({
        target: atlasRenames.fromProvider,
        set: { toProvider, renamedAt: sql`now()` },
      })

    return { moved: moved.length }
  })
}

/** Where an old provider name points now, or nothing if it was never renamed. */
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
