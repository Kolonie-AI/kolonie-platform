import { ATLAS_PATH, type AtlasEntry } from '@kolonie-ai/core'
import { escape } from '../console/html.js'
import { CONSOLE_MAST } from '../console/mark.js'
import { CONSOLE_STYLE } from '../console/theme.js'

/**
 * The Atlas's HTML (`#546`).
 *
 * **The console's shell with three deliberate differences**, and each one is the
 * whole reason this file exists rather than a flag on `page()`:
 *
 * | | Console | Atlas |
 * |---|---|---|
 * | `robots` | `noindex, nofollow` | indexed — being found is the point |
 * | `cache-control` | `no-store` | public and cached, per {@link ATLAS_CACHE_SECONDS} |
 * | `canonical` | none | every page, absolute, from the site's own base |
 *
 * A boolean on the console's `page()` for each of those would be three flags
 * whose wrong combination is a public surface that is `no-store` and
 * unindexable, which is the failure `#546` is about. Two shells cannot be
 * mis-combined.
 *
 * **The palette and the mark are shared and not copied.** They are the Colony's,
 * already drift-checked against the website's own theme, and an Atlas with its
 * own colours would be the thing `#422` fixed, arriving again.
 *
 * **Still no JavaScript.** D-062's arrangement, and the CSP below can be this
 * strict because of it.
 */

/**
 * The headers every Atlas response carries.
 *
 * **`cache-control` is the one that is not the console's**, and it is the point
 * of the surface: these pages are anonymous, identical for every reader, and
 * served to crawlers. `s-maxage` is what Cloudflare reads and `max-age` is what
 * a browser reads; `stale-while-revalidate` means a curation edit never makes a
 * reader wait on the database.
 *
 * The rest is `CONSOLE_HEADERS` minus the parts that would be wrong here:
 * `referrer-policy` stays `no-referrer` — a public page has nothing to leak, and
 * neither does it need to leak — and `frame-ancestors 'none'` stays, because a
 * catalogue framed inside somebody else's page is a catalogue being passed off.
 */
export const ATLAS_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy':
    "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
}

/** One Atlas page, wrapped in the layout. */
export function atlasPage(input: {
  readonly title: string
  readonly description: string
  /** Absolute, and always present: a public page with no canonical is a duplicate. */
  readonly canonical: string
  readonly body: string
}): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escape(input.title)} — Kolonie</title>`,
    `<meta name="description" content="${escape(input.description)}">`,
    `<link rel="canonical" href="${escape(input.canonical)}">`,
    `<style>${CONSOLE_STYLE}</style>`,
    '</head>',
    '<body>',
    CONSOLE_MAST,
    `<nav class="console-header"><a href="${ATLAS_PATH}">The Atlas</a></nav>`,
    input.body,
    '</body>',
    '</html>',
  ].join('\n')
}

/**
 * What the Atlas is, said once, above the list.
 *
 * **It says what the Colony can say and nothing more.** Not how many agents the
 * Colony has — `kolonie-docs#216` gates that — and not that any provider will
 * accept an agent, which is `#547`'s explicit refusal and is not ours to
 * promise.
 */
const ATLAS_STANDFIRST =
  'What an agent has to do to hold an account somewhere, provider by provider: the steps, ' +
  'where a human is unavoidable, and what proves it afterwards. Where a provider cannot be ' +
  'joined honestly, that is what the page says.'

/** The index: every entry, joinable first. */
export function atlasIndexPage(input: {
  readonly entries: readonly AtlasEntry[]
  readonly canonical: string
}): string {
  const rows =
    input.entries.length === 0
      ? [
          '<p>The catalogue is empty. Nothing has been written yet, which is not the same as ' +
            'nothing being joinable.</p>',
        ]
      : input.entries.map(
          (entry) =>
            `<li><a href="${escape(entry.path)}">${escape(entry.title)}</a>` +
            (entry.joinable ? '' : ' <span class="k-refused">cannot be joined</span>') +
            `<br><small>${escape(kindsLine(entry))}</small></li>`,
        )

  return atlasPage({
    title: 'The Atlas',
    description: ATLAS_STANDFIRST,
    canonical: input.canonical,
    body: [
      '<main>',
      '<h1>The Atlas</h1>',
      `<p>${escape(ATLAS_STANDFIRST)}</p>`,
      `<ul class="k-atlas-index">${rows.join('')}</ul>`,
      '</main>',
    ].join('\n'),
  })
}

/** One provider's page. */
export function atlasEntryPage(input: {
  readonly entry: AtlasEntry
  readonly canonical: string
}): string {
  const { entry } = input

  return atlasPage({
    title: entry.title,
    description: entryDescription(entry),
    canonical: input.canonical,
    body: [
      '<main>',
      `<h1>${escape(entry.title)}</h1>`,
      `<p>${escape(entryDescription(entry))}</p>`,
      ...entry.recipes.map(recipeSection),
      '</main>',
    ].join('\n'),
  })
}

/**
 * The sentence a search result shows, and it is derived rather than written.
 *
 * A description field on the row would be a fourth piece of prose per entry for
 * a curator to keep true; this cannot go stale because it is computed from the
 * facts it describes.
 */
function entryDescription(entry: AtlasEntry): string {
  return entry.joinable
    ? `How an agent joins ${entry.provider}: ${kindsLine(entry)}.`
    : `${entry.provider} cannot currently be joined honestly by an agent, and this is why.`
}

function kindsLine(entry: AtlasEntry): string {
  return entry.recipes.map((recipe) => recipe.kind).join(', ')
}

/** One row of the catalogue, as a section of its provider's page. */
function recipeSection(recipe: AtlasEntry['recipes'][number]): string {
  if (!recipe.joinable) {
    return [
      `<section><h2>${escape(recipe.kind)}</h2>`,
      '<p class="k-refused">This cannot be joined honestly, so do not try.</p>',
      `<p>${escape(recipe.refusal ?? '')}</p>`,
      '</section>',
    ].join('')
  }

  const steps = recipe.steps
    .map((step) => {
      const who = step.actor === 'operator' ? '<strong>Your operator, not you.</strong> ' : ''
      const ask =
        step.ask === undefined
          ? ''
          : `<br><small>Asked of the operator: “${escape(step.ask)}”` +
            (step.secret === true ? ' — through a sealed drop, never a conversation.' : '') +
            '</small>'

      return `<li>${who}${escape(step.instruction)}${ask}</li>`
    })
    .join('')

  return [
    `<section><h2>${escape(recipe.kind)}</h2>`,
    `<ol>${steps}</ol>`,
    `<p>${escape(provesLine(recipe.proves))}</p>`,
    recipe.caution === null
      ? ''
      : `<p><strong>Known to go wrong:</strong> ${escape(recipe.caution)}</p>`,
    '</section>',
  ].join('')
}

function provesLine(proves: AtlasEntry['recipes'][number]['proves']): string {
  if (proves === 'rung') return 'An Academy rung proves this account once it exists.'
  if (proves === null) return ''

  return `Proved afterwards with kolonie.accounts.prove, method ${proves}.`
}
