import { and, asc, eq, isNotNull, isNull, lte, or, sql } from 'drizzle-orm'
import { now as currentTime, PROVIDER_ICON_TTL_DAYS, type AvatarFormat } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { atlasProviderIcons } from '../schema/atlas-provider-icons.js'
import { providerRecipes } from '../schema/provider-recipes.js'

/**
 * Reading and writing the Colony's copies of provider icons (`#1405`).
 *
 * Three acts, and each has exactly one caller: the Atlas route asks for one
 * icon, the sweep asks which providers are due, and the sweep writes what it
 * found. Nothing here fetches anything — the address guard and the byte ceiling
 * live in `packages/verifiers`, and the sanitiser lives in `packages/core`.
 */

/** One stored icon, as the route serves it. */
export interface StoredProviderIcon {
  readonly bytes: Uint8Array
  readonly format: AvatarFormat
}

/** Why a provider has no icon, for grouping rather than for a reader. */
export type ProviderIconAbsence = 'no-homepage' | 'unreachable' | 'no-candidate' | 'refused'

/**
 * The icon for one provider, or nothing.
 *
 * **Nothing is an ordinary answer and never an error.** Most providers have no
 * stored icon at any given moment — the sweep has not reached them, or it has
 * and there was none — and the route answers all three of those cases with the
 * monogram. A caller that had to distinguish them would be a caller drawing a
 * different picture for *not yet looked*, which is a fact about the Colony's
 * schedule rather than about the provider.
 */
export async function providerIcon(
  db: Database,
  provider: string,
): Promise<StoredProviderIcon | undefined> {
  const [row] = await db
    .select({ bytes: atlasProviderIcons.bytes, format: atlasProviderIcons.format })
    .from(atlasProviderIcons)
    .where(and(eq(atlasProviderIcons.provider, provider), isNotNull(atlasProviderIcons.bytes)))
    .limit(1)

  if (row?.bytes == null || row.format == null) return undefined
  return { bytes: row.bytes, format: row.format }
}

/**
 * Which providers the sweep should look at next, oldest first.
 *
 * **`homepages` is passed in rather than joined to.** A homepage lives on a
 * recipe and a provider has several, so *which homepage is this provider's* is a
 * question the catalogue already answers and this module has no business
 * answering a second way. The sweep hands over what the catalogue said.
 *
 * A provider with no row at all is due; a provider whose `refreshAfter` has
 * passed is due; everything else is not. `limit` is what keeps one tick from
 * fetching four hundred third-party hosts at once.
 */
export async function providersDueForIcon(
  db: Database,
  homepages: ReadonlyMap<string, string>,
  limit: number,
): Promise<readonly { readonly provider: string; readonly homepage: string }[]> {
  if (homepages.size === 0 || limit <= 0) return []

  const providers = [...homepages.keys()]

  const rows = await db
    .select({
      provider: atlasProviderIcons.provider,
      refreshAfter: atlasProviderIcons.refreshAfter,
    })
    .from(atlasProviderIcons)
    .where(sql`${atlasProviderIcons.provider} = any(${providers})`)

  const known = new Map(rows.map((row) => [row.provider, row.refreshAfter]))
  const at = currentTime()

  /**
   * **Never looked at first, then the longest overdue.**
   *
   * A provider the Colony has never asked about is the one a reader is most
   * likely to be looking at a blank monogram for, and a provider whose copy went
   * stale still has a picture. Within each group the order is deterministic —
   * the map's own — so a sweep that is interrupted resumes where it was rather
   * than reshuffling.
   */
  const never: { provider: string; homepage: string }[] = []
  const stale: { provider: string; homepage: string; refreshAfter: string }[] = []

  for (const [provider, homepage] of homepages) {
    const refreshAfter = known.get(provider)
    if (refreshAfter === undefined) never.push({ provider, homepage })
    else if (refreshAfter <= at) stale.push({ provider, homepage, refreshAfter })
  }

  stale.sort((one, other) => one.refreshAfter.localeCompare(other.refreshAfter))

  return [...never, ...stale.map(({ provider, homepage }) => ({ provider, homepage }))].slice(
    0,
    limit,
  )
}

/** What the sweep found for one provider. */
export type ProviderIconFinding =
  | {
      readonly outcome: 'icon'
      readonly bytes: Uint8Array
      readonly format: AvatarFormat
      readonly width: number
      readonly height: number
      readonly sourceUrl: string
    }
  | { readonly outcome: 'none'; readonly absence: ProviderIconAbsence }

/**
 * Write what the sweep found, whichever it was.
 *
 * **A finding of nothing overwrites an icon**, and that is deliberate: a
 * provider that took its favicon down has taken it down, and keeping the last
 * copy the Colony happened to catch would be the catalogue asserting something
 * that stopped being true. The monogram is the honest picture at that point.
 *
 * `refreshAfter` is set from {@link PROVIDER_ICON_TTL_DAYS} for both outcomes.
 * A host that has nothing is asked no more often than one that has something —
 * the Colony has no reason to press a provider that already said no.
 */
export async function recordProviderIcon(
  db: Database,
  provider: string,
  finding: ProviderIconFinding,
): Promise<void> {
  const at = currentTime()
  const refreshAfter = new Date(Date.parse(at) + PROVIDER_ICON_TTL_DAYS * 86_400_000).toISOString()

  const values =
    finding.outcome === 'icon'
      ? {
          bytes: finding.bytes,
          format: finding.format,
          width: finding.width,
          height: finding.height,
          sourceUrl: finding.sourceUrl,
          absence: null,
        }
      : {
          bytes: null,
          format: null,
          width: null,
          height: null,
          sourceUrl: null,
          absence: finding.absence,
        }

  await db
    .insert(atlasProviderIcons)
    .values({ provider, ...values, fetchedAt: at, refreshAfter })
    .onConflictDoUpdate({
      target: atlasProviderIcons.provider,
      set: { ...values, fetchedAt: at, refreshAfter },
    })
}

/**
 * Which of these providers the Colony holds an icon for.
 *
 * Asked once per Atlas page with the providers that page is about, so a shelf of
 * forty tiles costs one query rather than forty. **A provider missing from the
 * answer gets a monogram**, which is the same picture it would get from a row
 * that says there is nothing — the page does not distinguish them and neither
 * does this.
 */
export async function providersWithIcons(
  db: Database,
  providers: readonly string[],
): Promise<ReadonlySet<string>> {
  if (providers.length === 0) return new Set()

  const rows = await db
    .select({ provider: atlasProviderIcons.provider })
    .from(atlasProviderIcons)
    .where(
      and(
        sql`${atlasProviderIcons.provider} = any(${[...providers]})`,
        isNotNull(atlasProviderIcons.bytes),
      ),
    )

  return new Set(rows.map((row) => row.provider))
}

/**
 * How many providers the Colony holds an icon for, and how many it has looked
 * at.
 *
 * For the sweep's own log line, which is the only thing that reads it: a sweep
 * whose *found* number stops moving while its *looked* number climbs is one
 * where something has broken at the far end, and neither number says that on its
 * own.
 */
export async function providerIconCounts(
  db: Database,
): Promise<{ readonly held: number; readonly looked: number }> {
  const [row] = await db
    .select({
      held: sql<number>`count(*) filter (where ${atlasProviderIcons.bytes} is not null)`.mapWith(
        Number,
      ),
      looked: sql<number>`count(*)`.mapWith(Number),
    })
    .from(atlasProviderIcons)

  return { held: row?.held ?? 0, looked: row?.looked ?? 0 }
}

/**
 * Every provider the catalogue holds an https homepage for.
 *
 * **One per provider, and the newest recipe's wins.** A provider has a row per
 * account kind and each may carry a homepage; they are almost always the same
 * string, and where they are not, the most recently updated walk is the one a
 * walker looked at most recently. Nothing downstream depends on which — the
 * icon is the company's, not the account kind's.
 *
 * The `is not null` is the filter that matters: a provider nobody has recorded a
 * homepage for is not something the sweep can look at, and it is recorded as
 * `no-homepage` by the caller rather than retried.
 */
export async function providerHomepages(db: Database): Promise<ReadonlyMap<string, string>> {
  const rows = await db
    .select({
      provider: providerRecipes.provider,
      homepage: providerRecipes.homepage,
      updatedAt: providerRecipes.updatedAt,
    })
    .from(providerRecipes)
    .where(isNotNull(providerRecipes.homepage))
    .orderBy(asc(providerRecipes.updatedAt))

  const homepages = new Map<string, string>()
  for (const row of rows) if (row.homepage !== null) homepages.set(row.provider, row.homepage)

  return homepages
}

/**
 * Every provider whose stored copy is due, ignoring the catalogue.
 *
 * Exported for the test that asserts the floor is a floor: `refreshAfter` is
 * what decides, and a query that read `fetchedAt` and added seven days would
 * give the same answer today and a different one the day somebody wanted a
 * refused host backed off further.
 */
export async function providerIconsDue(db: Database): Promise<readonly string[]> {
  const rows = await db
    .select({ provider: atlasProviderIcons.provider })
    .from(atlasProviderIcons)
    .where(
      or(
        isNull(atlasProviderIcons.refreshAfter),
        lte(atlasProviderIcons.refreshAfter, currentTime()),
      ),
    )
    .orderBy(asc(atlasProviderIcons.refreshAfter))

  return rows.map((row) => row.provider)
}
