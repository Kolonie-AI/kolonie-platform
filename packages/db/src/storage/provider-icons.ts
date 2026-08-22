import { and, eq, isNull, lte, or, sql } from 'drizzle-orm'
import type { Database } from '../client.js'
import { providerIcons } from '../schema/provider-icons.js'

/**
 * The provider icon cache (`#1405`).
 *
 * **Both outcomes are stored and the failure is the important one.** Most
 * providers have no icon the Colony can reach — measured 2026-08-22, two of
 * eight sampled entries carried a homepage at all — so caching only successes
 * would turn *this provider has no mark* into a fetch on every render of every
 * shelf that lists it.
 */

/** Seven days, which is `#1405` decision 2's floor rather than a guess at one. */
export const PROVIDER_ICON_TTL_MS = 7 * 24 * 60 * 60 * 1000

export interface StoredProviderIcon {
  readonly provider: string
  /** Null where the fetch produced no image; {@link refusal} says why. */
  readonly bytes: Uint8Array | null
  readonly format: string | null
  readonly sourceUrl: string | null
  readonly refusal: string | null
  readonly fetchedAt: string
  readonly expiresAt: string
  /** Whether {@link expiresAt} has passed, answered by the database's clock. */
  readonly stale: boolean
}

/**
 * What the Colony holds for this provider, fresh or stale.
 *
 * **Stale is returned rather than hidden**, and the caller decides. A mark a
 * week old is a better answer than a blank tile while a refetch happens, and a
 * reader cannot tell the difference; hiding it would make every expiry a visible
 * flicker on a page nobody was waiting on.
 */
export async function providerIcon(
  db: Database,
  provider: string,
): Promise<StoredProviderIcon | undefined> {
  const [row] = await db
    .select({
      provider: providerIcons.provider,
      bytes: providerIcons.bytes,
      format: providerIcons.format,
      sourceUrl: providerIcons.sourceUrl,
      refusal: providerIcons.refusal,
      fetchedAt: providerIcons.fetchedAt,
      expiresAt: providerIcons.expiresAt,
      stale: sql<boolean>`${providerIcons.expiresAt} <= now()`,
    })
    .from(providerIcons)
    .where(eq(providerIcons.provider, provider))
    .limit(1)

  return row
}

/**
 * Record what a fetch produced, image or reason.
 *
 * One row per provider, replaced rather than appended: a version history of a
 * favicon is not something anybody has a use for, and the previous mark stops
 * being true the moment the provider changes it.
 */
export async function recordProviderIcon(
  db: Database,
  input: {
    readonly provider: string
    readonly bytes?: Uint8Array | null
    readonly format?: string | null
    readonly sourceUrl?: string | null
    readonly refusal?: string | null
    readonly ttlMs?: number
  },
): Promise<void> {
  const expiresAt = new Date(Date.now() + (input.ttlMs ?? PROVIDER_ICON_TTL_MS)).toISOString()
  const values = {
    provider: input.provider,
    bytes: input.bytes ?? null,
    format: input.format ?? null,
    sourceUrl: input.sourceUrl ?? null,
    refusal: input.refusal ?? null,
    fetchedAt: new Date().toISOString(),
    expiresAt,
  }

  await db.insert(providerIcons).values(values).onConflictDoUpdate({
    target: providerIcons.provider,
    set: values,
  })
}

/**
 * Providers whose mark is worth fetching, oldest first.
 *
 * **A provider with no row at all is not in here**, because this reads the cache
 * rather than the catalogue: the caller knows which providers exist and passes
 * the ones it cares about. What this answers is *which of these have I either
 * never looked at, or looked at long enough ago that I should look again*.
 */
export async function staleProviderIcons(db: Database, limit = 20): Promise<readonly string[]> {
  const rows = await db
    .select({ provider: providerIcons.provider })
    .from(providerIcons)
    .where(or(lte(providerIcons.expiresAt, sql`now()`), isNull(providerIcons.expiresAt)))
    .orderBy(providerIcons.expiresAt)
    .limit(limit)

  return rows.map((row) => row.provider)
}

/** Which of these providers the cache has never been asked about. */
export async function providerIconsMissing(
  db: Database,
  providers: readonly string[],
): Promise<readonly string[]> {
  if (providers.length === 0) return []

  const rows = await db
    .select({ provider: providerIcons.provider })
    .from(providerIcons)
    .where(and(sql`${providerIcons.provider} = any(${providers})`))

  const held = new Set(rows.map((row) => row.provider))
  return providers.filter((provider) => !held.has(provider))
}
