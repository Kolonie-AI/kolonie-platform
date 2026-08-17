import {
  ATLAS_PATH,
  atlasCapabilityPhrase,
  atlasCategoryPath,
  atlasIsWalked,
  atlasKindPhrase,
  atlasShelfTitle,
  atlasConditionsSentences,
  type AtlasCategoryRow,
  RETIRED_ENTRY_NOTE,
  STALE_ENTRY_NOTE,
  UNWRITTEN_ENTRY_NOTE,
  isStale,
  ATLAS_RETENTION_DAYS,
  atlasBandPhrase,
  atlasStopPhrase,
  atlasStopStep,
  figureKey,
  providerBriefingAgeHours,
  providerClaimsIn,
  throughRate,
  WALL_KIND_MEANINGS,
  type AtlasCategorySlug,
  type AtlasEntry,
  type AtlasFigures,
  type ProviderBriefing,
  type ServedProviderBriefingClaim,
} from '@kolonie-ai/core'
import { escape } from '../console/html.js'
import {
  atlasCriteria,
  atlasEntryQuestion,
  atlasShelfQuestion,
  type AtlasCriterion,
} from './criteria.js'
import { breadcrumbFor, faqPageFor, itemListFor } from './structured-data.js'
import {
  atlasPublicEntries,
  atlasPublicEntry,
  type AtlasPublicEntry,
  type AtlasPublicRecipe,
} from './public-projection.js'
import { atlasEntryWorked } from './worked.js'
import { CONSOLE_MAST } from '../console/mark.js'
import { CONSOLE_STYLE } from '../console/theme.js'
import { ATLAS_STYLE } from './style.js'
import type { SiteChrome } from './site-chrome.js'

/**
 * The Atlas's HTML (`#546`).
 *
 * **The console's shell with three deliberate differences**, and each one is the
 * whole reason this file exists rather than a flag on `page()`:
 *
 * | | Console | Atlas |
 * |---|---|---|
 * | `robots` | `noindex, nofollow` | indexed — being found is the point, bar the placeholders (`#790`) |
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
 *
 * **`style-src` has to permit two different things, and it did only one of them**
 * (`#786`). `'unsafe-inline'` is for the `<style>` block `atlasPage()` writes.
 * `'self'` is for the site chrome: `parseSiteChrome` lifts the website's
 * `<link rel="stylesheet">` elements into the head, and until 2026-08-12 the
 * policy refused every one of them — so the markup arrived and the rules never
 * did, and the header's inline mark rendered at 1248px because the rule
 * constraining it was in a blocked file. Same origin, same build, same deploy:
 * these pages are host routes on the website's own domain, so the fragment's
 * stylesheets are `'self'` by construction.
 *
 * **No `script-src`, and that is not an oversight.** D-062 stands: an Atlas page
 * runs nothing. A script the fragment contributes is dropped by the browser, and
 * that is the intended outcome — `kolonie-website#107` is the footer's.
 */
export const ATLAS_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy':
    "default-src 'none'; img-src 'self'; style-src 'self' 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
}

/**
 * One Atlas page, wrapped in the layout.
 *
 * **The site's own header and footer go around it when they can be reached**
 * (`kolonie-website#99`). They are fetched from `kolonie.ai/site-chrome/` and
 * never reproduced here — see `site-chrome.ts` for why that is the shape, and
 * for what happens when the fetch fails.
 *
 * `chrome` being absent is an ordinary state and not an error: the page renders
 * exactly as it did before `#99`, with its own mast and one navigation link.
 * That is what the two fallbacks below are, and they are the reason a static
 * site being down cannot take the catalogue with it.
 *
 * **`data-theme="dark"` is written on the `<html>` element when the chrome is
 * present.** The site's own layout writes it, its components are styled against
 * it, and a header lifted out of a page that had it into one that did not is a
 * header rendering in a theme nothing selected.
 */
export function atlasPage(input: {
  readonly title: string
  readonly description: string
  /** Absolute, and always present: a public page with no canonical is a duplicate. */
  readonly canonical: string
  readonly body: string
  readonly chrome?: SiteChrome | undefined
  /**
   * Machine-readable copies of what the page says (`#789`).
   *
   * **Blocks rather than objects**, so that the escaping lives in one function
   * next to the argument for it — `asJsonLdBlock` — instead of being something
   * every caller has to remember. Absent is the ordinary state for any page that
   * has nothing structured to say.
   */
  readonly jsonLd?: readonly string[] | undefined
  /**
   * What a crawler is asked to do with this page (`#790`).
   *
   * **Absent on every page that has something to say**, which is nearly all of
   * them: being found is the point of the surface, and a default here would be
   * a public catalogue one wrong flag away from invisible. The one caller that
   * passes it is an entry nobody has walked — see {@link atlasEntryPage}.
   */
  readonly robots?: string | undefined
}): string {
  const { chrome } = input

  return [
    '<!doctype html>',
    chrome === undefined ? '<html lang="en">' : '<html lang="en" data-theme="dark">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escape(input.title)} — Kolonie</title>`,
    `<meta name="description" content="${escape(input.description)}">`,
    input.robots === undefined ? '' : `<meta name="robots" content="${escape(input.robots)}">`,
    `<link rel="canonical" href="${escape(input.canonical)}">`,
    /**
     * The console's tokens and element rules, then the Atlas's own
     * (`kolonie-website#97`). Two blocks and not one: `CONSOLE_STYLE` is shared
     * with every operator surface and this is only for these pages, so a change
     * here cannot reach the console and a change there reaches both — which is
     * the point of it being shared.
     */
    `<style>${CONSOLE_STYLE}${ATLAS_STYLE}</style>`,
    /**
     * **After the style block and inside the head that was already `<style>`-only**
     * (`#789`). It is data, not script: see `structured-data.ts` for the CSP
     * argument and the headers it was checked against.
     */
    ...(input.jsonLd ?? []),
    chrome?.head ?? '',
    '</head>',
    '<body>',
    /**
     * The site's header, or the mast this page had before there was one. Never
     * both: two identities at the top of one page is what `#50` is named for.
     */
    chrome?.header ??
      `${CONSOLE_MAST}\n<nav class="console-header"><a href="${ATLAS_PATH}">The Atlas</a></nav>`,
    input.body,
    chrome?.footer ?? '',
    '</body>',
    '</html>',
  ]
    .filter((line) => line !== '')
    .join('\n')
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
  'joined honestly, that is what the page says — and where nobody has looked yet, it says that ' +
  'instead of guessing.'

/**
 * Where the Colony answers an agent, and the page a human installs it from
 * (`#787`).
 *
 * **Named here rather than imported from `about.ts`**, whose `MCP_ENDPOINT` is
 * the `/mcp` path an MCP client POSTs to. What a page prints for a reader to
 * type into a client's host field is the host, and the two are different
 * strings for different audiences.
 */
const MCP_HOST = 'mcp.kolonie.ai'

/** The website's own install page, which is not a route this API serves. */
const SKILL_PATH = '/skill/'

/**
 * One line, under the standfirst, saying that the recipes below are walked with
 * tools a reader may not have (`#787`).
 *
 * **A line and not the entry page's block.** The index carries no steps, so
 * there is nothing here to say *you cannot execute this*; what it owes a
 * stranger is the existence of the door, once, without turning the catalogue
 * into a signup page.
 */
const ATLAS_JOIN_LINE =
  '<p><small>The recipes here are walked with Colony tools, which need an account of your own: ' +
  `an agent registers over MCP at <code>${MCP_HOST}</code>, and ` +
  `<a href="${SKILL_PATH}">Join the Colony</a> is what a person installs.</small></p>`

/**
 * The path to the index, filtered to one shelf or not filtered at all.
 *
 * **One function, so the link on an entry page and the link on the index cannot
 * disagree** (`kolonie-website#97`). It is the same shape the console's own
 * browser uses (`#591`, `atlasPickerPath`) rather than a second spelling of the
 * same idea on a second surface.
 */
/**
 * The origin the page is served on, taken from its own canonical (`#789`).
 *
 * **Derived rather than passed in.** The canonical is already required to be
 * absolute — *a public page with no canonical is a duplicate* — so the site is a
 * fact the page holds, and a second parameter carrying it would be a second
 * record of one thing, free to disagree with the link in the head.
 */
function siteOf(canonical: string): string {
  return new URL(canonical).origin
}

/**
 * Where a shelf is, or where the whole catalogue is when no shelf is named.
 *
 * **A shelf is a page now and not a filter** (`#1107`, decision 3). It was
 * `/atlas?category=mailbox`; it is `/atlas/c/mailbox`, the old address 301s to
 * the new one, and every link this function builds points at the page rather
 * than at the redirect. One function still, so the link on an entry page, the
 * link in the nav and the link in the shelf heading cannot disagree about which
 * of the two a shelf is.
 *
 * **`worked` is written only when it is `false`** (`#1103` decision 1). The
 * default view is the one with no parameter on it, so `?worked=true` would be a
 * second address for each of these — the duplicate the canonical then has to
 * argue with.
 */
export function atlasShelfPath(category?: AtlasCategorySlug, worked?: boolean): string {
  const base = category === undefined ? ATLAS_PATH : atlasCategoryPath(category)

  return worked === false ? `${base}?worked=false` : base
}

/**
 * Which half of the shelf a reader is on, and what is on each side.
 *
 * **Computed once and shared by both pages** (`#1107`). The index and a category
 * page are the same list under two different headings, and `#1103`'s default —
 * what worked, with what did not one link away — has to mean the same thing on
 * both or the link between them is a trapdoor.
 */
function workedSplit(
  entries: readonly AtlasPublicEntry[],
  worked: boolean | undefined,
): {
  readonly asked: boolean
  readonly fellBack: boolean
  readonly shown: readonly AtlasPublicEntry[]
  readonly other: number
} {
  const asked = worked ?? true
  const wanted = entries.filter((entry) => atlasEntryWorked(entry) === asked)
  const other = entries.filter((entry) => atlasEntryWorked(entry) !== asked)

  /**
   * **Decision 4 of `#1103`, and it is the maintainer's case verbatim**: a
   * default view with nothing in it shows what did not work instead, on the same
   * page and under a sentence saying so. A zero-result page that leaves the
   * reader to guess at a parameter is a page that failed, and *nobody got in
   * anywhere here* is a better answer than a blank shelf however few entries
   * carry it.
   *
   * The fallback runs on the default view only. A reader who asked for the
   * failures and found none has their answer already, and showing them the
   * successes would be the page overruling what they typed.
   */
  const fellBack = asked && wanted.length === 0 && other.length > 0

  return { asked, fellBack, shown: fellBack ? other : wanted, other: other.length }
}

/**
 * The index: every entry, on a shelf per category (`#588`, `#589`,
 * `kolonie-website#97`).
 *
 * **It no longer filters** (`#1107` decision 3). `?category=mailbox` was a view
 * of this page; a shelf is now a page of its own at `/atlas/c/mailbox` and the
 * old address 301s to it, so the branch that rendered one shelf here is
 * {@link atlasCategoryPage} rather than a parameter. What is left is the whole
 * catalogue, which is the one thing the index was always for.
 *
 * **Filtering is still a link and never a widget** — D-062, the same decision
 * the console's browser took in `#591`. `#97` requires it to work with no
 * JavaScript, and the cheapest way to satisfy that is for there to be no
 * JavaScript to fail.
 *
 * **What worked is the default and what did not is one link away** (`#1103`).
 * With thousands of entries a reader looking for a mailbox needs the providers
 * somebody got through first; and a provider agents *cannot* use is a finding
 * this catalogue exists to carry, so the two pull in opposite directions and the
 * resolution is a default rather than a deletion. Nothing is dropped: both views
 * are the same shelf split in two, every entry is in exactly one of them, and
 * every page, URL and sitemap row is untouched by which view a reader is on.
 */
export function atlasIndexPage(input: {
  readonly entries: readonly AtlasEntry[]
  readonly canonical: string
  readonly chrome?: SiteChrome | undefined
  /**
   * Which side of {@link atlasEntryWorked} to show. Absent is `true`, which is
   * `#1103` decision 1: the reader who asked for nothing asked for what worked.
   */
  readonly worked?: boolean | undefined
}): string {
  /**
   * **The projection, on the first line and not at the caller** (`#1100`).
   * Everything below this point takes {@link AtlasPublicEntry}, so there is no
   * shape of this function in which a step reaches the index.
   */
  const entries = atlasPublicEntries(input.entries)
  const { asked, fellBack, shown, other } = workedSplit(entries, input.worked)

  return atlasPage({
    title: 'The Atlas',
    description: ATLAS_STANDFIRST,
    canonical: input.canonical,
    chrome: input.chrome,
    /**
     * **The list it rendered, in the order it rendered it** (`#789`). `shown`
     * and not `entries`: the two views are different lists, and an `ItemList`
     * naming entries the page does not show would be the markup contradicting
     * the page it is attached to.
     */
    jsonLd: [itemListFor(shown, siteOf(input.canonical))],
    body: [
      '<main>',
      '<h1>The Atlas</h1>',
      `<p>${escape(ATLAS_STANDFIRST)}</p>`,
      ATLAS_JOIN_LINE,
      `<p><small>${escape(ATLAS_ORDER_NOTE)}</small></p>`,
      shelfNav(entries, asked),
      entries.length === 0
        ? '<p>The catalogue is empty. Nothing has been listed yet, which is not the same as ' +
          'nothing being joinable.</p>'
        : [
            workedNote({ asked, fellBack, category: undefined, shown: shown.length, other }),
            shelves(shown).join('\n'),
          ]
            .filter((one) => one !== '')
            .join('\n'),
      '</main>',
    ].join('\n'),
  })
}

/**
 * One shelf, as a page of its own (`#1107`).
 *
 * **Both levels of the taxonomy render through here** (decision 1). A top
 * category and a sub category are the same kind of thing to a reader — a shelf
 * with a name, a standfirst and a list under it — and the only difference is what
 * the list is grouped by: a top page groups its entries into its sub categories,
 * a sub page has one group and prints it flat rather than repeating its own `h1`
 * as an `h2`.
 *
 * **The heading is the question `#1105` asks one level down** (decision 4). A
 * reader typing *which mailboxes can an AI agent sign up for* is asking about the
 * shelf, and the page they land on should be their own sentence back;
 * {@link atlasShelfQuestion} joins the category row's own title rather than
 * rewriting it.
 *
 * **No `FAQPage`** (decision 8). That markup is a promise that every question in
 * it has its answer visible on the page, which is true of a provider page's
 * criteria box and is not true of a shelf — the shelf's questions are answered on
 * the fifteen pages it links to.
 */
export function atlasCategoryPage(input: {
  readonly entries: readonly AtlasEntry[]
  /** The shelf itself, as the table holds it: slug, title and standfirst. */
  readonly category: AtlasCategoryRow
  /**
   * The shelves beside this one in the navigation: the children of a top
   * category, the siblings of a sub category. Empty is a shelf with neither.
   */
  readonly nav: readonly AtlasCategoryRow[]
  /** The category above this one, where there is one — the link back up. */
  readonly parent?: AtlasCategoryRow | undefined
  /**
   * The slugs whose entries belong on this page: the one slug of a sub category,
   * every child of a top one. Passed rather than derived, because *which shelves
   * hang under this one* is the table's answer and not the renderer's.
   */
  readonly covers: readonly string[]
  readonly canonical: string
  readonly chrome?: SiteChrome | undefined
  readonly worked?: boolean | undefined
}): string {
  const { category, covers } = input
  const all = atlasPublicEntries(input.entries)
  /**
   * **The primary shelf, which is the one the index groups by too.** `#1102`
   * gives an entry several shelves, and the public projection carries only the
   * one it is filed under — so an entry appears once, on the same shelf, on
   * every surface. A page that read the join would disagree with the index
   * about where a provider lives, which is the one thing a map may not do.
   */
  const mine = all.filter((entry) => covers.includes(entry.category))
  const { asked, fellBack, shown, other } = workedSplit(mine, input.worked)
  const question = atlasShelfQuestion(category.title)
  /**
   * A top page groups; a sub page does not. `shelves` writes the shelf title
   * over each group, which on a page whose `h1` *is* that shelf would be the
   * same words twice with nothing between them.
   */
  const grouped = covers.length > 1

  return atlasPage({
    /**
     * **Titled for the search that finds it** (`#788`). `The Atlas — mailbox`
     * names our own filter and our own slug, neither of which anybody types into
     * a search box; what the shelf holds, plus what a reader wants to do with
     * it, names the thing they were looking for.
     */
    title: `${category.title} an AI agent can sign up for`,
    description: category.standfirst,
    canonical: input.canonical,
    chrome: input.chrome,
    /** Decision 5: what was rendered, and never the whole shelf. */
    jsonLd: [itemListFor(shown, siteOf(input.canonical), category.slug)],
    body: [
      '<main>',
      `<h1>${escape(question)}</h1>`,
      `<p>${escape(category.standfirst)}</p>`,
      ATLAS_JOIN_LINE,
      `<p><small>${escape(ATLAS_ORDER_NOTE)}</small></p>`,
      categoryNav({ rows: input.nav, entries: all, current: category.slug, worked: asked }),
      `<p class="k-atlas-facts"><a href="${escape(
        atlasShelfPath(undefined, asked),
      )}">Every category</a>${
        input.parent === undefined
          ? ''
          : ` · <a href="${escape(atlasShelfPath(input.parent.slug))}">${escape(
              input.parent.title,
            )}</a>`
      }</p>`,
      mine.length === 0
        ? `<p>Nothing is filed under ${escape(category.title.toLowerCase())} yet. That is a shelf ` +
          'waiting to be filled rather than a category the Colony refuses — every entry on it ' +
          'would be one somebody walked.</p>'
        : [
            workedNote({
              asked,
              fellBack,
              category: category.slug,
              shown: shown.length,
              other,
            }),
            grouped
              ? shelves(shown).join('\n')
              : `<ul class="k-atlas-index">${shown.map(indexRow).join('')}</ul>`,
          ]
            .filter((one) => one !== '')
            .join('\n'),
      '</main>',
    ].join('\n'),
  })
}

/**
 * The shelves beside this one, from the table rather than from the entries
 * (`#1107`).
 *
 * **This is where it differs from {@link shelfNav}, and the difference is the
 * point.** The index derives its shelves from what has been filed, because
 * fifteen headings over three entries would say the Atlas has twelve holes in
 * it. A category page is standing *on* one of those shelves: its siblings are
 * where a reader goes next whether or not anything has been filed under them
 * yet, and a nav that hid the empty ones would hide exactly the shelves that most
 * need somebody to walk them. So the rows come from the table and a count of
 * zero is printed as zero.
 */
function categoryNav(input: {
  readonly rows: readonly AtlasCategoryRow[]
  readonly entries: readonly AtlasPublicEntry[]
  readonly current: string
  readonly worked: boolean
}): string {
  if (input.rows.length === 0) return ''

  const counts = new Map<string, number>()
  for (const entry of input.entries)
    counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1)

  const links = input.rows.map(
    (row) =>
      `<li><a href="${escape(atlasShelfPath(row.slug, input.worked))}"` +
      `${row.slug === input.current ? ' aria-current="page"' : ''}>` +
      `${escape(row.title)}</a> ` +
      `<span class="k-atlas-count">${counts.get(row.slug) ?? 0}</span></li>`,
  )

  return (
    '<nav class="k-atlas-shelves" aria-label="Categories">' +
    `<ul>${links.join('')}</ul>` +
    '</nav>'
  )
}

/**
 * The line that says which half of the shelf this is, and links to the other
 * (`#1103`).
 *
 * **A default nobody can see is indistinguishable from a catalogue that is
 * missing things.** The whole arrangement rests on the reader being told that
 * they are looking at a filtered view and being one link from the rest, so the
 * note is rendered wherever there is another side to reach and the link is a
 * plain `<a href>` — `#97`'s no-JavaScript rule, and D-062's *filtering is a
 * link and never a widget*, applied to the second filter as they were to the
 * first.
 *
 * **The failures are described as kept rather than as rejects.** An entry
 * nobody got through is a finding: it cost a citizen a walk, its page says what
 * stopped them, and the reader deciding between four SMS providers wants the
 * one that is closed to be visibly closed rather than absent.
 */
function workedNote(input: {
  readonly asked: boolean
  readonly fellBack: boolean
  readonly category: AtlasCategorySlug | undefined
  readonly shown: number
  readonly other: number
}): string {
  const { asked, fellBack, category, other } = input
  const line = (text: string): string => `<p class="k-atlas-worked">${text}</p>`
  const link = (worked: boolean, text: string): string =>
    `<a href="${escape(atlasShelfPath(category, worked))}">${text}</a>`

  if (fellBack) {
    return line(
      'Nobody has got through here yet, so what follows is what did not work rather than ' +
        'nothing at all. Each page says how far the walk got and what stopped it.',
    )
  }

  if (!asked) {
    /** Asked for the failures and there are none: say so and offer the way back. */
    if (input.shown === 0) {
      return line(
        `Every entry here is one somebody got through. ${link(true, 'Back to what worked')}.`,
      )
    }

    return line(
      'These are the entries nobody has got through. They are kept rather than deleted, ' +
        `because a provider agents cannot use is worth knowing about. ${link(
          true,
          'Back to what worked',
        )}.`,
    )
  }

  if (other === 0) return ''

  return line(
    `Showing what worked. ${link(
      false,
      `Show the ${other} ${other === 1 ? 'entry' : 'entries'} nobody got through`,
    )}.`,
  )
}

/**
 * The shelves, as links, with what is on each (`kolonie-website#97`).
 *
 * **The count is derived and never typed** — `#97` is explicit that *ninety-six
 * providers* ages on the next curation, and the same is true one shelf down.
 *
 * **It is built from the entries and not from the vocabulary.** Fourteen
 * headings over three entries would say the Atlas has eleven holes in it, when
 * what it has is eleven categories nothing has been filed under yet. That is
 * `shelves`' argument below, one level up.
 *
 * **The counts are the whole catalogue's and not the current view's** (`#1103`).
 * Counting only what worked would take a shelf where nothing has worked yet out
 * of the navigation entirely — a shelf a reader cannot reach from the page that
 * hid it, which is exactly the deletion the default was chosen instead of. The
 * links carry the view so that flipping to what did not work stays flipped as
 * the reader moves between shelves.
 *
 * **Nothing here is marked current any more** (`#1107`): the index is the only
 * page that renders this nav, and it is not on any of the shelves it links to.
 * A page standing on one takes {@link categoryNav} instead.
 */
function shelfNav(entries: readonly AtlasPublicEntry[], worked: boolean): string {
  if (entries.length === 0) return ''

  const counts = new Map<string, number>()
  for (const entry of entries) counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1)

  const links = [...counts.entries()].map(
    ([category, count]) =>
      `<li><a href="${escape(atlasShelfPath(category, worked))}">` +
      `${escape(atlasShelfTitle(category))}</a> ` +
      `<span class="k-atlas-count">${count}</span></li>`,
  )

  return (
    '<nav class="k-atlas-shelves" aria-label="Categories">' +
    `<ul>${links.join('')}</ul>` +
    '</nav>'
  )
}

/**
 * The index, grouped into shelves (`#589`).
 *
 * **The categories come from the entries and not from the vocabulary**, so an
 * empty shelf is not rendered: fourteen headings over three entries would say
 * the Atlas has eleven holes in it, when what it has is eleven categories
 * nothing has been filed under yet. A reader learns the shelves exist by seeing
 * them fill.
 *
 * **The order inside each shelf is `atlasByOutcome`'s and is not re-sorted
 * here.** That ordering is the product — measured outcome, never payment — and a
 * second sort at the rendering layer would be a second answer to it.
 */
function shelves(entries: readonly AtlasPublicEntry[]): readonly string[] {
  const byCategory = new Map<string, AtlasPublicEntry[]>()

  for (const entry of entries) {
    const held = byCategory.get(entry.category)
    if (held === undefined) byCategory.set(entry.category, [entry])
    else held.push(entry)
  }

  return [...byCategory.entries()].map(
    ([category, shelf]) =>
      /**
       * **The slug stays where it is an address** (`#791`): the fragment `id`
       * a link elsewhere targets, and the `/atlas/c/` path the link itself
       * carries. Only what a reader sees is the shelf title.
       */
      `<h2 id="${escape(category)}"><a href="${escape(
        atlasShelfPath(category),
      )}">${escape(atlasShelfTitle(category))}</a> ` +
      /**
       * The count, derived from the shelf it is standing on
       * (`kolonie-website#97`). A number typed into prose ages on the next
       * curation; this one cannot.
       */
      `<span class="k-atlas-count">${shelf.length}</span></h2>` +
      `<ul class="k-atlas-index">${shelf.map(indexRow).join('')}</ul>`,
  )
}

function indexRow(entry: AtlasPublicEntry): string {
  return (
    `<li><a href="${escape(entry.path)}">${escape(entry.title)}</a>` +
    indexStatusMark(entry.status) +
    (entry.recipes.some((recipe) => recipe.paid) ? ' <span class="k-paid">paid</span>' : '') +
    /**
     * **What the provider is, above how it behaved** (`#1121` decision 6). The
     * line below this one is the entry's shape — kinds, figures, who is needed
     * — and a reader scanning a shelf of forty is asking *which of these is the
     * thing I want* first.
     *
     * **The whole sentence, clamped in CSS and never cut in the markup.** A
     * crawler reads the document and a reader reads one line of it; truncating
     * here would take the sentence away from both. `k-atlas-said` is where the
     * clamping lives, in `ATLAS_STYLE`.
     *
     * A provider with no description gets no element at all — decision 6 again,
     * and the rejection case the tests assert: absent, not empty.
     */
    (entry.description === null
      ? ''
      : `<br><small class="k-atlas-said">${escape(entry.description)}</small>`) +
    `<br><small>${escape(kindsShown(entry))}${escape(indexFigure(entry))} — ` +
    `${escape(operatorLine(entry, atlasIsWalked(entry)))}</small></li>`
  )
}

/**
 * Who has to be there, on the row rather than inside the page (`#589`).
 *
 * **The one fact that decides whether a reader has to volunteer an afternoon**,
 * and until now it was only discoverable by opening an entry and reading its
 * steps. A guess says it is a guess: an operator told *not needed* about a
 * provider nobody has walked will find out otherwise at the worst moment.
 *
 * **`unknown` is two different unknowns and it used to print only one of them**
 * (`#1141`). *Nobody walked this* and *walkers went and did not settle it* are
 * not the same fact, and the second is what 64 of the 166 rows on the deployed
 * index actually were: a walked status mark and *nobody has walked this* on the
 * same line. Four strings for three needs, therefore — a fourth `operatorNeed`
 * would have put the distinction in the data, where `atlasEntryOperatorNeed`
 * rolls rows up and has nothing to roll a walk into.
 *
 * **The walk arrives as an argument rather than being read off the entry**,
 * because this is called with two shapes: an entry, whose walk is
 * {@link atlasIsWalked} over its recipes, and a single recipe, whose walk is its
 * own status. The parameter type is a structural subset on purpose and widening
 * it to `AtlasPublicEntry` would cost the recipe callers.
 */
function operatorLine(
  entry: {
    readonly operatorNeed: AtlasPublicEntry['operatorNeed']
    readonly operatorNeedIsGuess: boolean
  },
  walked: boolean,
): string {
  const said =
    entry.operatorNeed === 'unknown'
      ? walked
        ? 'walked, but who is needed is not known'
        : 'nobody has walked this, so who is needed is not known'
      : { unaided: 'an agent can do this alone', 'operator-needed': 'needs a person at one step' }[
          entry.operatorNeed
        ]

  return entry.operatorNeedIsGuess ? `${said} (a guess, not a walk)` : said
}

/**
 * The criteria box, at the top of every provider page (`#1105` decision 1).
 *
 * **Five seconds of scanning, above the prose**, because the decision a reader
 * arrives with is *is this worth an afternoon* and every one of these nine facts
 * can end it. Until here they were spread across a facts line, a *before you
 * start* paragraph inside each recipe section, and a findings list under it —
 * every one of them true, none of them scannable, and three of them below a fold.
 *
 * **A `<dl>` and not a table.** The pages carry `style-src 'unsafe-inline'` and
 * no stylesheet a reader can rely on, and a definition list degrades to a
 * readable question-then-answer sequence with no CSS at all, which a table does
 * not. It is also the honest markup: these are terms and their definitions.
 *
 * The rows themselves are `criteria.ts`'s — this function chooses no wording and
 * substitutes nothing, so that the `FAQPage` in the head cannot say anything the
 * box does not.
 */
function criteriaBox(criteria: readonly AtlasCriterion[]): string {
  const rows = criteria
    .map((one) => `<dt>${escape(one.question)}</dt><dd>${escape(one.answer)}</dd>`)
    .join('')

  return `<dl class="k-atlas-criteria">${rows}</dl>`
}

/**
 * One line under the box saying what citizenship buys (`#1105` decision 6).
 *
 * **It names the three things and does not gesture at them.** *More detail for
 * citizens* is the sentence every catalogue writes and nobody believes; the
 * ordered steps, the remedy that got past each wall, and the walks behind both
 * are what the projection actually withholds (`#1100`), so saying exactly that is
 * both the honest line and the persuasive one.
 *
 * **{@link ATLAS_JOIN_LINE} is not rewritten and stays where it is**, which
 * decision 6 asks for directly: it is the invitation, further down and phrased
 * for somebody who has read the page. This is the label on what is missing.
 *
 * **It renders only where something is actually being withheld.** An entry with
 * no steps and no walls has nothing behind the line, and a page that advertised a
 * path it does not have would be the catalogue selling — the same rule
 * {@link membershipSection} takes when it says nothing on a refusal.
 *
 * **The prerequisites are not part of that test**, though they are counted a few
 * lines above: {@link conditionsSection} already prints them in full — *before
 * the first step you need: email* — so an entry whose only content is its needs is
 * withholding nothing, and a line offering the rest of it would be offering a
 * path that does not exist.
 */
function citizenLine(entry: AtlasPublicEntry): string {
  const behindIt = entry.recipes.some((recipe) => recipe.stepCount > 0 || recipe.walls.length > 0)

  if (!behindIt) return ''

  return (
    '<p class="k-atlas-citizen">A citizen asking kolonie.accounts.recipes gets the rest: the ' +
    'ordered steps of the path with the operator’s marked, the remedy that got past each wall, ' +
    'and the walks both were written from.</p>'
  )
}

/** One provider's page. */
export function atlasEntryPage(input: {
  readonly entry: AtlasEntry
  readonly canonical: string
  readonly chrome?: SiteChrome | undefined
  /**
   * Quests naming this entry, so the page can say who paid for the figures
   * (`#602`).
   *
   * Optional at every layer, like the walk store one file over: a deployment
   * that has no quests renders the page it rendered before this existed.
   */
  readonly quests?: readonly SponsoringQuest[] | undefined
  /**
   * What the Colony wrote up about each kind here, by `figureKey` (`#831`).
   *
   * **Read on this page and not in `listEntries`**, exactly as the quests above
   * are and for the same reason: the index shows no briefing, and a read that
   * walked four hundred providers to render none of them is a cost paid on the
   * page that does not spend it.
   *
   * Optional at every layer, so a deployment whose synthesis has never run
   * renders the page it rendered before this existed.
   */
  readonly briefings?: ReadonlyMap<string, ProviderBriefing> | undefined
}): string {
  /**
   * **The projection, on the first line and not at the caller** (`#1100`).
   * Every helper below takes {@link AtlasPublicEntry}, so a step cannot reach
   * this page by anybody forgetting anything: there is nowhere left to forget
   * it.
   */
  const entry = atlasPublicEntry(input.entry)
  const briefings = input.briefings ?? new Map<string, ProviderBriefing>()

  const site = siteOf(input.canonical)

  /**
   * The nine facts, built once and rendered twice (`#1105` decision 4) — into the
   * box below and into the `FAQPage` above it. `criteria.ts` explains why that is
   * one array rather than two builders.
   */
  const criteria = atlasCriteria(entry)

  return atlasPage({
    /**
     * **The `<title>` is written for the query and the `<h1>` is not** (`#788`).
     * They are different sentences to different readers: the heading is the
     * curator's line, read by somebody who has already arrived, and the title
     * is what a search result shows to somebody who has not — where *A Trello
     * account, with no rung behind it* spends its width on a Colony-internal
     * distinction the reader has never heard of.
     */
    title: entryTitle(entry),
    description: metaDescription(entry),
    canonical: input.canonical,
    chrome: input.chrome,
    /**
     * **A page nobody has walked stays on the site and leaves the index**
     * (`#790`). It is one heading, one status line and a sentence asking
     * somebody to walk it; submitted by name alongside ninety-two others, it is
     * what a crawler decides the directory is, and it drags the walked pages
     * with it.
     *
     * **`follow` and not `nofollow`.** The links out of it — to its shelf, to
     * the index — are worth crawling; the page itself is not worth indexing
     * until somebody has something to put on it.
     *
     * **Every row, and not one of several.** A provider that is joinable for a
     * mailbox and unmapped for a domain has something to say, and asking for it
     * to be dropped would drop the half that was walked.
     */
    robots: atlasIsWalked(entry) ? undefined : 'noindex, follow',
    /**
     * **The breadcrumb, a `FAQPage`, and no `HowTo`** (`#789`, narrowed by
     * `#1100`, extended by `#1105`).
     *
     * A `HowTo` is a list of step names and step text, and `#1100` decided the
     * steps are what citizenship buys — so the block that made this page
     * eligible for a how-to rich result was the recipe, published in JSON,
     * beside a page that no longer prints it. **That eligibility is a real
     * loss** and it is the price of the rule rather than an oversight: what the
     * page offers a searcher instead is the criteria and the findings extract,
     * which is what `#1100` decided the public half is — and `#1105` writes that
     * half down in the one vocabulary a search engine has for it.
     *
     * **The `FAQPage` is emitted on exactly the pages that are indexed at all**
     * (`#1105` decision 7). A placeholder has an honest criteria box saying
     * *not known* nine times over, which is a true page and not an answer: asking
     * a crawler to treat nine unknowns as a rich result, on a page the same
     * function has just asked it not to index, would be the Colony arguing with
     * itself in two blocks of the same head. One predicate decides both.
     */
    jsonLd: [breadcrumbFor(entry, site), ...(atlasIsWalked(entry) ? [faqPageFor(criteria)] : [])],
    /**
     * **The order is `kolonie-website#97`'s list of what a reader must be able
     * to answer without scrolling**, in that order, and it is the order rather
     * than any of the individual sections that the issue is about:
     *
     * 1. what this is and what an agent would get — the title, the category and
     *    `about`
     * 2. can it do this alone — the single most useful fact on the page
     * 3. the recipe, as ordered steps with the operator's marked
     * 4. what was measured, with its sample size
     * 5. when it was last confirmed, and by what
     * 6. if it is refused, the reason, prominently
     * 7. if nobody has walked it, what that means and how to change it
     *
     * Six and seven are inside `recipeSection` because they are properties of a
     * row rather than of a provider: one provider can be joinable for a mailbox
     * and refused for a domain, and a page that hoisted either to the top would
     * be saying something untrue about the other.
     *
     * **`about` moved above the category line and the paid marker.** A reader
     * arriving from a search result needs *what is this* before *what shelf is
     * it on*, and the marker is a fact about the entry rather than about the
     * provider — `#543` requires it visible, not first.
     */
    body: [
      '<main>',
      /**
       * **The heading is the question somebody typed** (`#1105` decision 3).
       *
       * This supersedes `#788` for the `h1` and leaves the `<title>` exactly as
       * `#788` wrote it: the title is still the search line a result list shows,
       * and the heading is now what a reader who followed it sees first. The
       * provider's own name was the heading until here, and it is a heading that
       * answers nothing — a reader who clicked a result already knows which
       * provider they clicked.
       */
      `<h1>${escape(atlasEntryQuestion(entry))}</h1>`,
      descriptionSection(entry),
      criteriaBox(criteria),
      citizenLine(entry),
      aboutSection(entry),
      /**
       * **The description is in the head and no longer in the body** (`#788`).
       * It is now a list of the facts a snippet can carry, and every one of
       * them is already on the page within a screen of here — the operator
       * answer on the facts line below, the steps and the proof in the section
       * under it, the date in {@link confirmedLine}. Printed here as well it
       * would be the page saying the same four things twice before a reader
       * reaches the recipe.
       */
      /**
       * The two facts `#589` adds. A reader arrives asking *what sort of thing
       * is this* and *will I be needed*, and both used to be answerable only by
       * reading five steps.
       *
       * **The category links to its own shelf** rather than to the whole index
       * (`kolonie-website#97`): entry to category and category to entry is the
       * shortest of the internal links that make a map out of a list, and it
       * was one-way.
       */
      `<p class="k-atlas-facts"><a href="${escape(atlasShelfPath(entry.category))}">${escape(
        entry.category,
      )}</a> — ${escape(operatorLine(entry, atlasIsWalked(entry)))}</p>`,
      paidMarker(entry),
      ...entry.recipes.map((recipe) =>
        recipeSection(recipe, briefings.get(figureKey(recipe.kind, recipe.provider))),
      ),
      sponsorSection(input.quests ?? []),
      confirmedLine(entry),
      runtimesSection(entry),
      counterpartySection(entry),
      membershipSection(entry),
      NOT_A_PROMISE,
      '</main>',
    ].join('\n'),
  })
}

/**
 * The provider's name, as a page written for a stranger says it.
 *
 * **The domain, verbatim, and there is no display-name column** (`#788`). It is
 * what a searcher types, it is what `atlasPath` already uses, and it cannot be
 * wrong — where a title-cased first label would give *Github* and *Mail.tm*,
 * and a hand-curated name would be a second copy of the provider free to
 * disagree with it. `recipeHeading` took the same decision in `#791`.
 */
function providerName(entry: AtlasPublicEntry): string {
  return entry.provider
}

/** A phrase that carries its own article, used mid-sentence. */
function lowerFirst(phrase: string): string {
  return phrase.charAt(0).toLowerCase() + phrase.slice(1)
}

/**
 * The line a search result shows above everything else (`#788`).
 *
 * **Written for the query rather than for the catalogue**, and still derived:
 * a title field on the row would be a fourth piece of prose per entry for a
 * curator to keep true. What it says is what somebody searching *how does an
 * AI agent get a Trello account* is asking — the provider, that this is about
 * an agent, and what they will actually have to do — and the ` — Kolonie`
 * suffix {@link atlasPage} appends is what places it.
 *
 * Naming the provider descriptively is ordinary nominative use: the page is
 * about them, claims no endorsement, and {@link NOT_A_PROMISE} says so on the
 * page itself.
 */
function entryTitle(entry: AtlasPublicEntry): string {
  const name = providerName(entry)

  if (entry.status === 'refused') return `${name}: why an agent cannot join it`
  if (entry.status === 'retired') return `${name}: withdrawn, and what the path was`
  /**
   * **`measured` is the one status the fallback below is false for** (`#1141`).
   * Since `#1032` it means *a walk closed here and nobody wrote the route*, so
   * `nobody has mapped this yet` was the page telling a searcher to go away
   * from 35 entries built out of somebody's afternoon. `unwritten` keeps that
   * title, because for `unwritten` it is what happened.
   */
  if (entry.status === 'measured') return `${name}: walked, but no recipe written yet`
  if (entry.status !== 'joinable') return `${name}: nobody has mapped this yet`

  /**
   * The capability clause only where a row reaches one (`#637`): an account is
   * usually a means, and *and an API key* is the half of the answer a reader
   * came for. Where nothing is reached the sentence ends a word earlier rather
   * than promising something the page does not have.
   */
  const reaches = entry.recipes.find((recipe) => recipe.reaches !== null)?.reaches ?? null
  const reached =
    reaches === null ? '' : `, ${lowerFirst(atlasCapabilityPhrase(reaches.capability))}`

  return `${name} for an AI agent: sign up, prove it${reached}`
}

/**
 * How a proof method reads in a sentence somebody who is not a citizen sees.
 *
 * The slugs are the Colony's own vocabulary — `provider-post` means nothing in
 * a search snippet — and an unlisted method falls through to itself rather
 * than to silence, on the same argument as the phrase maps in `atlas.ts`.
 */
const PROOF_PHRASES: Readonly<Record<string, string>> = {
  'provider-mail': 'proved by forwarding what the provider sends',
  'provider-post': 'proved by publishing a string the account can show',
  rung: 'proved by an Academy rung',
}

/**
 * The sentence a search result shows under the title, derived rather than
 * written (`#788`).
 *
 * **It used to be `How an agent joins trello.com: trello.`** — `kindsLine` joins
 * the kind slugs, and on every entry whose kind repeats its provider name,
 * which is most of them, the snippet degenerated into the provider said twice.
 *
 * What replaces it is the facts a snippet can carry and a reader is deciding
 * on: how much work this is, whether they will have to be there, what proves
 * it afterwards, and how recently anybody checked. Each clause is dropped
 * rather than fudged where the value is not on the row — an entry with no
 * confirmed walk says nothing about dates instead of printing today's.
 */
function entryDescription(entry: AtlasPublicEntry): string {
  const name = providerName(entry)

  if (entry.status === 'refused') {
    return (
      `${name} cannot currently be joined honestly by an agent. What was tried, where it ` +
      'stopped, and why the Atlas lists the refusal rather than leaving the provider out.'
    )
  }

  if (entry.status === 'retired') {
    return (
      `${name} was joinable and is not any more. What the path was, when it closed and the ` +
      'reason given, kept as a page rather than deleted.'
    )
  }

  if (entry.status !== 'joinable') {
    return (
      `Nobody has walked ${name} yet. It is in the Atlas because it exists, and this page says ` +
      'that rather than pretending either way.'
    )
  }

  const joinable = entry.recipes.filter((recipe) => recipe.status === 'joinable')
  const steps = joinable.reduce((sum, one) => sum + one.stepCount, 0)
  const byHand = joinable.reduce((sum, one) => sum + one.operatorStepCount, 0)
  const proves = [...new Set(joinable.map((one) => one.proves).filter((one) => one !== null))]
  const walked = lastConfirmed(entry)

  const clauses = [
    steps === 0 ? '' : `${steps} step${steps === 1 ? '' : 's'}`,
    /**
     * The count where there are operator steps to count, and the entry's own
     * rolled-up answer where there are none — which is not the same as *nobody
     * is needed*, because a row nobody has walked cannot say that.
     */
    /**
     * `#1141` decision 5 keeps the description's *wording* out of this issue,
     * and this is not that: the branch above has already returned for anything
     * that is not `joinable`, a `joinable` entry has a `joinable` recipe, and
     * {@link atlasIsWalked} is therefore true at every call that reaches here.
     * What it removes is the one case where the clause could still have said
     * *nobody has walked this* on a page built out of a walk.
     */
    byHand === 0
      ? operatorLine(entry, atlasIsWalked(entry))
      : `${byHand} of them need${byHand === 1 ? 's' : ''} a human`,
    proves.length === 0 ? '' : proves.map((one) => PROOF_PHRASES[one] ?? `proved with ${one}`)[0],
  ].filter((clause) => clause !== '')

  return (
    `${clauses.join(', ')}.` +
    (walked === undefined ? '' : ` Last confirmed ${walked.slice(0, 10)}.`)
  )
}

/**
 * How much of the head the description and the status sentence share (`#1121`).
 *
 * **One number, exported, and read by the join below and by its test.** A budget
 * written twice is a budget that disagrees with itself; a budget written only
 * inside the function is one a test can only assert by counting characters of
 * its own.
 *
 * Twice what a result list shows, so the sentence a search engine displays is
 * never the one being squeezed — what the extra width buys is the status clause
 * behind it, for a reader whose engine shows more.
 */
export const ATLAS_META_DESCRIPTION_MAX_LENGTH = 320

/**
 * What the provider is, then how it behaved (`#1121` decisions 1 to 3).
 *
 * **`entryDescription()` is kept whole and put second.** It is a list of facts a
 * snippet can carry — steps, who is needed, what it proves, when it was last
 * confirmed — and every one of them is about behaviour. None of them says what
 * the provider *is*, which is the sentence a stranger reads a search result for.
 *
 * **Whole sentences or nothing.** The tail is added a sentence at a time while
 * the budget holds, so the join can never end mid-word; a description that
 * alone fills the budget is used alone, with the status sentence dropped rather
 * than clipped. And a provider with no description falls through to today's
 * output byte for byte, so a page whose corpus produced nothing is the page it
 * is today rather than one with a gap where a sentence should be.
 */
function metaDescription(entry: AtlasPublicEntry): string {
  const behaved = entryDescription(entry)
  if (entry.description === null) return behaved

  const room = ATLAS_META_DESCRIPTION_MAX_LENGTH - entry.description.length
  const kept: string[] = []
  let used = 0

  /**
   * Split after a full stop that a space or the end follows, so `mail.tm` in the
   * middle of a clause is not a sentence boundary. The lookbehind keeps the stop
   * on the sentence it ends.
   */
  for (const sentence of behaved.split(/(?<=\.)\s+/)) {
    // The space this sentence is joined with is part of what it costs.
    if (used + sentence.length + 1 > room) break
    kept.push(sentence)
    used += sentence.length + 1
  }

  return kept.length === 0 ? entry.description : `${entry.description} ${kept.join(' ')}`
}

/**
 * The sentence, on the page itself and directly under the heading (`#1121`
 * decision 4).
 *
 * **Outside `recipeSection()` on purpose.** That function returns early for
 * `refused`, `retired` and `unwritten` rows, and those are the pages with the
 * least on them and the most need of a line saying what the provider is. Here it
 * is rendered for every status, from one place, above everything a row can say.
 */
function descriptionSection(entry: AtlasPublicEntry): string {
  return entry.description === null
    ? ''
    : `<p class="k-atlas-description">${escape(entry.description)}</p>`
}

/** The most recent walk across an entry's rows, which is what a reader wants dated. */
function lastConfirmed(entry: AtlasPublicEntry): string | undefined {
  return entry.recipes
    .map((recipe) => recipe.lastConfirmedAt)
    .filter((at): at is string => at !== null)
    .sort()
    .at(-1)
}

/**
 * The one word the index has room for about an entry's state (`#588`, `#604`).
 *
 * **Every state but `joinable` is marked, in words.** A joinable entry is
 * unmarked because it is the ordinary case and the figures beside it already say
 * how it went; an unmarked entry in any other state is indistinguishable from a
 * working recipe — which is the catalogue pretending, and the thing
 * `growth/README.md` refuses.
 *
 * **Every state reaches this function since `#1032`.** Two of them used not to:
 * `draft` and `proposed` were private, and the branch that marked them was kept
 * against the day they leaked. Both are gone, and `measured` took their place on
 * the index as a state a stranger does see — so it is marked here, and marked as
 * what it is rather than as a pending one. Nobody is working on a `measured`
 * entry: it has been walked, what the walkers found is on its page, and what it
 * has not got is a route the Colony stands behind.
 *
 * The rule the two retired branches existed for still holds: a state with no
 * branch here renders as a working recipe, which is the catalogue pretending.
 */
function indexStatusMark(status: AtlasPublicEntry['status']): string {
  if (status === 'refused') return ' <span class="k-refused">cannot be joined</span>'
  if (status === 'retired') return ' <span class="k-refused">withdrawn</span>'
  if (status === 'unwritten') return ' <span class="k-unwritten">nobody has looked yet</span>'
  if (status === 'measured') {
    return ' <span class="k-unwritten">walked, with no route written</span>'
  }

  return ''
}

/**
 * What a provider offers, on its index row, in words (`#791`).
 *
 * **There was a second one of these that joined the kind slugs**, and it fed
 * the `<meta name="description">` until `#788` — which is how *How an agent
 * joins trello.com: trello.* got into search results. Nothing joins slugs now.
 *
 * **The article is lowered, and only its first letter.** Each phrase carries
 * its own article so a heading is correct on its own; mid-row they are a list,
 * and *A mailbox, A domain* is the capitalisation of a title rather than of a
 * sentence. Touching only the first character leaves *an API account* alone.
 */
function kindsShown(entry: AtlasPublicEntry): string {
  return entry.recipes.map((recipe) => lowerFirst(atlasKindPhrase(recipe.kind))).join(', ')
}

/**
 * What a row is called where a reader sees it (`#791`).
 *
 * **Where the kind is the provider, the heading says so.** A row keyed
 * `trello` at `trello.com` headed *A Trello account* repeats the title above
 * it; *An account at trello.com* is the sentence a reader arriving mid-page
 * needs. Everywhere else the kind's own phrase is the answer, and an unknown
 * kind falls through to its slug rather than to nothing.
 */
function recipeHeading(recipe: AtlasPublicEntry['recipes'][number]): string {
  const label = recipe.provider.split('.')[0]

  return recipe.kind === label ? `An account at ${recipe.provider}` : atlasKindPhrase(recipe.kind)
}

/** One row of the catalogue, as a section of its provider's page. */
function recipeSection(
  recipe: AtlasPublicEntry['recipes'][number],
  /**
   * What the Colony wrote up about this row's walks, if it has (`#831`).
   *
   * **Rendered exactly where the figures are and nowhere else**, which is the
   * rule and not the list of states it currently covers. A briefing appearing on
   * a row whose counts do not would be the page contradicting its own layout, so
   * the two travel together everywhere.
   *
   * **The rule covers two states rather than three since `#1094`.** It was
   * written when a refusal was a sentence somebody wrote and nothing had been
   * measured behind it; `#1032` made `refused` one of five walkable statuses, and
   * under it a refusal is *what the walkers found*. Eight of the fourteen
   * briefings the Colony had written sat on refused entries — `telephony/
   * telnyx.com` on ten claims — and the page printed *nobody has walked this*
   * over the top of them. `unwritten` and `retired` keep their early returns:
   * there is genuinely nothing measured about a provider nobody attempted, and a
   * withdrawn row is not on offer to anybody.
   */
  briefing: ProviderBriefing | undefined,
): string {
  /**
   * **A refusal carries its findings** (`#1094`), in the order a reader has to
   * meet them: the refusal first, then what was measured, then the write-up.
   * Reversed, the findings read as an invitation to a road the Colony has
   * already said is closed.
   */
  if (recipe.status === 'refused') {
    return [
      `<section><h2>${escape(recipeHeading(recipe))}</h2>`,
      '<p class="k-refused">This cannot be joined honestly, so do not try.</p>',
      `<p>${escape(recipe.refusal ?? '')}</p>`,
      wallsSection(recipe),
      figuresSection(recipe.figures, recipe.stepCount),
      briefingSection(briefing),
      '</section>',
    ].join('')
  }

  /**
   * **An unwritten row says so and stops** (`#588`). No steps, no proof line, no
   * figures — there is nothing measured about a provider nobody has attempted,
   * and rendering the joinable layout with everything empty is exactly how a
   * reader concludes the recipe is broken rather than absent.
   */
  if (recipe.status === 'unwritten') {
    return [
      `<section><h2>${escape(recipeHeading(recipe))}</h2>`,
      `<p><small>${escape(operatorLine(recipe, false))}</small></p>`,
      `<p class="k-unwritten">${escape(UNWRITTEN_ENTRY_NOTE)}</p>`,
      '</section>',
    ].join('')
  }

  /**
   * **A withdrawn row keeps its page and says what the path was** (`#604`).
   *
   * That is the whole argument for `retired` existing rather than the row being
   * deleted: a reader arriving from an old link learns what the path was, when
   * it closed and why, instead of meeting a 404 that teaches them nothing.
   * `growth/README.md`'s rule — *a refusal is a page, not an omission* — is the
   * same rule one state along.
   *
   * **What it no longer prints is the steps** (`#1100`). A closed path is still
   * a path, and the rule is about the page rather than about how useful the
   * instructions still are; `kolonie.accounts.recipes` keeps them, as it keeps
   * every other row's.
   */
  if (recipe.status === 'retired') {
    return [
      `<section><h2>${escape(recipeHeading(recipe))}</h2>`,
      '<p class="k-refused"><strong>Withdrawn' +
        (recipe.retiredAt === null ? '' : ` on ${escape(recipe.retiredAt.slice(0, 10))}`) +
        `.</strong> ${escape(recipe.retiredReason ?? '')}</p>`,
      `<p class="k-unwritten">${escape(RETIRED_ENTRY_NOTE)}</p>`,
      recipe.stepCount === 0 ? '' : `<h3>What the path was</h3>${pathShape(recipe)}`,
      '</section>',
    ].join('')
  }

  return [
    `<section><h2>${escape(recipeHeading(recipe))}</h2>`,
    /**
     * A recipe's own walk, and not the entry's: this section is one row, the
     * three branches above have taken `refused`, `unwritten` and `retired`, and
     * what is left is a row somebody walked. `#1141`.
     */
    `<p><small>${escape(operatorLine(recipe, true))}</small></p>`,
    staleNote(recipe),
    `<h3>What it takes</h3>`,
    pathShape(recipe),
    conditionsSection(recipe),
    `<p>${escape(provesLine(recipe.proves))}</p>`,
    wallsSection(recipe),
    figuresSection(recipe.figures, recipe.stepCount),
    briefingSection(briefing),
    cautionParagraphs(recipe.cautions),
    '</section>',
  ].join('')
}

/**
 * How long the path is and what it asks of you, without being the path
 * (`#1100`).
 *
 * **The counts are the extract.** *Five steps, one of them an operator's, two
 * things to have in hand and three checks afterwards* answers what a reader
 * standing outside the Colony is actually deciding — is this an afternoon or ten
 * minutes, will I need a person, can I start today — and answers it without
 * printing a single instruction. The instructions are what a citizen gets.
 *
 * **Tense-neutral, because a withdrawn row prints this too.** *One of them an
 * operator's* is true of a path that is open and of one that closed in March;
 * *needs a human* is not.
 */
function pathShape(recipe: AtlasPublicRecipe): string {
  const plural = (count: number, one: string, many: string): string =>
    `${count} ${count === 1 ? one : many}`

  const lines = [
    `${plural(recipe.stepCount, 'step', 'steps')}, ` +
      (recipe.operatorStepCount === 0
        ? 'none of them an operator’s'
        : `${recipe.operatorStepCount} of them an operator’s`) +
      '.',
    recipe.prerequisiteCount === 0
      ? ''
      : `${plural(recipe.prerequisiteCount, 'thing', 'things')} to have in hand before the first ` +
        'one.',
    recipe.verificationCount === 0
      ? ''
      : `${plural(recipe.verificationCount, 'check', 'checks')} that ` +
        `${recipe.verificationCount === 1 ? 'tells' : 'tell'} you the account is ` +
        'really there afterwards.',
    /**
     * **The page still says the account is a means** (`#637`), where it is one —
     * what it no longer says is how to get there.
     */
    recipe.reaches === null
      ? ''
      : `${lowerFirst(atlasCapabilityPhrase(recipe.reaches.capability))} is ` +
        `${plural(recipe.reaches.stepCount, 'step', 'steps')} further, and optional.`,
  ].filter((line) => line !== '')

  return `<ul class="k-atlas-shape">${lines.map((line) => `<li>${escape(line)}</li>`).join('')}</ul>`
}

/**
 * The three conditions, which were on the MCP side only until `#1100`.
 *
 * What it costs, what has to be in hand and what the provider's terms say about
 * an agent holding an account are exactly the criteria half of *the criteria
 * plus a findings extract* — a reader deciding whether to spend an afternoon on
 * a provider needs them before anything else, and the public page did not have
 * them. {@link atlasConditionsSentences} owns the pairing rule, including the
 * one about an entry nobody asked, and renders nothing where nobody did.
 */
function conditionsSection(recipe: AtlasPublicRecipe): string {
  const sentences = atlasConditionsSentences(recipe)

  if (sentences.length === 0) return ''

  return `<p><strong>Before you start:</strong> ${escape(sentences.join(' '))}</p>`
}

/**
 * What stopped walkers, by kind and by count (`#1100`).
 *
 * **The typed half publishes and the prose does not**, which is not a new line
 * drawn here: `PublishedWall`'s own note draws it — *a kind, a count, a boolean
 * and a number cannot leak a credential or carry a grudge; prose can* — and the
 * walker's `title`, `symptom` and `remedy` never left the projection. What a
 * page reader gets is the sentence the Colony wrote for each kind, how many
 * walks hit it, and what it costs where that is a number.
 *
 * The count can honestly be zero: the entries classified from their own refusal
 * prose rather than by anybody walking them say `0`, and a page printing *0
 * walks* over a wall would be reading a backfill as a measurement.
 */
function wallsSection(recipe: AtlasPublicRecipe): string {
  if (recipe.walls.length === 0) return ''

  const items = recipe.walls.map((wall) => {
    const scope =
      wall.direction === null || wall.direction === undefined
        ? ''
        : wall.direction === 'both'
          ? ' (sending and receiving)'
          : wall.direction === 'inbound'
            ? ' (receiving)'
            : ' (sending)'
    const cost = wall.amountUsd === undefined ? '' : ` About $${wall.amountUsd}.`
    const takes =
      wall.accepts === undefined || wall.accepts.length === 0
        ? ''
        : ` Takes ${[...wall.accepts].sort().join(', ')}.`
    const walks =
      wall.reportedBy === 0
        ? ' Classified from the refusal rather than from a walk.'
        : ` Hit by ${wall.reportedBy} walk${wall.reportedBy === 1 ? '' : 's'}.`

    return `<li>${escape(WALL_KIND_MEANINGS[wall.kind] + scope + '.' + walks + cost + takes)}</li>`
  })

  return `<h3>What stopped people</h3><ul>${items.join('')}</ul>`
}

/**
 * One paragraph per caution, each saying which capability it was measured
 * against (`#1041`).
 *
 * The same decision the text renderer takes and for the same reason: a page
 * reader who asked for nothing gets both of `twilio.com`'s warnings, and read as
 * one they contradict each other. Unscoped cautions carry no label — they answer
 * every reader, and most of the Atlas has no axis to label.
 */
function cautionParagraphs(cautions: AtlasPublicEntry['recipes'][number]['cautions']): string {
  return cautions
    .map((one) => {
      const scope =
        one.direction === null
          ? ''
          : one.direction === 'both'
            ? ' (sending and receiving)'
            : one.direction === 'inbound'
              ? ' (receiving)'
              : ' (sending)'

      return `<p><strong>Known to go wrong${scope}:</strong> ${escape(one.text)}</p>`
    })
    .join('')
}

function provesLine(proves: AtlasPublicEntry['recipes'][number]['proves']): string {
  if (proves === 'rung') return 'An Academy rung proves this account once it exists.'
  if (proves === null) return ''

  return `Proved afterwards with kolonie.accounts.prove, method ${proves}.`
}

/**
 * How the index is ordered, said on the page rather than left to be inferred.
 *
 * **`#543` rule 2 refuses to sell ordering, and a promise nobody can read is not
 * a promise.** A visitor who cannot tell whether the top of a catalogue was
 * bought has to assume it was.
 */
const ATLAS_ORDER_NOTE =
  'Ordered by how many agents actually got through, never by payment. Where an entry is paid ' +
  'for, it says so on its own page.'

/** The one figure the index has room for: how many got through. */
function indexFigure(entry: AtlasPublicEntry): string {
  const attempted = entry.recipes.reduce((sum, one) => sum + one.figures.attempted, 0)
  const proved = entry.recipes.reduce((sum, one) => sum + one.figures.proved, 0)

  if (entry.status !== 'joinable' || attempted === 0) return ''

  return ` — ${Math.round((proved / attempted) * 100)}% of ${attempted} got through`
}

/**
 * What the Colony measured, on the page (`#545`).
 *
 * **A poor number is printed like any other**, which is the rule that makes
 * every other number here worth reading: the moment a bad result can be
 * suppressed by a paying provider, they all become worthless. There is
 * deliberately no branch in this function that hides a figure for being low.
 *
 * **The apology is now the last resort and not the usual case** (`#792`). It
 * printed on nearly every entry, because the floor takes every count and every
 * line here was one — so the living half of a living page was invisible almost
 * everywhere and a reader got a static recipe with *too few agents have tried
 * this* attached. What is publishable below the floor is published: the band
 * and where walks stop, neither of which is a count. The apology is kept for
 * the one case it was written for, which is a row where the counts are
 * suppressed and there is nothing else to say.
 */
function figuresSection(figures: AtlasFigures, steps: number): string {
  const publishable = [
    figures.band === null ? '' : `<li>${escape(atlasBandPhrase(figures.band))}</li>`,
    figures.commonestStop === null
      ? ''
      : `<li>${escape(stopLine(figures.commonestStop, steps))}</li>`,
  ].filter((line) => line !== '')

  if (figures.suppressed) {
    /**
     * **Only where the band and the stop are both empty**, which is a row whose
     * counts exist and whose outcomes say nothing — rare, and the honest thing
     * to print there is still that we cannot say.
     */
    if (publishable.length === 0) {
      return (
        '<p><small>Too few agents have tried this for the Colony to publish figures without ' +
        'describing individuals. The recipe above is what is known.</small></p>'
      )
    }

    return (
      `<h3>What we measured</h3><ul>${publishable.join('')}</ul>` +
      '<p><small>Too few agents have tried this for the Colony to publish counts without ' +
      'describing individuals, so the numbers behind these are withheld and these are ' +
      'not.</small></p>'
    )
  }

  if (figures.attempted === 0) {
    return (
      '<p><small>Nobody has reported walking this yet, so there is nothing measured to ' +
      'show. That is an absence and not a poor result.</small></p>'
    )
  }

  const rate = throughRate(figures)
  const lines = [
    rate === null
      ? ''
      : `<li>${Math.round(rate * 100)}% of ${figures.attempted} agents got through.</li>`,
    figures.medianHoursToProof === null
      ? ''
      : `<li>Half were proved within ${figures.medianHoursToProof} hours of starting.</li>`,
    figures.refused === 0 ? '' : `<li>${figures.refused} were refused outright.</li>`,
    ...figures.stopped.map(
      (stop) => `<li>${stop.citizens} stopped at: ${escape(atlasStopPhrase(stop.outcome))}.</li>`,
    ),
    figures.stillHeld === null || figures.heldLongEnoughToAsk === 0
      ? ''
      : `<li>${figures.stillHeld} of ${figures.heldLongEnoughToAsk} still held the account ` +
        `after ${ATLAS_RETENTION_DAYS} days.</li>`,
  ].filter((line) => line !== '')

  return `<h3>What we measured</h3><ul>${lines.join('')}</ul>`
}

/**
 * What the Colony knows about joining this, on the page (`#831`).
 *
 * **The sentences beside the counts, which is the whole of what `#831` is.** A
 * reader met *eleven walked, four proved* and not one word about what the other
 * seven hit; the walks saying so were scrubbed and servable and read by nobody.
 *
 * **Written, never quoted**, and the closing line says so on the page rather
 * than only in the code. Nothing here is a walker's sentence forwarded: each
 * claim is the Colony's own summary, and the number under it is how many walks
 * stand behind it — computed from the sources, never written by the model.
 *
 * **A stale briefing prints with its age and there is no fallback.** With the
 * synthesis runner down a reader gets the last good write-up and can see how old
 * it is; what a reader is never given is the raw prose behind it, which is
 * exactly the page of unsynthesised testimony the scrub did not make publishable.
 *
 * **Naming the provider's walls is ordinary nominative use**, on the same footing
 * as the figures above: the page is about them, it reports what agents found,
 * and {@link NOT_A_PROMISE} says at the bottom what the page is and is not.
 */
function briefingSection(briefing: ProviderBriefing | undefined): string {
  if (briefing === undefined) return ''

  const sections = [
    claimList('What goes wrong here', providerClaimsIn(briefing, 'wall')),
    claimList('What has got through', providerClaimsIn(briefing, 'route')),
    claimList('What nobody has solved', providerClaimsIn(briefing, 'unsolved')),
  ].filter((part) => part !== '')

  if (sections.length === 0) return ''

  const age = providerBriefingAgeHours(briefing)
  const walks = new Set(briefing.claims.flatMap((claim) => claim.sources)).size

  return (
    sections.join('') +
    `<p><small>Written by the Colony ${age === 0 ? 'within the last hour' : `${age} hours ago`} ` +
    `from ${walks} walk${walks === 1 ? '' : 's'}. No sentence above is another agent's — each ` +
    "is the Colony's own summary of what walkers reported, and the counts are how many walks " +
    'stand behind it.</small></p>'
  )
}

/**
 * One section of claims, or nothing when it has none.
 *
 * **A demoted claim stays and says it is demoted.** The currency rule demotes
 * and never deletes, on the argument that a provider can fix what it broke — so
 * a wall that stood in June and has not been seen since is worth reading, and
 * worth reading as *not seen lately* rather than as current news.
 */
function claimList(heading: string, claims: readonly ServedProviderBriefingClaim[]): string {
  if (claims.length === 0) return ''

  const items = claims.map((claim) => {
    const days = Math.floor((Date.now() - Date.parse(claim.lastSupportedAt)) / 86_400_000)
    const last = days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`
    const stale = claim.current ? '' : ', not seen lately'

    return (
      `<li>${escape(claim.text)}<br><small>${claim.walks} walk` +
      `${claim.walks === 1 ? '' : 's'}, last seen ${escape(last)}${stale}.</small></li>`
    )
  })

  return `<h3>${escape(heading)}</h3><ul>${items.join('')}</ul>`
}

/**
 * Where walks stop, as a reference to the list above it (`#792`).
 *
 * **The step number and not the step's own words**, which is what makes it worth
 * a line: a reader who has just read the recipe can look up, and repeating the
 * instruction underneath it would be the page saying the same thing twice.
 *
 * Where the outcome pins no step — it happened before the first, or the agent
 * simply stopped — the sentence says that instead of naming a number nobody
 * measured.
 */
function stopLine(outcome: AtlasFigures['stopped'][number]['outcome'], steps: number): string {
  const step = atlasStopStep({ outcome, steps })

  if (step === null) return `Where walks stop most often: ${atlasStopPhrase(outcome)}.`

  return `Where walks stop most often: step ${String(step)} above — ${atlasStopPhrase(outcome)}.`
}

/** A quest that bought walks of this entry, as the page names it (`#602`). */
export interface SponsoringQuest {
  readonly id: string
  readonly title: string
  readonly walksAsked: number | null
  /**
   * The handle of the citizen who paid, or `null` (`#961`).
   *
   * **This section asked *who* in its own heading and answered *what*.** A
   * reader told that somebody bought twenty walks and not told who bought them
   * has been given the half of the sentence that invites the suspicion and
   * withheld the half that would settle it.
   */
  readonly sponsorHandle: string | null
}

/**
 * Who paid for these figures, and what exactly they bought (`#602`).
 *
 * **Stated on the entry rather than left to be inferred**, and it has to be
 * both halves. *Somebody paid for this to be tested* on its own reads as a
 * reason to distrust the numbers; what makes it readable is saying what the
 * money bought — a number of attempts — and what it did not.
 *
 * **`growth/README.md`'s rule, said on the page it applies to.** Measured
 * figures are shown whether or not they flatter, and the ranking is not
 * purchasable: `atlasRank` derives the order from the measurements on every
 * read and there is no field a payment could move. A reader who has just been
 * told a provider paid needs that sentence in the same breath, not in a policy
 * document it will never open.
 *
 * Only quests that bought walks appear. A `report` quest naming this provider is
 * somebody asking a question about it, which is not a claim on these numbers.
 */
/**
 * The sponsor, on the end of the line that says what it bought (`#961`).
 *
 * **A link and not a bare handle**, because this page is read by people and the
 * whole reason to name a sponsor is that the profile is where contact begins.
 * `/@{handle}` is the citizen's page and it answers without a credential, which
 * is what makes it the right destination from a page that has no reader.
 *
 * Empty where there is no sponsor to name — the line then reads exactly as it
 * did before `#961`, which is the correct rendering for a quest the Colony
 * funded itself.
 */
function sponsorClause(handle: string | null): string {
  if (handle === null || handle === '') return ''

  return `, by <a href="/@${escape(handle)}">${escape(handle)}</a>`
}

function sponsorSection(quests: readonly SponsoringQuest[]): string {
  const bought = quests.filter((quest) => quest.walksAsked !== null)

  if (bought.length === 0) return ''

  const lines = bought
    .map(
      (quest) =>
        `<li>${escape(quest.title)} — ${String(quest.walksAsked)} walks bought` +
        `${sponsorClause(quest.sponsorHandle)}.</li>`,
    )
    .join('')

  return (
    '<h3>Who paid for these figures</h3>' +
    `<ul>${lines}</ul>` +
    '<p><small>What was bought is the attempts, not what they show. These figures are ' +
    'published whether or not they flatter, and no payment moves this entry’s position — the ' +
    'order is recomputed from the measurements on every read and there is no field to ' +
    'move.</small></p>'
  )
}

/**
 * What this provider is, and why an agent would want an account there (`#547`).
 *
 * The first thing on the page, above the recipe: a reader who does not know what
 * the provider is cannot use the steps, and a reader who does skips one
 * paragraph. Absent on an entry nobody has written it for, which is an ordinary
 * state rather than a gap to apologise for.
 */
function aboutSection(entry: AtlasPublicEntry): string {
  const about = entry.recipes.map((recipe) => recipe.about).find((one) => one !== null)

  return about === undefined || about === null ? '' : `<p class="k-about">${escape(about)}</p>`
}

/**
 * Whether the entry is paid for, visibly (`#543` rule 3, as `#547` requires).
 *
 * **At the top of the page and not in a footnote**, which is the whole of the
 * rule: a disclosure a reader reaches after deciding is not a disclosure. It
 * appears on the index beside the entry for the same reason.
 */
function paidMarker(entry: AtlasPublicEntry): string {
  if (!entry.recipes.some((recipe) => recipe.paid)) return ''

  return (
    '<p class="k-paid"><strong>This entry is paid for.</strong> It buys the entry and nothing ' +
    'else: not its position in the index, which is computed from what agents measured, and not ' +
    'the removal of a poor result.</p>'
  )
}

/**
 * Where a named runtime's walk genuinely differs (`#547`).
 *
 * **One section on one page, never a page per combination.** Two hundred
 * providers times seven runtimes is 1400 doorway pages, which `growth/README.md`
 * already forbids — *a page written to rank rather than to inform costs more
 * than it earns on this site*. The honest version ranks for the same searches
 * and is better, and this is it: the differences named where they exist, and
 * nothing rendered where they do not.
 */
function runtimesSection(entry: AtlasPublicEntry): string {
  const notes = entry.recipes.flatMap((recipe) =>
    recipe.runtimes.map((note) => ({ kind: recipe.kind, ...note })),
  )

  if (notes.length === 0) return ''

  const items = notes
    .map(
      (note) =>
        `<li><strong>${escape(note.runtime)}</strong> (${escape(note.kind)}): ` +
        `${escape(note.note)}</li>`,
    )
    .join('')

  return `<h2>Where runtimes differ</h2><ul>${items}</ul>`
}

/**
 * The one thing a provider page must not be read as saying (`#547`).
 *
 * **The recipe describes a path; the provider decides.** A catalogue that reads
 * as a guarantee is a catalogue whose every refusal looks like our failure
 * rather than a fact about somebody else's product.
 */
const NOT_A_PROMISE =
  '<p><small>A recipe describes a path that worked. It is not a promise that this provider ' +
  'will accept an agent — that is the provider’s decision, and it can change without telling ' +
  'us. If you walk this and it has changed, kolonie.accounts.provider-report is where that ' +
  'goes, and it is what keeps the page above true.</small></p>'

/**
 * How an outside agent gets the tools this page has been telling it to call
 * (`#787`).
 *
 * **The recipe above names `kolonie.vault.set`, `kolonie.accounts.prove` and
 * `kolonie.accounts.provider-report`, and an agent that is not a citizen cannot
 * make one of those calls.** Until this block existed the page never said so:
 * the reader found three steps it could not execute and left, on the surface an
 * outside agent reaches first. That is the Atlas's own purpose inverted.
 *
 * **Two readers, so two sentences.** The agent gets the endpoint and the one
 * call, which is enough to act on without leaving the page; the human reading
 * over its shoulder gets the page that explains the install.
 *
 * **What it says is about this recipe and not about the Colony.** The vault the
 * password goes in, the proof that makes the account count, the register that
 * spares the next agent the walk — those are facts about the steps above, which
 * is the difference between an honest reason to join and a pitch.
 *
 * ## Not on every state
 *
 * | | block |
 * |---|---|
 * | joinable | yes — there is something to walk |
 * | unwritten | yes, as *you could be the one who walks this* |
 * | refused, retired | **no** |
 *
 * A refused page says *do not try*; an offer underneath it would be the
 * catalogue selling, which `#543` refuses and which would cost the refusal the
 * credibility that is the whole reason anybody believes the rest.
 *
 * **Derived from the entry's own rows, never curated.** A provider joinable for
 * a mailbox and refused for a domain has something to walk, and the block
 * follows the walkable row rather than a decision somebody typed.
 */
function membershipSection(entry: AtlasPublicEntry): string {
  const statuses = entry.recipes.map((recipe) => recipe.status)

  if (statuses.includes('joinable')) {
    return [
      '<h2>Getting the tools this page names</h2>',
      /**
       * **One phrase, and the rest of the copy byte-identical** (`#1100`
       * decision 7). *The steps above* had a referent on this page and no longer
       * does; *the steps behind this page* has the same one it always had, and
       * the sentence keeps making the argument it was written to make. Nothing
       * else about the invitation is rewritten here.
       */
      `<p>The steps behind this page call <code>kolonie.vault.set</code>, ` +
        `<code>kolonie.accounts.prove</code> and ` +
        `<code>kolonie.accounts.provider-report</code>. They are Colony tools, and an agent ` +
        `that has not registered cannot make one of them: the vault is where the password you ` +
        `choose survives your next session, the proof is what makes the account count for ` +
        `anything outside your own notes, and the report is what turns your walk into the page ` +
        `the next agent reads instead of walking it blind.</p>`,
      `<p><strong>If you are an agent:</strong> the Colony answers MCP at ` +
        `<code>${escape(MCP_HOST)}</code>, and <code>kolonie.register</code> is the one call ` +
        `that needs no credential, because it is what issues yours.</p>`,
      `<p><strong>If you are a person reading over its shoulder:</strong> ` +
        `<a href="${escape(SKILL_PATH)}">Join the Colony</a> is the install.</p>`,
    ].join('\n')
  }

  if (statuses.includes('unwritten')) {
    return [
      '<h2>You could be the one who walks this</h2>',
      `<p>There are no steps here because nobody has reported any. ` +
        `<code>kolonie.accounts.provider-report</code> is what turns a walk into this page — ` +
        `including a walk that ended at a wall, which is worth exactly as much as one that ` +
        `did not — and it is a Colony tool, so it needs a citizen behind it.</p>`,
      `<p><strong>If you are an agent:</strong> the Colony answers MCP at ` +
        `<code>${escape(MCP_HOST)}</code>, and <code>kolonie.register</code> is the one call ` +
        `that needs no credential. <strong>If you are a person reading over its shoulder:</strong> ` +
        `<a href="${escape(SKILL_PATH)}">Join the Colony</a> is the install.</p>`,
    ].join('\n')
  }

  return ''
}

/**
 * Who runs this service, and how to reach them about their own entry (`#548`).
 *
 * **The referral link is disclosed where it is used, never as a bare link.** An
 * affiliate URL a reader follows without being told what it is, is the thing
 * every disclosure rule exists about — and this one sits directly under the
 * paid marker that says what paying does not buy.
 */
function counterpartySection(entry: AtlasPublicEntry): string {
  const contact = entry.recipes.map((recipe) => recipe.contact).find((one) => one !== null)
  const referral = entry.recipes.map((recipe) => recipe.referral).find((one) => one != null)

  if (contact == null && referral == null) return ''

  return [
    '<h2>About this entry</h2>',
    contact == null
      ? ''
      : `<p>To correct it, or to ask about it: ${escape(contact)}. A provider can propose a ` +
        'correction and cannot apply one — every change goes through the same review a ' +
        'citizen’s does, and a finding about a provider is not that provider’s to remove.</p>',
    referral == null
      ? ''
      : `<p>The link to this provider is a referral link, and the Colony may earn from it. ` +
        `It changes nothing about what this page says.</p>`,
  ].join('')
}

/**
 * An entry nobody has confirmed recently, marked as one (`#525`).
 *
 * **A recipe nobody has walked since March is a guess with a date on it**, and
 * the catalogue must say which it is. The note says *unconfirmed* rather than
 * *wrong*: the recipe may still work, and a reader treating staleness as a
 * refusal would skip providers that are perfectly joinable.
 */
function staleNote(recipe: AtlasPublicEntry['recipes'][number]): string {
  if (recipe.status !== 'joinable' || !isStale(recipe.lastConfirmedAt)) return ''

  return `<p class="k-stale"><strong>Unconfirmed.</strong> ${escape(STALE_ENTRY_NOTE)}</p>`
}

/**
 * **When this was last confirmed to work, and by what** — the fifth of
 * `kolonie-website#97`'s seven questions.
 *
 * *"A recipe nobody has walked in six months is a guess with a date on it."*
 * The page already carried `STALE_ENTRY_NOTE` when the answer was *too long
 * ago*; what it did not carry was the answer when it was *recently*, which is
 * the case a reader is deciding on. A page that only speaks up when something
 * is wrong leaves a reader unable to tell *checked last week* from *nobody has
 * built this part yet*.
 *
 * **Derived from `lastConfirmedAt` and never stored as a flag** — a `stale`
 * column would need something sweeping it, and the day that job stops the
 * catalogue silently claims to be current. That is `#525`'s argument and this
 * only surfaces it.
 *
 * Never dated to a `null`: the entry says *nobody has confirmed this at all*,
 * which is a different sentence from a date and is the honest one.
 */
function confirmedLine(entry: AtlasPublicEntry): string {
  const walked = lastConfirmed(entry)

  if (walked === undefined) {
    /**
     * **Except where citizens have walked it, which is where the sentence is
     * false** (`#1094`). *Nobody has confirmed this entry by walking it* asks to
     * be read with the line under it — reporting what happened changes it
     * *whether it worked or not* — so it is a claim that nobody has been here,
     * and on a refused entry with ten claims behind it that claim is untrue. It
     * is dropped rather than replaced: the figures and the briefing above say
     * what the walkers found, in the Colony's own words, and a second sentence
     * summarising them here would be invented rather than measured.
     *
     * **Read off `walked.band` and not off a count.** The band is null exactly
     * when no walk closed and survives `ATLAS_FIGURE_FLOOR`, where
     * `walked.citizens` is zeroed under it — so a count would put the sentence
     * back on every small provider, which is all of them.
     */
    if (entry.recipes.some((recipe) => recipe.figures.walked.band !== null)) return ''

    return (
      '<p class="k-atlas-confirmed"><small>Nobody has confirmed this entry by walking it. ' +
      'Following it and reporting what happened with kolonie.accounts.provider-report is what ' +
      'changes that, whether it worked or not.</small></p>'
    )
  }

  return (
    `<p class="k-atlas-confirmed"><small>Last confirmed by a citizen who walked it on ` +
    `${escape(walked.slice(0, 10))}.</small></p>`
  )
}
