import type { Database } from '@kolonie-ai/db'
import { providerIcon, providersWithIcons, type StoredProviderIcon } from '@kolonie-ai/db'

/**
 * The Colony's own copies of provider icons, as the Atlas reads them (`#1405`).
 *
 * **Its own reader rather than a method on the provider catalogue**, for the
 * reason `AtlasPlaybookReader` is its own: the catalogue is read on every Atlas
 * surface and most of them want nothing to do with bytes. A `select` that
 * carried a favicon on every row of `catalogue.json` would be a payload nobody
 * asked for on a document a third party stores.
 *
 * Two questions, and they are deliberately different shapes:
 *
 * - **`held`** is asked once per page with that page's providers, so a shelf of
 *   forty tiles costs one query. It answers *which of these should carry an
 *   `<img>`*, and everything it leaves out gets a monogram drawn inline.
 * - **`bytes`** is asked by the image route for one provider.
 *
 * Optional at every layer above, so a deployment without it renders the pages it
 * rendered before this existed: every provider gets a monogram, which is a
 * complete picture rather than a gap.
 */
export interface AtlasIconReader {
  /** Which of these providers the Colony holds an icon for. */
  held(providers: readonly string[]): Promise<ReadonlySet<string>>
  /** One provider's icon, or nothing. */
  bytes(provider: string): Promise<StoredProviderIcon | undefined>
}

/** The reader, wired to the database. */
export function databaseAtlasIcons(db: Database): AtlasIconReader {
  return {
    held: (providers) => providersWithIcons(db, providers),
    bytes: (provider) => providerIcon(db, provider),
  }
}
