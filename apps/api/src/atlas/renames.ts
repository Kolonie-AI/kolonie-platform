import type { Database } from '@kolonie-ai/db'
import { aliasProvider, canonicalProvider, providerRenamedTo, renameProvider } from '@kolonie-ai/db'
import type { AliasOutcome } from '@kolonie-ai/db'

/**
 * What a provider name means (`#546`, `#772`).
 *
 * **Read on the page's miss, written by curation** (`#549`). The methods belong
 * to different surfaces and different audiences: a crawler following an old link
 * only ever reads, and only a curator renames or aliases.
 *
 * **`canonical` is the one every other surface calls**, and it is separate from
 * `renamedTo` for a reason that is easy to lose: `renamedTo` answers *was this
 * name redirected*, which is the page's question because the answer decides
 * whether to send a 301. `canonical` answers *what do I file this under*, which
 * is every read and every write's question, and it has no empty case — a name
 * nobody has aliased means itself.
 */
export interface AtlasRenames {
  /** What an old provider name means now, or nothing if it was never redirected. */
  renamedTo(from: string): Promise<string | undefined>
  /** The name to file a provider under — itself, unless something says otherwise. */
  canonical(provider: string): Promise<string>
  /** Move a provider's rows and remember where it was. */
  rename(from: string, to: string): Promise<{ readonly moved: number }>
  /** Record that a second live name means an existing one, moving nothing. */
  alias(from: string, to: string): Promise<AliasOutcome>
}

export function databaseAtlasRenames(db: Database): AtlasRenames {
  return {
    renamedTo: (from) => providerRenamedTo(db, from),
    canonical: (provider) => canonicalProvider(db, provider),
    rename: (from, to) => renameProvider(db, from, to),
    alias: (from, to) => aliasProvider(db, from, to),
  }
}
