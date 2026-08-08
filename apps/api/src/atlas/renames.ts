import type { Database } from '@kolonie-ai/db'
import { providerRenamedTo, renameProvider } from '@kolonie-ai/db'

/**
 * Where a provider used to be (`#546`).
 *
 * **Read on the page's miss, written by curation** (`#549`). Two methods rather
 * than one because they belong to different surfaces and different audiences: a
 * crawler following an old link only ever reads, and only a curator renames.
 */
export interface AtlasRenames {
  /** What an old provider name means now, or nothing if it was never renamed. */
  renamedTo(from: string): Promise<string | undefined>
  /** Move a provider's rows and remember where it was. */
  rename(from: string, to: string): Promise<{ readonly moved: number }>
}

export function databaseAtlasRenames(db: Database): AtlasRenames {
  return {
    renamedTo: (from) => providerRenamedTo(db, from),
    rename: (from, to) => renameProvider(db, from, to),
  }
}
