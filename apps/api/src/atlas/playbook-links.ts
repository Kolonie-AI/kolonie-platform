import type { Database } from '@kolonie-ai/db'
import { playbooksNamingProvider } from '@kolonie-ai/db'
import type { AccountProvider } from '@kolonie-ai/core'
import type { NamingPlaybook } from './html.js'

/**
 * The playbooks an Atlas entry's provider is needed for (`kolonie-website#116`).
 *
 * **Its own reader rather than a method on the playbook catalogue**, for the
 * reason `AtlasQuestReader` is its own: this is read on one page for one purpose,
 * and folding it into the store the `/playbooks` surfaces call would put a
 * per-provider query on the path of every catalogue read that does not want it.
 *
 * Optional at every layer above, so a deployment with no playbooks renders the
 * page it rendered before this existed.
 */
export interface AtlasPlaybookReader {
  /** Open playbooks naming this provider in what they require. */
  naming(provider: AccountProvider): Promise<readonly NamingPlaybook[]>
}

export function databaseAtlasPlaybooks(db: Database): AtlasPlaybookReader {
  return {
    naming: async (provider) => await playbooksNamingProvider(db, provider),
  }
}
