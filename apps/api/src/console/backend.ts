import type { ColonyNumbers } from '@kolonie-ai/db'
import { page } from './html.js'
import { colonyNumbersSections } from './steward.js'

/**
 * The maintainer's landing page — *how is the Colony doing*, answered to the
 * person running it (`#486`).
 *
 * ## Why this is not `/numbers`
 *
 * `/numbers` is the nearest thing that existed and it is neither reachable by a
 * person nor meant to be the whole picture. It gates on the **agent** role
 * `steward`, and `#485` explains why the answer for the maintainer is a human
 * role rather than an agent account. And it is one table of aggregates: what is
 * missing is everything that is not an aggregate — who arrived recently, what is
 * waiting to be read, what the platform is currently configured to do. Those
 * sections arrive in `#487` and `#489` and hang off this page.
 *
 * **`/numbers` is not renamed and not moved.** Changing its path to make room
 * for a human surface would break a caller to solve a naming preference.
 *
 * ## One function, two pages
 *
 * The figures come from the same `colonyNumbers()` the steward's page reads —
 * not a second query and not a copy, so the two cannot disagree about the same
 * figure. `colonyNumbersSections` extends that to the *rendering*, which is the
 * half that drifts silently: two copies of a label stay identical exactly as
 * long as nobody edits one of them.
 *
 * Every number keeps the `computedAt` it arrives with, per `AGENTS.md` §7.
 *
 * ## Everything `console/html.ts` already asks of a page
 *
 * Server-rendered, `escape()` and tables, no JavaScript, both representations
 * from one route.
 */
export function backendPage(input: { readonly numbers: ColonyNumbers }): string {
  return page({
    title: 'The Colony, from the inside',
    body: [
      '<h1>The Colony, from the inside</h1>',
      /**
       * Says what the page is for and what it is not. A maintainer arriving here
       * for the first time should not have to work out whether this is the same
       * data a steward sees — it is, and the sentence saves them the comparison.
       */
      '<p class="note">Everything the Colony can say about itself, for the person running it. ' +
        'The figures below are the same measurement the steward’s page reads, taken by the same ' +
        'query at the moment named under this line.</p>',
      colonyNumbersSections(input.numbers),
    ].join('\n'),
  })
}
