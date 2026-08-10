import type { Database } from '@kolonie-ai/db'
import { questsNamingProvider } from '@kolonie-ai/db'
import type { AccountProvider } from '@kolonie-ai/core'
import type { SponsoringQuest } from './html.js'

/**
 * The quests an Atlas entry names (`#622`, rendered by `#602`).
 *
 * **Its own reader rather than a method on the recipes store**, for the reason
 * `AtlasRenames` is its own: this is read on one page for one purpose, and
 * folding it into the store every public surface calls would put quest data on
 * the path of every catalogue read that does not want it.
 *
 * Optional at every layer above, so a deployment with no quests renders the page
 * it rendered before this existed.
 */
export interface AtlasQuestReader {
  /** Open quests naming this provider, with what each bought. */
  naming(provider: AccountProvider): Promise<readonly SponsoringQuest[]>
}

export function databaseAtlasQuests(db: Database): AtlasQuestReader {
  return {
    naming: async (provider) => await questsNamingProvider(db, provider),
  }
}
