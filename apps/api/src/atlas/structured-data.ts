import { ATLAS_PATH, atlasCategoryPath, type AtlasCategorySlug } from '@kolonie-ai/core'
import type { AtlasCriterion } from './criteria.js'

/**
 * The Atlas, as data a machine reads (`#789`).
 *
 * ## Why this is the cheapest reach on the surface
 *
 * `application/ld+json` appeared **0 times** anywhere on kolonie.ai, measured
 * 2026-08-12. The breadcrumb and the item list are the page's own structure
 * written down for a crawler: no new data, no curation, no request-time cost.
 *
 * ## The `HowTo` is gone, and it was the point of this file once
 *
 * `#789` emitted one `HowTo` per joinable row, because an Atlas entry page was
 * already a numbered list of steps with an actor on each — that shape written
 * down for crawlers. `#1100` decided the steps are what citizenship buys, and a
 * `HowTo` is a list of step names and step text. Publishing it beside a page
 * that no longer prints the steps would have made this file the leak, and
 * trimming it to the counts would have emitted a `HowTo` with no `HowToStep` in
 * it. **The rich-result eligibility is a real loss** and it is the price of the
 * rule, not an oversight: what the page offers a searcher instead is the
 * criteria and the findings extract.
 *
 * ## The one constraint, and it was checked rather than assumed
 *
 * These responses carry `default-src 'none'` with **no `script-src`**, measured
 * against the live headers of `/atlas/trello.com` on 2026-08-12:
 *
 * ```
 * content-security-policy: default-src 'none'; img-src 'self'; style-src 'unsafe-inline';
 *   form-action 'none'; base-uri 'none'; frame-ancestors 'none'
 * ```
 *
 * **A `<script type="application/ld+json">` is data and not a script.** CSP's
 * `script-src` governs what a browser *executes*; a block whose type is not a
 * JavaScript MIME type is never executed, so there is nothing for the policy to
 * refuse, and a parser reads it out of the DOM either way. The fallback named in
 * `#789` — serving the JSON at its own route behind `<link rel="alternate">` — is
 * therefore not taken, and the reason is written here so that a future reader can
 * disagree with the argument rather than rediscover the question.
 *
 * ## What is deliberately not here
 *
 * `Organization` belongs to the website and not to this route. `Dataset` is worth
 * having once the figures are publishable (`#792`). Both are `#789`'s own
 * exclusions, kept.
 *
 * **`FAQPage` was the third of them and `#1105` took it.** `#789` left it out
 * because turning `NOT_A_PROMISE` and the counterparty note into questions is a
 * content decision — and `#1105` made that decision somewhere else: the criteria
 * box is nine questions with their answers on the page, built by `criteria.ts`,
 * and this module renders the rows it is handed rather than composing questions
 * of its own. Nothing here reads the entry, so there is no second place for the
 * markup and the page to disagree.
 */

/**
 * The shelf's own path.
 *
 * **Written here rather than imported from `html.ts`**, which exports the same
 * one line: `html.ts` imports this module to emit the blocks, and a cycle
 * between the two would be a cycle for one string concatenation. `sitemap.ts`
 * makes the same call for the same reason.
 *
 * **It is the page and not the redirect** (`#1107` decision 3). A breadcrumb
 * naming `/atlas?category=mailbox` would tell a crawler the middle of the trail
 * is a 301, which is the one place a trail cannot afford to be indirect.
 */
const shelfPath = (category?: AtlasCategorySlug): string =>
  category === undefined ? ATLAS_PATH : atlasCategoryPath(category)

/**
 * JSON for an inline `ld+json` block, with `<` escaped.
 *
 * **This is the whole of the injection defence and it is not optional.** A
 * provider named `</script><script>…` would otherwise close the element and open
 * a real one — the values here are curated, but the catalogue is a table a
 * `psql` prompt writes to by design (`#521`), so *curated* is not a property this
 * function may assume. `>` and `&` go with it, because a partial escape is the
 * one that looks safe.
 */
export function asJsonLdBlock(value: unknown): string {
  const json = JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')

  return `<script type="application/ld+json">${json}</script>`
}

/**
 * Atlas → category → entry, from the same helper the page's own links use.
 *
 * **It asks for the four fields it reads and not for an entry** (`#1100`). The
 * page hands it the public projection, and a signature naming `AtlasEntry` would
 * have made this module a second place where somebody has to remember which of
 * the two an argument is.
 */
export function breadcrumbFor(
  entry: {
    readonly category: AtlasCategorySlug
    readonly title: string
    readonly path: string
  },
  siteUrl: string,
): string {
  const at = (path: string) => `${siteUrl}${path}`

  return asJsonLdBlock({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'The Atlas', item: at(shelfPath()) },
      {
        '@type': 'ListItem',
        position: 2,
        name: entry.category,
        item: at(shelfPath(entry.category)),
      },
      { '@type': 'ListItem', position: 3, name: entry.title, item: at(entry.path) },
    ],
  })
}

/**
 * The criteria box, as the questions it already answers (`#1105` decision 4).
 *
 * **A `FAQPage` whose answers are not on the page is a spam signal and a lie in
 * the same markup**, so this takes the rendered rows rather than an entry: there
 * is no way to call it with a question the box does not print, because the box
 * and this block are the same array. It is the replacement for the `HowTo`
 * `#1100` removed, and the difference is exactly the rule — a `HowTo` published
 * the steps citizenship buys, and this publishes the criteria anybody may read.
 *
 * The caller decides *whether* there is anything to answer (decision 7); this one
 * decides only how the rows are written down.
 */
export function faqPageFor(criteria: readonly AtlasCriterion[]): string {
  return asJsonLdBlock({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: criteria.map((one) => ({
      '@type': 'Question',
      name: one.question,
      acceptedAnswer: { '@type': 'Answer', text: one.answer },
    })),
  })
}

/**
 * The index, as the list it rendered.
 *
 * **In the order it was rendered in, and never re-sorted here.** That order is
 * `atlasByOutcome`'s — measured outcome, never payment — and a second sort at
 * this layer would be a second answer to the one question the ranking exists to
 * settle.
 */
export function itemListFor(
  entries: readonly { readonly title: string; readonly path: string }[],
  siteUrl: string,
  category?: AtlasCategorySlug | undefined,
): string {
  return asJsonLdBlock({
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: category === undefined ? 'The Atlas' : `The Atlas — ${category}`,
    numberOfItems: entries.length,
    itemListElement: entries.map((entry, at) => ({
      '@type': 'ListItem',
      position: at + 1,
      name: entry.title,
      url: `${siteUrl}${entry.path}`,
    })),
  })
}
