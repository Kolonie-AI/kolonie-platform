import type { Database } from '@kolonie-ai/db'
import { playbooksNamingKinds, playbooksNamingProvider } from '@kolonie-ai/db'
import type { AccountProvider } from '@kolonie-ai/core'
import type { NamingPlaybook } from './html.js'

/**
 * How many playbooks a provider page lists (`#1416` decision 2).
 *
 * The section answers *what is an account here for*, and five answers it. A
 * longer list is the playbook catalogue, which is one call away and is where a
 * reader who wants all of them should go.
 */
export const ATLAS_PLAYBOOKS_SHOWN = 5

/**
 * The playbooks an Atlas entry's provider is needed for (`kolonie-website#116`,
 * widened by `#1416`).
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
  /**
   * Open playbooks for this entry: pinned to the provider first, then — on an
   * earn rail only — ones naming a kind it carries.
   */
  naming(asked: {
    readonly provider: AccountProvider
    /**
     * The kinds this entry carries, and empty on an entry with no earn facet.
     *
     * **The caller decides, and that is the whole of `#1416`'s narrowing.**
     * `kolonie-website#116` made this reader provider-exact because *a playbook
     * needing a mailbox* on every mailbox entry is doorway content. An earn rail
     * is where the same match becomes specific — the pipeline that runs a bounty
     * board runs this one — so the route decides which of the two an entry is
     * and passes kinds only for the second.
     */
    readonly kinds: readonly string[]
  }): Promise<readonly NamingPlaybook[]>
}

export function databaseAtlasPlaybooks(db: Database): AtlasPlaybookReader {
  return {
    naming: async ({ provider, kinds }) => {
      const pinned = await playbooksNamingProvider(db, provider, ATLAS_PLAYBOOKS_SHOWN)
      if (pinned.length >= ATLAS_PLAYBOOKS_SHOWN || kinds.length === 0) {
        return pinned.slice(0, ATLAS_PLAYBOOKS_SHOWN)
      }

      /**
       * **Pinned first, and the kind matches only fill what is left** —
       * decision 2's *prefer provider pin*. A playbook that named this provider
       * is about this provider; one that named its kind is about a shape it
       * happens to have.
       *
       * Deduplicated by slug, because a playbook pinned here **and** naming the
       * kind answers both queries and is one playbook.
       */
      const held = new Set(pinned.map((one) => one.slug))
      const byKind = await playbooksNamingKinds(db, kinds, ATLAS_PLAYBOOKS_SHOWN)

      return [...pinned, ...byKind.filter((one) => !held.has(one.slug))].slice(
        0,
        ATLAS_PLAYBOOKS_SHOWN,
      )
    },
  }
}
