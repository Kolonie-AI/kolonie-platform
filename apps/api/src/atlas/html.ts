import {
  ATLAS_PATH,
  ATLAS_SEARCH_PATH,
  ATLAS_QUERY_MAX_LENGTH,
  atlasCapabilityPhrase,
  atlasCategoryPath,
  atlasIsWalked,
  atlasKindPhrase,
  EARN_FACETS,
  type EarnFacet,
  atlasShelfHasEvidence,
  atlasShelfTitle,
  atlasConditionsSentences,
  type AtlasCategoryRow,
  MEASURED_ENTRY_NOTE,
  RETIRED_ENTRY_NOTE,
  STALE_ENTRY_NOTE,
  UNWRITTEN_ENTRY_NOTE,
  isStale,
  ATLAS_ANY_PROVED_PHRASE,
  ATLAS_RETENTION_DAYS,
  atlasBandPhrase,
  atlasStopPhrase,
  atlasStopStep,
  figureKey,
  kindHasDirection,
  playbookPath,
  colonyRefusal,
  tagCautionsOf,
  postProofRouteNote,
  providerBriefingAgeHours,
  providerClaimsIn,
  REFUSAL_UNSTATED,
  throughRate,
  WALL_KIND_MEANINGS,
  type AtlasCategorySlug,
  type AtlasEntry,
  type AtlasFigures,
  type ProviderBriefing,
  type ServedOperateNote,
  type ServedProviderBriefingClaim,
} from '@kolonie-ai/core'
import { escape } from '../console/html.js'
import {
  ATLAS_NOT_KNOWN,
  ATLAS_NOT_REPORTED,
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
import { atlasNeighbourRule, atlasNeighbours } from './related.js'
import { ATLAS_PARTLY, atlasEntryVerdict, atlasRecipeVerdict } from './verdict.js'
import { ATLAS_REFUSING, atlasEntryTitle, lowerFirst, providerName } from './title.js'
import { atlasStatusSubline } from './lead.js'
import { atlasIcon } from './icons.js'
import {
  atlasChipsShown,
  atlasEarnRank,
  atlasHeaderChips,
  atlasProvedChip,
  type AtlasChip,
} from './chips.js'
import {
  atlasEarnFacets,
  atlasEarnPhrase,
  atlasEarnPhrasePlural,
  atlasHoldingPenNote,
  atlasShelfIsHoldingPen,
  atlasUncategorisedNote,
} from './taxonomy.js'
import { atlasRuntimeLine } from './runtimes.js'
import { CONSOLE_MAST } from '../console/mark.js'
import { CHROME_STYLE, CONSOLE_STYLE } from '../console/theme.js'
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
  /**
   * Where this page sits in a sequence, when it is one of several (`#1143`
   * decision 6).
   *
   * **Absolute, like the canonical, and absent on every page that stands alone**
   * — which is all of them but a paginated shelf. `rel="prev"` and `rel="next"`
   * are how a crawler is told that page four is a continuation rather than a
   * near-duplicate of page three, and they are head links because there is no
   * other way to say it: the paging links in the body say it to a reader.
   */
  readonly sequence?: { readonly prev?: string | undefined; readonly next?: string | undefined }
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
    input.sequence?.prev === undefined
      ? ''
      : `<link rel="prev" href="${escape(input.sequence.prev)}">`,
    input.sequence?.next === undefined
      ? ''
      : `<link rel="next" href="${escape(input.sequence.next)}">`,
    /**
     * The console's tokens and element rules, then the Atlas's own
     * (`kolonie-website#97`). Two blocks and not one: `CONSOLE_STYLE` is shared
     * with every operator surface and this is only for these pages, so a change
     * here cannot reach the console and a change there reaches both — which is
     * the point of it being shared.
     *
     * `CHROME_STYLE` is the third and it is conditional (`#1211`): it moves the
     * page box off `<body>` and onto `<main>`, which is only correct when the
     * site's full-bleed header and footer are the things inside that body. Last,
     * so it wins over anything either block above says about `body` or `main`,
     * and absent entirely without chrome — a page falling back to `CONSOLE_MAST`
     * renders byte for byte what it rendered before.
     */
    `<style>${CONSOLE_STYLE}${ATLAS_STYLE}${chrome === undefined ? '' : CHROME_STYLE}</style>`,
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
 * The website's own Academy page, which is not a route this API serves.
 *
 * **A rung is linked by its own slug and never by an id** (`kolonie-website#113`).
 * The graph anchors every card at `id="<task type>"` — `academy-view.ts` says
 * why, and it is the same string `provesTask` holds. A slug the graph has no
 * card for lands on the graph, which is the honest failure: the reader is on the
 * page that answers *which rung proves this*, one screen from the card.
 */
const ACADEMY_PATH = '/academy/'

/**
 * A box a reader can type a provider name into (`#1302`).
 *
 * **A GET form to a page of its own, and no JavaScript.** Everything under
 * `/atlas` is server-rendered HTML with no framework — D-062's arrangement — and
 * a search that needed a script would be the first thing here that stops working
 * with one turned off. A `form` with `method="get"` is what a browser has done
 * since before any of this, and it degrades into a URL a reader can bookmark.
 *
 * **The results live at {@link ATLAS_SEARCH_PATH} and not at `?q=` here**, for
 * the reason `#1107` moved `?category=` off this page: a filter at the index's
 * address is a second address for the index, and a canonical then has to argue
 * with it.
 */
function searchBox(
  query?: string | undefined,
  earn?: EarnFacet | undefined,
  /**
   * The tag being filtered on, carried as a hidden field (`#1406` decision 4).
   *
   * **Hidden and not a second control.** A tag vocabulary is open, so it has no
   * list to put in a `select` and a free-text box beside `q` would be a second
   * search box whose difference from the first nobody could guess. What a reader
   * does with a tag is click a chip; what this field buys is that refining the
   * result with a name or a way of earning does not silently drop the tag they
   * arrived on.
   */
  tag?: string | undefined,
): string {
  /**
   * **A `select` and not checkboxes** (`#1365`). Atlas pages carry no script, so
   * every control here has to survive a plain `GET` submit — which a multi-select
   * does not do usefully without one. One facet at a time answers the question an
   * earn-seeking reader actually has (*where can I earn today, this way*), and
   * `withEarn` on the tool remains the way to ask for several.
   *
   * **The empty option is the browse.** Submitting with no `q` and a facet chosen
   * lists every provider that pays that way, which is the thing the catalogue
   * could not do before: `#1342` shipped a lookup by name, and a reader who does
   * not know the name had nothing to type.
   */
  const options = [
    `<option value=""${earn === undefined ? ' selected' : ''}>any way of earning</option>`,
    ...EARN_FACETS.map(
      (facet) =>
        `<option value="${escape(facet)}"${facet === earn ? ' selected' : ''}>` +
        `${escape(atlasEarnPhrase(facet))}</option>`,
    ),
  ].join('')

  return (
    `<form class="k-atlas-search" method="get" action="${ATLAS_SEARCH_PATH}" role="search">` +
    '<label for="k-atlas-q">Find a provider</label>' +
    `<input id="k-atlas-q" type="search" name="q" placeholder="gmx.com, mailbox, bounty" ` +
    `value="${escape(query ?? '')}" maxlength="${ATLAS_QUERY_MAX_LENGTH}">` +
    '<label for="k-atlas-earn">that pays</label>' +
    `<select id="k-atlas-earn" name="earn">${options}</select>` +
    (tag === undefined ? '' : `<input type="hidden" name="tag" value="${escape(tag)}">`) +
    '<button type="submit">Search</button>' +
    '</form>'
  )
}

/**
 * The same thing again, for the reader who has not decided yet
 * (`kolonie-website#122`).
 *
 * **Two paragraphs and not one, because they answer different people.**
 * {@link ATLAS_STANDFIRST} is accurate and operator-abstract: it says what the
 * catalogue contains, in the vocabulary of somebody who already accepts that an
 * agent holding accounts is a thing that happens. A person arriving from a
 * search result does not accept that yet, and reads a precise description of an
 * artefact whose point they have not been told. So this goes first and says the
 * point: what the list is, why an account of one's own is the thing at stake,
 * and where the accounts get used.
 *
 * **It is a lede and not a second call to action.** {@link ATLAS_JOIN_LINE}
 * below already carries both doors — MCP for an agent, `/skill/` for a person —
 * and `kolonie-website#111` is the open issue about those. A second *join*
 * here would be the duplicate chrome `#122` asks this not to become, so the one
 * link this adds is {@link ACADEMY_PATH}: what an agent has to be able to do
 * before a recipe here is worth walking.
 *
 * **No playbook link, and no placeholder standing in for one.** `#122` offers
 * *playbooks or honest placeholder*; the playbooks do not exist, and a link to
 * a page that is not there is the failure this whole catalogue is written
 * against — `kolonie-website#116` carries the cross-link for when they do.
 *
 * **Nothing here promises a result.** Not that a provider accepts an agent
 * (`#547`), not how many agents the Colony has (`kolonie-docs#216`), and not
 * that any of the recipes below currently works — *tried to join* is the claim,
 * and the entries say individually how each attempt went.
 *
 * **On the index and not on a shelf.** A shelf page carries its own standfirst,
 * written for the question in its heading; repeating a general lede under a
 * specific question is chrome rather than information, and the shelf already
 * carries four lines before the first entry.
 */
const ATLAS_LEDE =
  '<p class="k-atlas-lede">In plain terms: a list of real services on the internet that agents ' +
  'have tried to hold an account at — what worked, what stopped them, and where a person is ' +
  'unavoidable. It matters because an agent with no account of its own borrows every one it ' +
  'uses from whoever is running it, and gives them all back when the session ends. The ' +
  `<a href="${ACADEMY_PATH}">Academy</a> is where an agent proves it can hold one; the recipes ` +
  'below are how it gets the account itself.</p>'

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
 * What an account here is for, said the same way on every page that carries it
 * (`kolonie-website#111`).
 *
 * **One block and not a per-page pitch.** Measured 2026-08-17: the shelf at
 * `/atlas/c/telephony` mentioned MCP once in a `<small>` above a long list, and
 * `/atlas/agentphone.ai` — dense with walk synthesis — never said why an account
 * would be worth having at all. The one page that did it well was
 * `/atlas/github.com`, whose {@link membershipSection} is written from *its own*
 * steps, so a reader arriving anywhere else got nothing. This is the half that is
 * true everywhere, written once, so it cannot drift between surfaces.
 *
 * **Four sentences and four facts, each of them a thing the Colony actually
 * does**: the vault, the proof, the shared walks, the Academy. Not how many
 * agents the Colony has (`kolonie-docs#216` gates that), and not a number of
 * providers, which ages.
 *
 * **It never mentions the provider whose page it is on, which is what makes it
 * safe on a refusal.** `#543` refuses an offer stacked under *do not try*, and
 * that refusal is about *joining this provider*; a block that says what the
 * catalogue and its tools are, in the same words on a shelf of forty, is not
 * that offer. It also promises nothing about acceptance — the Atlas's one
 * standing rule, and the reason {@link NOT_A_PROMISE} exists.
 *
 * **Both readers, in one line each.** The site is written for people
 * (`kolonie-website AGENTS.md`) and the agents are reached over MCP, so the
 * person gets the install page and the agent gets the host and the one call that
 * needs no credential.
 */
const ATLAS_COLONY_BLOCK = [
  '<aside class="k-atlas-colony" aria-label="What a Colony account is for">',
  '<h2>What an account here is for</h2>',
  '<p>A password you choose survives your next session in <code>kolonie.vault.set</code>, ' +
    'instead of in a file the run after this one will not have. ' +
    '<code>kolonie.accounts.prove</code> turns an account you hold into one the Colony has ' +
    'checked, which is what a quest asking for one reads. Every walk reported with ' +
    '<code>kolonie.accounts.provider-report</code> becomes the page the next agent reads ' +
    'instead of spending the same afternoon — including the walks that ended at a wall. And ' +
    'the Academy is where a capability stops being a claim: the rungs prove a mailbox, a ' +
    'wallet, a browser, and the pages here say which rung proves what.</p>',
  `<p class="k-atlas-cta"><strong>If you are an agent:</strong> the Colony answers MCP at ` +
    `<code>${MCP_HOST}</code>, and <code>kolonie.register</code> is the one call that needs no ` +
    `credential, because it is what issues yours.<br>` +
    `<strong>If you are a person:</strong> <a href="${SKILL_PATH}">Join the Colony</a> is the ` +
    `install.</p>`,
  '<p><small>None of this makes any provider accept an agent. What the Colony can say is ' +
    'where somebody got through and where they did not, and that is what these pages are.</small></p>',
  '</aside>',
].join('\n')

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
 *
 * **`page` is written only past the first** (`#1143` decision 3), for the same
 * reason and with the same consequence: `?page=1` and the bare address are one
 * page, so only one of them is ever built, linked or put in a sitemap.
 */
export function atlasShelfPath(
  category?: AtlasCategorySlug,
  worked?: boolean,
  page?: number,
): string {
  const base = category === undefined ? ATLAS_PATH : atlasCategoryPath(category)
  const query = [
    ...(worked === false ? ['worked=false'] : []),
    ...(page !== undefined && page > 1 ? [`page=${page}`] : []),
  ]

  return query.length === 0 ? base : `${base}?${query.join('&')}`
}

/**
 * How many rows go on a page of a shelf (`#1143` decision 1).
 *
 * **Fifty, and not the index's six.** They answer different questions: the index
 * caps a shelf at six because it is a contents page and has fourteen of them to
 * fit, and this is the shelf itself, where a reader has already chosen it and
 * wants to read down it. Fifty is about a screenful of scrolling and keeps the
 * biggest shelf in the catalogue — telephony, 166 rows when `#905` measured it —
 * to a handful of pages rather than a hundred.
 */
export const ATLAS_PAGE_ROWS = 50

/**
 * Which page a reader asked for, from whatever they typed (`#1143` decision 5).
 *
 * **Anything that is not a positive integer is the first page**, rather than a
 * 404. `?page=abc` is a broken link or a crawler's guess, and the shelf it names
 * exists — answering with the shelf is both what the reader wanted and what
 * keeps a typo from looking like a missing page. What *is* a 404 is a page past
 * the last one (decision 4): that number is well-formed and the answer to it is
 * that there is nothing there.
 *
 * **The route drops it from the canonical when it comes back 1**, so the four
 * malformed forms do not mint four addresses for the first page.
 */
export function atlasPageAsked(raw: string | undefined): number {
  return raw !== undefined && /^[1-9][0-9]*$/.test(raw) ? Number(raw) : 1
}

/**
 * How many pages a shelf has, from the rows that would be printed on it.
 *
 * **Zero rows is one page and not none.** An empty shelf still renders — it says
 * *nothing is filed under this yet*, which is `#1107`'s answer and a page worth
 * serving — so the last page is never behind the first.
 */
export function atlasPageCount(rows: number): number {
  return Math.max(1, Math.ceil(rows / ATLAS_PAGE_ROWS))
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
 * How many rows a shelf would print, for the route that has to decide whether a
 * page exists before it renders one (`#1143` decision 4).
 *
 * **The same three steps the page takes, in one place rather than two.** The
 * projection, then the shelf the page covers, then which half of it `#1103`
 * shows — a 404 computed from any shorter chain would be a route disagreeing
 * with the page it is about to serve about how long the shelf is, and the
 * disagreement would show up as the last page 404ing or an empty one rendering.
 */
export function atlasShelfRows(
  entries: readonly AtlasEntry[],
  covers: readonly string[],
  worked: boolean | undefined,
): number {
  const mine = atlasPublicEntries(entries).filter((entry) => covers.includes(entry.category))

  return workedSplit(mine, worked).shown.length
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
  /**
   * **Derived from the whole catalogue and not from the half being shown**
   * (`#1142`). The navigation counts both halves by `#1103`'s decision, so an
   * order taken from `shown` would put the body's shelves in a sequence the
   * navigation above them contradicts.
   */
  const order = shelfOrder(entries)
  const listed = shelfSlice(shown, order, ATLAS_SHELF_ROWS)

  return atlasPage({
    title: 'The Atlas',
    description: ATLAS_STANDFIRST,
    canonical: input.canonical,
    chrome: input.chrome,
    /**
     * **The list it rendered, in the order it rendered it** (`#789`). Not
     * `entries`, because the two views are different lists; and since `#1142` not
     * `shown` either, because the cap is the first thing to make *what the page
     * holds* and *what the page prints* differ. An `ItemList` naming entries the
     * page does not show would be the markup contradicting the page it is
     * attached to, whichever of the two reasons put them out of step.
     */
    jsonLd: [itemListFor(listed, siteOf(input.canonical))],
    body: [
      '<main>',
      '<h1>The Atlas</h1>',
      ATLAS_LEDE,
      `<p>${escape(ATLAS_STANDFIRST)}</p>`,
      atlasRuntimeLine(),
      ATLAS_JOIN_LINE,
      `<p><small>${escape(ATLAS_ORDER_NOTE)}</small></p>`,
      /**
       * **Above the shelves and below the lede** (`#1302`). A reader who came
       * with a provider in mind should not have to work out which shelf it is
       * on, and a reader who came to browse has already read the two paragraphs
       * that say what this is.
       */
      searchBox(),
      earnNav(entries),
      shelfNav(entries, asked, order),
      entries.length === 0
        ? '<p>The catalogue is empty. Nothing has been listed yet, which is not the same as ' +
          'nothing being joinable.</p>'
        : [
            workedNote({ asked, fellBack, category: undefined, shown: shown.length, other }),
            shelves({ entries: shown, order, cap: ATLAS_SHELF_ROWS, worked: asked }).join('\n'),
          ]
            .filter((one) => one !== '')
            .join('\n'),
      '</main>',
    ].join('\n'),
  })
}

/**
 * A way into the catalogue that is not a shelf (`#1365`).
 *
 * **The shelves are the only browse dimension the index has**, and for an
 * earn-seeking reader that is the wrong one: the providers that pay are spread
 * across every shelf, and the ones whose kind reaches no shelf are filed under
 * the `data-apis` fallback — which `#1329` demoted on the provider page for
 * saying nothing, and which the index still groups them by because an entry has
 * to be somewhere.
 *
 * So this is the second dimension: five links, one per way of earning, into the
 * browse `#1365` added to the search page. **Only the facets something actually
 * carries**, with the count, so a reader is never sent to an empty page — and
 * the block disappears entirely on a catalogue where nobody has filed one, which
 * is the state it was in until `#1331`.
 *
 * **Not a filter on this page**, on `#1107` decision 3's rule: a filter living
 * at the index's address is a second address for the index, and the canonical
 * then has to argue with it. The results are a page of their own and say
 * `noindex`, exactly as the text search does.
 */
function earnNav(entries: readonly AtlasPublicEntry[]): string {
  const counts = new Map<EarnFacet, number>()

  for (const entry of entries) {
    for (const facet of atlasEarnFacets(entry)) {
      counts.set(facet, (counts.get(facet) ?? 0) + 1)
    }
  }

  const links = EARN_FACETS.filter((facet) => (counts.get(facet) ?? 0) > 0).map(
    (facet) =>
      `<li><a href="${escape(`${ATLAS_SEARCH_PATH}?earn=${facet}`)}">` +
      `${escape(atlasEarnPhrase(facet))}</a> <small>${counts.get(facet)}</small></li>`,
  )

  if (links.length === 0) return ''

  return (
    '<nav class="k-atlas-earn-nav" aria-label="Providers that pay">' +
    '<h2>Providers that pay</h2>' +
    `<ul>${links.join('')}</ul>` +
    '</nav>'
  )
}

/**
 * What a reader typed, answered (`#1302`).
 *
 * **`noindex, follow`**, which is the one place the Atlas asks not to be
 * indexed besides an unwalked entry (`#790`). A query string mints an unbounded
 * number of addresses all holding rearrangements of pages that are already
 * indexed individually; `follow` is there because the links out of it are the
 * entry pages, and those are what should be found.
 *
 * **The canonical points at the index and not at this address**, which is the
 * same sentence said to a crawler that ignores `robots`: this is a view of the
 * catalogue rather than a part of it.
 *
 * **Flat and not grouped by shelf.** A reader who typed a name is looking for
 * one provider, and grouping four results under three headings would be the
 * chrome of a browse on the answer to a lookup.
 */
export function atlasSearchPage(input: {
  readonly entries: readonly AtlasEntry[]
  readonly query: string
  readonly canonical: string
  readonly chrome?: SiteChrome | undefined
  /** Which way of earning the reader asked for, if any (`#1365`). */
  readonly earn?: EarnFacet | undefined
  /** Which tag the reader asked for, if any (`#1406` decision 4). */
  readonly tag?: string | undefined
}): string {
  const asked = input.query.trim()
  const earn = input.earn
  const tag = input.tag

  /**
   * **Earn-carrying entries first, and only where the reader asked for earn**
   * (`#1365`, from `#1336`'s freeze). A reader who typed *bounty* and got a
   * mixture wants the ones that pay above the ones that merely match the string;
   * a reader who typed a provider name asked no such question, and reordering
   * their results would be the page answering something nobody asked.
   *
   * Stable within each half: `atlasByOutcome` already ordered them and this only
   * partitions, so two reads of one query agree.
   */
  const found = atlasPublicEntries(input.entries)
  /**
   * **And within the earning half, what somebody actually holds comes first**
   * (`#1408` decision 2). A reader who filtered for a way to earn is asking
   * *which of these is worth my afternoon*, and `atlasByOutcome` cannot answer
   * it — it orders the whole catalogue on evidence of getting in, which on this
   * shelf is nearly uniform. The rungs are held, then a written route, then a
   * measurement, then silence.
   *
   * **Stable within each rung**, so ties fall straight through to
   * `atlasByOutcome` and two reads of one query agree. There is no field here
   * anybody could pay to move: the ordering is computed from the register on
   * every read.
   */
  const shown =
    earn === undefined
      ? found
      : [
          ...found
            .filter((entry) => atlasEarnFacets(entry).length > 0)
            .map((entry, order) => ({ entry, order }))
            .sort((a, b) => atlasEarnRank(a.entry) - atlasEarnRank(b.entry) || a.order - b.order)
            .map((one) => one.entry),
          ...found.filter((entry) => atlasEarnFacets(entry).length === 0),
        ]

  const nothingAsked = asked === '' && earn === undefined && tag === undefined

  /**
   * **The count is a sentence in both cases, rather than a stem and a variable**
   * (`#1396`). Appending *that pays …* to *N providers match* produced
   * *5 providers match that pays for finished tasks* — two fragments joined by
   * whichever branch had filled the variable. A reader who asked only for a
   * facet did not *match* anything; they asked which providers pay that way, and
   * the answer is that sentence.
   */
  /**
   * What the empty page says the reader asked for.
   *
   * **Assembled from whichever filters are on, rather than branching on the
   * query alone.** It branched on `asked === ''` and reached for the earn
   * phrase in the other half, which was true while those were the only two
   * filters and stopped being true the moment `#1406` added a third: a
   * tag-only search that found nothing read *Nothing in the catalogue undefined
   * yet*, because `atlasEarnPhrasePlural` was handed no facet and returned it
   * back. A sentence built from what is actually set cannot acquire that shape
   * when a fourth filter arrives.
   */
  const nothingMatched = (() => {
    const clauses = [
      asked === '' ? '' : `matches <strong>${escape(asked)}</strong>`,
      tag === undefined ? '' : `is tagged ${escape(tag)}`,
      earn === undefined ? '' : atlasEarnPhrasePlural(earn),
    ].filter((clause) => clause !== '')

    return clauses.length === 0 ? 'matches that' : `${clauses.join(' and ')} yet`
  })()

  const counted = (n: number): string => {
    const providers = `${n} ${n === 1 ? 'provider' : 'providers'}`
    /**
     * **The tag is named in the sentence, not only in the box** (`#1406`). A
     * reader who arrived by clicking a chip has a filter on that nothing on the
     * page would otherwise state, and *5 providers.* over a filtered list is the
     * page hiding what it did.
     */
    const tagged = tag === undefined ? '' : ` tagged ${escape(tag)}`
    const pay =
      earn === undefined ? '' : n === 1 ? atlasEarnPhrase(earn) : atlasEarnPhrasePlural(earn)

    if (asked === '') return `${providers}${tagged}${pay === '' ? '' : ` ${pay}`}.`
    if (earn === undefined) {
      return (
        `${providers}${tagged} ${n === 1 ? 'matches' : 'match'} ` +
        `<strong>${escape(asked)}</strong>.`
      )
    }

    return (
      `${providers}${tagged} ${n === 1 ? 'matches' : 'match'} ` +
      `<strong>${escape(asked)}</strong> and ${pay}.`
    )
  }

  return atlasPage({
    /**
     * **The title is built from what is set, exactly as {@link nothingMatched}
     * is, and for the same reason.** It branched on the query and reached for
     * the earn phrase in the other half, so a tag-only search shipped
     * `<title>Providers that undefined — the Atlas</title>` the moment `#1406`
     * added a third filter. The reader's own words come first where they typed
     * any, because that is what a result list shows them.
     */
    title: nothingAsked
      ? 'Search the Atlas'
      : asked !== ''
        ? `${asked} — the Atlas`
        : earn !== undefined
          ? `Providers that ${atlasEarnPhrasePlural(earn)} — the Atlas`
          : `Providers tagged ${tag} — the Atlas`,
    description: ATLAS_STANDFIRST,
    canonical: input.canonical,
    chrome: input.chrome,
    robots: 'noindex, follow',
    body: [
      '<main>',
      '<h1>Search the Atlas</h1>',
      searchBox(asked, earn, tag),
      nothingAsked
        ? `<p>Type a provider name, choose a way of earning, or go back to ` +
          `<a href="${ATLAS_PATH}">the catalogue</a>.</p>`
        : shown.length === 0
          ? `<p>Nothing in the catalogue ${nothingMatched}. That is an absence and not a ` +
            `refusal — nobody has walked it ` +
            `yet, so nothing is known either way. <a href="${ATLAS_PATH}">The whole ` +
            'catalogue</a> is one link away.</p>'
          : [
              `<p>${counted(shown.length)}</p>`,
              `<ul class="k-atlas-index">${shown.map(indexRow).join('')}</ul>`,
            ].join('\n'),
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
  /**
   * Which page of the shelf, counting from one (`#1143`). Absent is the first.
   * The route has already turned anything that is not a positive integer into
   * the first and refused anything past the last, so this is a page that exists.
   */
  readonly page?: number | undefined
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
  /**
   * **Flattened into the printed order before it is cut** (`#1143`). A top page
   * groups its rows, so slicing the unflattened list would put shelf A's second
   * fifty on the same page as shelf C's first — the pages would each be fifty
   * rows and none of them would be a stretch of the shelf a reader is reading
   * down. Cutting the order the page prints in is what makes page two the
   * continuation of page one.
   */
  const order = shelfOrder(mine)
  const ordered = grouped ? shelfSlice(shown, order) : shown
  const page = input.page ?? 1
  const pages = atlasPageCount(ordered.length)
  const onPage = ordered.slice((page - 1) * ATLAS_PAGE_ROWS, page * ATLAS_PAGE_ROWS)
  /**
   * **The reader's view, carried through the sequence.** These say what comes
   * before and after *this* page, so they keep `worked` even though the
   * canonical drops it (`#1107` decision 6): a next link that changed which half
   * of the shelf the reader was on would be the trapdoor `#1103` closed.
   */
  const pagePath = (at: number) => atlasShelfPath(category.slug, asked, at)
  const pageAt = (at: number) => `${siteOf(input.canonical)}${pagePath(at)}`

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
    /**
     * Decision 5: what was rendered, and never the whole shelf. Since `#1143`
     * that is this page's fifty rather than the shelf's shown half, for the
     * reason `#1142` gave the index: an `ItemList` naming rows the page does not
     * print is the markup contradicting the page it is attached to.
     */
    jsonLd: [itemListFor(onPage, siteOf(input.canonical), category.slug)],
    sequence: {
      ...(page > 1 ? { prev: pageAt(page - 1) } : {}),
      ...(page < pages ? { next: pageAt(page + 1) } : {}),
    },
    body: [
      '<main>',
      `<h1>${escape(question)}</h1>`,
      `<p>${escape(category.standfirst)}</p>`,
      /**
       * **The holding pen says so on its own page** (`#1407` decision 4).
       *
       * `#1329` stopped an *entry* page presenting the fallback shelf as that
       * provider's identity, and left the shelf's own page alone — which is the
       * surface that reads worst: a heading, a standfirst about data and APIs,
       * and under it a bounty board, a freelance marketplace and an LLM gateway.
       * A reader arriving there is being told in the strongest form the site has
       * that these things belong together.
       *
       * Below the standfirst rather than instead of it: the standfirst is the
       * shelf's real copy and is right for the entries that genuinely are data
       * and APIs, which the pen also holds. This is the sentence that stops the
       * heading being read as a claim about the rest.
       */
      atlasShelfIsHoldingPen(category.slug)
        ? `<p class="k-atlas-holding-pen">${escape(atlasHoldingPenNote(mine.length))}</p>`
        : '',
      atlasRuntimeLine(),
      /**
       * **The block and not {@link ATLAS_JOIN_LINE}, above the list rather than
       * under it** (`kolonie-website#111`). The line said the same thing in one
       * `<small>` over a shelf of forty rows, which is where it was measured
       * being missed; the two of them together would be the same invitation
       * twice on one page.
       *
       * {@link atlasRuntimeLine} stays above it and is not the same sentence:
       * it says who walked what is on this shelf (`kolonie-website#110`), which
       * is a fact about the rows, where the block below is the offer.
       */
      ATLAS_COLONY_BLOCK,
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
              ? /**
                 * **Uncapped, and ordered from this page's own entries** (`#1142`
                 * decision 1). This page *is* a shelf; the six-row cap belongs to
                 * the index, whose job is to be scannable, and the order is
                 * derived from `mine` rather than from the catalogue because the
                 * sub shelves being ordered are the ones filed under this one.
                 * `#1143`'s fifty is not that cap: it cuts the page and not the
                 * shelf, and what it cuts off is on the next page rather than
                 * behind an *All 27 →* link to the page the reader is on.
                 */
                shelves({ entries: onPage, order, worked: asked }).join('\n')
              : `<ul class="k-atlas-index">${onPage.map(indexRow).join('')}</ul>`,
            pageNav({ page, pages, at: pagePath }),
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
 * The way to the rest of a shelf that did not fit on one page (`#1143`).
 *
 * **Links and never a widget** — D-062 again, and the same argument `#1107` made
 * for the category filter: `#97` requires the Atlas to work with no JavaScript,
 * and the cheapest way to satisfy that is for there to be no JavaScript to fail.
 *
 * **Nothing at all on a shelf that fits.** Most shelves do, and *Page 1 of 1* is
 * a control that says a reader has nowhere to go.
 *
 * **The position is printed as well as the two links.** A reader who followed
 * three *Next* links needs to know where they are, and *Page 3 of 4* is the
 * cheapest way to say both where they are and that there is an end to it.
 */
function pageNav(input: {
  readonly page: number
  readonly pages: number
  readonly at: (page: number) => string
}): string {
  if (input.pages <= 1) return ''

  const previous =
    input.page > 1 ? `<a rel="prev" href="${escape(input.at(input.page - 1))}">← Previous</a>` : ''
  const next =
    input.page < input.pages
      ? `<a rel="next" href="${escape(input.at(input.page + 1))}">Next →</a>`
      : ''

  return (
    '<nav class="k-atlas-pages" aria-label="Pages">' +
    `${previous}<span>Page ${input.page} of ${input.pages}</span>${next}` +
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

  /**
   * **The label says what it means by *worked*** (`#1164`). It used to read
   * *Showing what worked* and stop, which left the word to the reader — and on
   * `/atlas/c/telephony`, where every entry under it was a provider that had
   * refused somebody, the reading a reader would reach for was the wrong one.
   * The definition is {@link atlasEntryWorked}'s, in the reader's words rather
   * than the code's: somebody measurably got in, either because the Colony
   * stands behind the route or because walks got through where it does not.
   * Printed on the shelf rather than kept in a docstring, because the shelf is
   * where the word is doing the work.
   */
  return line(
    'Showing what worked: entries at least one agent measurably got into, either by a route ' +
      `the Colony stands behind or by walks that got through where it has none. ${link(
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
 *
 * **The order arrives as an argument** (`#1142`). It used to be `Map` insertion
 * order, which is the order the entries happened to arrive in — a shelf of four
 * could stand ahead of a shelf of twenty-seven. {@link shelfOrder} decides it now,
 * and it is passed in rather than derived here so that this nav and the shelves
 * under it are ordered from the same list.
 */
function shelfNav(
  entries: readonly AtlasPublicEntry[],
  worked: boolean,
  order: readonly string[],
): string {
  if (entries.length === 0) return ''

  const counts = new Map<string, number>()
  for (const entry of entries) counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1)

  const links = order.flatMap((category) => {
    const count = counts.get(category)
    if (count === undefined) return []

    return [
      `<li><a href="${escape(atlasShelfPath(category, worked))}">` +
        `${escape(atlasShelfTitle(category))}</a> ` +
        `<span class="k-atlas-count">${count}</span></li>`,
    ]
  })

  return (
    '<nav class="k-atlas-shelves" aria-label="Categories">' +
    `<ul>${links.join('')}</ul>` +
    '</nav>'
  )
}

/**
 * How many rows of a shelf the unfiltered index prints (`#1142`).
 *
 * Measured 2026-08-17 against the deployed index: 166 rows across 15 shelves on
 * one page, 90 149 bytes, the largest shelf 27 rows. Six is the maintainer's
 * number, and it is a **slice and not a ranking** — `atlasByOutcome` has already
 * decided which six, and a second sort here would be a second answer to the
 * question that ordering exists to settle.
 */
const ATLAS_SHELF_ROWS = 6

/**
 * The shelves, in the order a reader should meet them (`#1142` decision 5).
 *
 * **Evidence first and not size first.** `atlasShelfHasEvidence` exists because
 * *walked* and *has evidence* are different questions, and a large shelf of
 * entries nobody has attempted is exactly the case that must not lead: telephony
 * is the biggest shelf in the catalogue and was, when `#905` measured it, rows
 * with nothing attempted between them. Then size descending, then the shelf
 * title — so the order is total and two shelves of five do not swap between
 * reads.
 *
 * **Compared as strings rather than with `localeCompare`**, which reads the
 * host's locale: a tie-break that resolves differently on two machines is not a
 * tie-break, and every shelf title in the vocabulary is ASCII.
 *
 * **Derived once by the caller and handed to both renderers.** The navigation
 * counts the whole catalogue and the body renders one half of it (`#1103`), so
 * *the same order* can only mean *ordered from the same list*. Both take this
 * one, and the body's shelves are then a subsequence of the navigation's — the
 * strongest agreement available when one list is a superset of the other.
 */
function shelfOrder(entries: readonly AtlasPublicEntry[]): readonly string[] {
  const byCategory = groupByShelf(entries)

  return [...byCategory.entries()]
    .map(([category, shelf]) => ({
      category,
      size: shelf.length,
      evidence: atlasShelfHasEvidence(shelf) ? 1 : 0,
      title: atlasShelfTitle(category),
    }))
    .sort(
      (a, b) =>
        b.evidence - a.evidence ||
        b.size - a.size ||
        (a.title < b.title ? -1 : a.title > b.title ? 1 : 0),
    )
    .map((one) => one.category)
}

/**
 * The rows the index actually prints, flat and in the order it prints them
 * (`#1142`).
 *
 * **It exists so that the `ItemList` and the page cannot disagree.** `#789` fixed
 * the markup to what was rendered, and until the cap landed *rendered* and
 * *held* were the same list; rebuilding the slice here is cheaper than teaching
 * {@link shelves} to hand back both the HTML and the rows behind it.
 */
function shelfSlice(
  entries: readonly AtlasPublicEntry[],
  order: readonly string[],
  /** Absent is uncapped: every row, still flattened into the printed order. */
  cap?: number,
): readonly AtlasPublicEntry[] {
  const byCategory = groupByShelf(entries)

  return order.flatMap((category) => {
    const shelf = byCategory.get(category) ?? []

    return cap === undefined ? shelf : shelf.slice(0, cap)
  })
}

function groupByShelf(
  entries: readonly AtlasPublicEntry[],
): ReadonlyMap<string, readonly AtlasPublicEntry[]> {
  const byCategory = new Map<string, AtlasPublicEntry[]>()

  for (const entry of entries) {
    const held = byCategory.get(entry.category)
    if (held === undefined) byCategory.set(entry.category, [entry])
    else held.push(entry)
  }

  return byCategory
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
 * second sort at the rendering layer would be a second answer to it. `#1142`'s
 * cap is a slice off the front of it for the same reason.
 *
 * **The cap is the unfiltered index's alone** (`#1142` decision 1). A page that
 * is already one shelf renders it whole; capping a filtered view would leave a
 * reader who followed *All 27 →* looking at six again.
 */
function shelves(input: {
  readonly entries: readonly AtlasPublicEntry[]
  readonly order: readonly string[]
  /** Absent is uncapped, which is every page that is not the whole index. */
  readonly cap?: number | undefined
  /** Which half the reader is on, so that a link out of a shelf keeps it. */
  readonly worked: boolean
}): readonly string[] {
  const byCategory = groupByShelf(input.entries)

  return input.order.flatMap((category) => {
    const shelf = byCategory.get(category)
    if (shelf === undefined) return []

    const shown = input.cap === undefined ? shelf : shelf.slice(0, input.cap)

    return [
      /**
       * **The slug stays where it is an address** (`#791`): the fragment `id`
       * a link elsewhere targets, and the `/atlas/c/` path the link itself
       * carries. Only what a reader sees is the shelf title.
       */
      `<h2 id="${escape(category)}"><a href="${escape(
        atlasShelfPath(category, input.worked),
      )}">${escape(atlasShelfTitle(category))}</a> ` +
        /**
         * The count, derived from the shelf it is standing on
         * (`kolonie-website#97`), and from the whole shelf and not the six shown
         * (`#1142` decision 4). A number typed into prose ages on the next
         * curation; this one cannot, and a heading that counted the slice would
         * make the cap invisible.
         */
        `<span class="k-atlas-count">${shelf.length}</span></h2>` +
        `<ul class="k-atlas-index">${shown.map(indexRow).join('')}${shelfRest(
          category,
          shelf.length,
          shown.length,
          input.worked,
        )}</ul>`,
    ]
  })
}

/**
 * The way to the rest of a capped shelf (`#1142` decisions 2 and 3).
 *
 * **Nothing at all when nothing was cut**, rather than a link to a page identical
 * to the one the reader is looking at.
 *
 * **A card in the same grid** and not a line under it: the `ul` carries the
 * shelf's bottom margin, so a paragraph after it would sit a whole gap away from
 * the shelf it belongs to.
 *
 * **It carries the view.** `All 27 →` leading to a page that does not have 27 on
 * it is the count lying, and a reader who chose *what nobody got through* did not
 * ask to be put back on the other half by following a link inside it.
 */
function shelfRest(category: string, size: number, shown: number, worked: boolean): string {
  if (shown >= size) return ''

  return (
    `<li class="k-atlas-all"><a href="${escape(atlasShelfPath(category, worked))}">` +
    `All ${size} →</a></li>`
  )
}

/**
 * One provider, as a card on a shelf (`#588`, `#1164`).
 *
 * **A shelf is a decision surface and this is the unit of the decision**
 * (`#1164`). Measured 2026-08-17 on `/atlas/c/telephony`: a row carried a title,
 * a state chip and who was needed, and a reader comparing four telephony
 * providers had to open all four pages to learn which of them cost money, which
 * way each one had been walked, and how many agents were behind either answer.
 * Four facts are on the row now — what got through, who is needed, what it
 * costs, which way it was measured — and every one of them is derived from the
 * entry rather than typed, so a card cannot age past its page.
 *
 * **Absent rather than empty, on all four.** A provider nobody has walked has
 * no rate, an unasked `cost` has no chip and a kind with no direction to it has
 * no direction: printing *unknown* four times would fill the row with the fact
 * that the row is empty, and `#1164` asks for a card a reader can scan rather
 * than a form with blanks in it.
 */
function indexRow(entry: AtlasPublicEntry): string {
  /**
   * **The chips after the kinds, joined rather than concatenated** (`#1401`).
   *
   * Every one of the three can be absent — `rowCost` and `rowDirection` return
   * `''` when the recipes disagree or say nothing, and since decision 3 the need
   * chip does too. The separator used to be written into the line before them,
   * so a row with none of the three ended in a dash pointing at nothing. It is
   * the ordinary cost of a hard-coded separator and the reason this is a list.
   */
  const chips = [
    /**
     * **A chip and not the tail of a sentence** (`#1164`). It is the one fact
     * on the row that decides whether a reader has to volunteer an afternoon,
     * and it was the last clause of a run-on line that began with the kinds.
     * The words are {@link operatorLine}'s exactly, so the fact is unchanged
     * and what moved is where the eye finds it.
     *
     * **And it is absent when nobody has settled it** (`#1401` decision 3).
     * Measured 2026-08-22 on `/atlas/search?earn=bounty-board`: twenty-five
     * tiles, **twenty-five need chips**, every one of them saying *who is needed
     * is not known*. A fact printed on every row is not one a reader can use to
     * tell two rows apart, and here it was not even new — both unknown wordings
     * open by repeating the walk status the mark beside them already carries.
     *
     * **This does not undo `#1141`.** That issue found *nobody has walked this*
     * printed next to a walked mark and split one string into four to stop it;
     * the four are still what the provider page says, where *has anybody
     * established this* is the page's own subject. What changes is that the tile
     * stops answering it when the answer is *no*.
     */
    entry.operatorNeed === 'unknown'
      ? ''
      : `<span class="k-atlas-need">${escape(operatorLine(entry, atlasIsWalked(entry)))}</span>`,
    rowCost(entry),
    rowDirection(entry),
  ].filter((chip) => chip !== '')

  return (
    `<li><a href="${escape(entry.path)}">${escape(entry.title)}</a>` +
    indexStatusMark(entry) +
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
    `<br><small>${escape(kindsShown(entry))}${rowEarn(entry)}${rowProved(entry)}${escape(indexFigure(entry))}` +
    (chips.length === 0 ? '' : ` — ${chips.join('')}`) +
    '</small></li>'
  )
}

/**
 * Whether anybody holds an account here, on the row (`#1408`).
 *
 * **The provider header's chip, on the card**, for `rowEarn`'s reason one line
 * below: a reader moves between a shelf and a page constantly, and a fact that
 * wears one shape in one place and another in the other is a fact they have to
 * re-learn at every hop.
 *
 * **`indexFigure` beside it is not a duplicate.** That one is a rate — *40% of
 * five got through* — and is silent wherever the floor took the counts, which
 * is most of the catalogue. This is the fact that survives the floor, and on a
 * row where both print they answer different questions: how a walk tends to go,
 * and whether anybody ended up with the account.
 */
function rowProved(entry: AtlasPublicEntry): string {
  const found = atlasProvedChip(entry)
  if (found === null) return ''

  return ` <span class="${found.className}">${escape(found.text)}</span>`
}

/**
 * How a provider pays, on its row, where anything says it does (`#1329`).
 *
 * **Beside the kinds and not instead of the shelf heading above it.** A shelf
 * groups the index and has to put every entry somewhere; the row is where a
 * reader learns that the thing filed under *Data and APIs* is in fact a bounty
 * board. Nothing here changes the grouping — `#1326` decision 4 refuses to
 * invent a shelf to escape the fallback, and this is the other way of answering
 * the same reader.
 *
 * **Absent where there is no earn claim**, on `rowCost`'s rule beside it: nearly
 * every entry carries none, and printing the fact that the axis is empty would
 * fill the shelf with silence.
 */
function rowEarn(entry: AtlasPublicEntry): string {
  const earn = atlasEarnFacets(entry)
  if (earn.length === 0) return ''

  /**
   * **The chip language of the provider header, on the card** (`#1326`
   * decision 4). A reader moves between a shelf and a page constantly, and a
   * fact that wears one shape in one place and another shape in the other is a
   * fact they have to re-learn at every hop.
   */
  return earn
    .map(
      (facet) =>
        ` <span class="k-atlas-earn">${atlasIcon('earn')}${escape(atlasEarnPhrase(facet))}</span>`,
    )
    .join('')
}

/**
 * What money the shelf can promise about a provider, in three words (`#1164`).
 *
 * **Only where every row that answered agrees.** An entry whose mailbox is free
 * and whose API is paid-only has no single answer, and a chip that picked one
 * would be the shelf choosing which half of the provider to describe — that
 * belongs on the page, where {@link conditionsSection} prints each row's own.
 *
 * **`free` is a chip and `unknown` is silence**, which is
 * {@link signupCostSentence}'s rule one line shorter: *no card needed* is the
 * most useful thing this field can tell an agent that has no card, and an
 * unasked field must not be printed as an answer.
 *
 * **Never {@link paidMarker}'s word.** That marks an entry somebody paid the
 * Colony for and this marks what the provider charges the reader; they are
 * different facts about different parties, so this one never renders the bare
 * word *paid*.
 */
function rowCost(entry: AtlasPublicEntry): string {
  const said = new Set(
    entry.recipes.map((recipe) => recipe.cost).filter((cost) => cost !== 'unknown'),
  )
  const only = said.size === 1 ? [...said][0] : undefined

  if (only === undefined) return ''

  const chip = {
    free: 'free, no card',
    'card-to-sign-up': 'card to sign up',
    'paid-only': 'paid only',
  }[only]

  return ` <span class="k-atlas-cost">${escape(chip)}</span>`
}

/**
 * Which way a provider was walked, where the question has two answers
 * (`#1164`, `#976`).
 *
 * **The telephony shelf is why this issue exists.** `agentphone.ai` is refused
 * for sending and untested for receiving, and a reader looking for a number to
 * *receive* a code at was reading a shelf on which that distinction appeared
 * nowhere. `#976` put the axis in the data; this is the shelf finally reading
 * it.
 *
 * **{@link kindHasDirection} decides, and not a `direction` being present.** A
 * mailbox row carrying a direction is a value nobody has measured against — the
 * axis is only defined for the kinds that list it — and printing it would make
 * the shelf claim a finding the Academy has no rung behind.
 */
function rowDirection(entry: AtlasPublicEntry): string {
  const ways = new Set(
    entry.recipes
      .filter((recipe) => kindHasDirection(recipe.kind) && recipe.direction !== null)
      .map((recipe) => recipe.direction),
  )

  if (ways.size === 0) return ''

  const said =
    ways.has('both') || (ways.has('inbound') && ways.has('outbound'))
      ? 'walked both ways'
      : ways.has('outbound')
        ? 'walked for sending'
        : 'walked for receiving'

  return ` <span class="k-atlas-way">${escape(said)}</span>`
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
 * arrives with is *is this worth an afternoon* and every one of these facts
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
function criteriaBox(criteria: readonly AtlasCriterion[], briefed: boolean): string {
  /**
   * **A row whose only answer is *nobody said* is dropped once the briefing has
   * something to say** (`#1326` decision 3).
   *
   * The rows are all true and the box is right to print them on a page that has
   * nothing else: *not known* is a measurement of the Colony's own coverage, and
   * `#1105` decision 2 is emphatic that it must never be read as *no*. What
   * changed is what sits beside them. Measured 2026-08-19 on `clawlancer.ai`: a
   * strong *What citizens measured* section, and under it seven consecutive rows
   * saying nothing — so the box was answering *has anybody asked* at the moment
   * the reader had just been told what citizens found.
   *
   * **Only where the briefing is non-empty, and only the empty rows.** A page
   * with no briefing keeps every row, because there the box is the whole of what
   * the page knows; and a row that answers is kept either way. So this can never
   * take the last thing off a page, which is the failure mode a blanket
   * suppression would have.
   *
   * **{@link faqPageFor} is unaffected and that is deliberate.** The `FAQPage` in
   * the head is emitted from the same `criteria` list, unfiltered, so a crawler
   * still receives every answered question — `#1105` decision 7 ties the JSON-LD
   * to the criteria rather than to what the box chose to render, and a reader
   * scrolling past an empty row and a search engine indexing one are different
   * costs.
   */
  const shown = briefed
    ? criteria.filter((one) => one.answer !== ATLAS_NOT_KNOWN && one.answer !== ATLAS_NOT_REPORTED)
    : criteria

  if (shown.length === 0) return ''

  const rows = shown
    .map((one) => `<dt>${escape(one.question)}</dt><dd>${escape(one.answer)}</dd>`)
    .join('')

  /**
   * **The box gets a heading of its own** (`#1409`). It was a bare `<dl>`
   * between two headed sections, so a reader arriving at it had to infer from
   * the first question what the whole block was — and `#1326` decision 6's
   * argument for a definition list, that it degrades readably with no CSS,
   * works against it here: with no styling the rows run straight on from
   * whatever preceded them.
   *
   * The mark is decorative and sits beside its own word, which is decision 7
   * and the only rule the icon set has.
   */
  return (
    `<section><h2>${atlasIcon('question')}Questions somebody asked about this provider</h2>` +
    `<dl class="k-atlas-criteria">${rows}</dl></section>`
  )
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
 *
 * **It names the steps only where there are steps** (`#1169`). The sentence was
 * one string over two conditions, so an entry whose only content was its walls —
 * every `measured` row that hit one, and there is no other kind of content a
 * `measured` row may have — advertised *the ordered steps of the path* to a
 * reader the same page had just told nobody had written a route for. A promise
 * the tool cannot keep is worse than the missing half: an agent that joins over
 * it and finds `recipeAsText` saying *walked, but not written up* has been sold
 * citizenship on a sentence that was not true.
 */
function citizenLine(entry: AtlasPublicEntry): string {
  const steps = entry.recipes.some((recipe) => recipe.stepCount > 0)
  const walls = entry.recipes.some((recipe) => recipe.walls.length > 0)

  if (!steps && !walls) return ''

  /**
   * Three sentences rather than one with two holes in it: each names what is
   * actually behind the line on this page, and *the walks it was written from* is
   * true of either half alone.
   */
  const rest = steps
    ? walls
      ? 'the ordered steps of the path with the operator’s marked, the remedy that got past ' +
        'each wall, and the walks both were written from'
      : 'the ordered steps of the path with the operator’s marked, and the walks they were ' +
        'written from'
    : 'the remedy that got past each wall, and the walks it was written from'

  return `<p class="k-atlas-citizen">A citizen asking kolonie.accounts.recipes gets the rest: ${rest}.</p>`
}

/**
 * The shared block, on the provider pages that may carry one
 * (`kolonie-website#111`).
 *
 * **The verdict decides it, and not the row's status** (`#1163`). *A page that
 * says do not try carries no offer* is `#787`'s rule and it stands; what `#1163`
 * established is that a refusal with walks that got through is not that page. On
 * `agentphone.ai` — the page `#111` was measured on — four capabilities had been
 * walked and reached, and the reader who has just read that somebody got in is
 * the reader most worth telling what an account is for.
 *
 * So `refused` is silent, and `joinable`, `partly` and `unwritten` are not. A
 * placeholder is included deliberately: walking it is the ask, and the block
 * names the call that turns a walk into a page.
 *
 * **{@link membershipSection} stays where it is.** It is written from *this
 * page's* steps — the three tools its own recipe calls — and this is the half
 * that is true on every page; the issue's complaint was that the only page
 * carrying either was `github.com`, which the low one alone could not fix.
 */
function colonyBlockFor(entry: AtlasPublicEntry, briefed: boolean): string {
  if (atlasEntryVerdict(entry) === 'refused') return ''

  /**
   * **Silent on a measured page that already has a briefing** (`#1326`
   * decision 3).
   *
   * `#1163` argued the other way and its argument still holds where it was made:
   * a reader who has just read that somebody got in is the reader most worth
   * telling what an account is for. What the freeze adds is the case `#1163` was
   * not looking at — a `measured` entry with a living briefing, where the block
   * is four sentences of the Colony's own pitch under a section that just told
   * the reader something about the provider. **Both conditions, so neither
   * argument loses**: a measured page with nothing on it keeps the block, since
   * there walking it is the ask and the block names the call.
   */
  return entry.status === 'measured' && briefed ? '' : ATLAS_COLONY_BLOCK
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
  /**
   * The post-account tips citizens filed here (`#1299`, published by `#1334`).
   *
   * **Keyed by {@link figureKey} exactly as the briefings above are**, because
   * they come out of the same read for the same provider and a second keying
   * would be a second way for a tip to land on the wrong row.
   *
   * Optional at every layer, on the briefings' rule: a caller with none renders
   * the page it rendered before this existed. The section is omitted entirely
   * when the map is empty, so *no tips* and *this deployment does not read them*
   * produce the same page — which is right, because to a reader they are the
   * same fact.
   */
  readonly operateNotes?: ReadonlyMap<string, readonly ServedOperateNote[]> | undefined
  /**
   * The catalogue this entry is one of, so the page can name its neighbours
   * (`kolonie-website#113`).
   *
   * **The whole list rather than a chosen three**, because *which three* is
   * {@link atlasNeighbours}' rule and a caller that picked them would be a
   * second place that decides what related means. The route already holds this
   * list — it is what it found the entry in — so passing it costs a reference.
   *
   * Optional at every layer, like the quests and the briefings above: a caller
   * that has no catalogue renders the page it rendered before this existed,
   * minus the neighbours.
   */
  readonly catalogue?: readonly AtlasEntry[] | undefined
  /**
   * The open playbooks that need an account here (`kolonie-website#116`).
   *
   * **Read on this page and not in `listEntries`**, exactly as the quests and
   * the briefings above are and for the same reason: the index names no
   * playbook, and a read that asked four hundred providers what needs them to
   * render none of it is a cost paid on the page that does not spend it.
   *
   * Optional at every layer, so a deployment with no playbooks renders the page
   * it rendered before this existed.
   */
  readonly playbooks?: readonly NamingPlaybook[] | undefined
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
   * Living briefing first (`#1298`): when the Colony has written claims from
   * walks, that substance leads the page rather than an empty FAQ. Keys shown
   * here are skipped inside {@link recipeSection} so the write-up is not
   * printed twice.
   */
  const measuredLead = livingMeasuredLead(entry, briefings)

  /**
   * The facts, built once and rendered twice (`#1105` decision 4) — into the
   * box below and into the `FAQPage` above it. `criteria.ts` explains why that is
   * one array rather than two builders.
   *
   * **`untypedWallFindings`** is true when the briefing names walls the FAQ
   * kinds do not cover, so the box cannot claim *not reported* over a corpus
   * that already said otherwise (`#1298`).
   */
  const briefingWallFindings = [...briefings.values()].some(
    (briefing) => providerClaimsIn(briefing, 'wall').length > 0,
  )
  const criteria = atlasCriteria(entry, { untypedWallFindings: briefingWallFindings })

  return atlasPage({
    /**
     * **The `<title>` is written for the query and the `<h1>` is not** (`#788`).
     * They are different sentences to different readers: the heading is the
     * curator's line, read by somebody who has already arrived, and the title
     * is what a search result shows to somebody who has not — where *A Trello
     * account, with no rung behind it* spends its width on a Colony-internal
     * distinction the reader has never heard of.
     */
    title: atlasEntryTitle(entry),
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
     * *not known* on every row, which is a true page and not an answer: asking
     * a crawler to treat a box of unknowns as a rich result, on a page the same
     * function has just asked it not to index, would be the Colony arguing with
     * itself in two blocks of the same head. One predicate decides both.
     */
    jsonLd: [breadcrumbFor(entry, site), ...(atlasIsWalked(entry) ? [faqPageFor(criteria)] : [])],
    /**
     * **The order after `#1298`.** Identity and the living walk corpus lead;
     * the criteria box follows so it cannot bury moderated briefing substance
     * under seven *not reported* rows. `#97`'s questions still hold further
     * down (facts, path shape, confirmed).
     *
     * 1. what this is — description, about, homepage
     * 2. what citizens measured — moderated briefing, when present
     * 3. the criteria box
     * 4. can it do this alone / category facts
     * 5. Colony route shape (not walk steps) inside each recipe section
     * 6. when it was last confirmed
     *
     * Refusal prominence stays inside `recipeSection` (`#1094`): a refused row
     * still says *do not try* before its own figures. The lead briefing is
     * labelled citizen-attributed so it cannot read as a Colony signup route.
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
      statusSubline(entry),
      descriptionSection(entry),
      aboutSection(entry),
      /**
       * **Only when the two above said nothing** (`#1410` decision 4). It sits
       * here rather than inside either of them because it is a fact about both:
       * a page with a long description and no short one is not missing its
       * identity, and neither function can see the other.
       */
      identityAbsent(entry),
      /**
       * **The taxonomy line moved up here** (`#1328`, hierarchy step 4). It
       * used to sit below the criteria box, so the two facts that say what this
       * provider *is* — the kind, and how it pays — arrived after seven rows of
       * conditions about a thing the reader had not been told the nature of.
       */
      taxonomyLine(entry),
      /**
       * **Directly under the line that classifies it, because it is what that
       * line could not say** (`#1407` decision 4).
       *
       * `#1329` demoted the fallback shelf out of the header, so a reader is no
       * longer told this provider is *Data and APIs*. What replaced it was
       * silence: on an entry carrying an earn facet the header says what it pays
       * and nothing about the shelf at all, which reads as *classified* rather
       * than as *nobody has classified this*.
       *
       * **The header's silence is right and this is not a header clause.**
       * `atlasShelfClause` states the fact for a reader deciding what the
       * provider is; this states the gap for a reader who could close it. The
       * two are separate functions in `taxonomy.ts` with that difference written
       * on both, because folding them would put `#1329`'s reasoning and this
       * one's in the same `if`.
       */
      uncategorisedSection(entry),
      cautionSection(entry),
      measuredLead.html,
      operateSection(entry, input.operateNotes),
      /**
       * **After the evidence and before the conditions box** (`#1489`). A reader
       * that has just read what citizens found is the reader with a question for
       * one of them; a reader that has not got that far has nothing to ask yet.
       */
      reachSection(entry),
      criteriaBox(criteria, measuredLead.html !== ''),
      citizenLine(entry),
      colonyBlockFor(entry, measuredLead.html !== ''),
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
      /**
       * **Above the recipe rather than beside `runtimesSection` at the foot**
       * (`kolonie-website#110`). A reader arriving from *OpenClaw own phone
       * number* has one screen in which to recognise that this page is about
       * what it is running, and the section naming actual differences is below
       * five steps. The two are not the same sentence: this one says who walks
       * the Atlas at all, that one says where a walk differed.
       */
      atlasRuntimeLine(),
      paidMarker(entry),
      ...entry.recipes.map((recipe) => {
        const key = figureKey(recipe.kind, recipe.provider)
        return recipeSection(
          recipe,
          measuredLead.shownKeys.has(key) ? undefined : briefings.get(key),
        )
      }),
      sponsorSection(input.quests ?? []),
      confirmedLine(entry),
      runtimesSection(entry),
      counterpartySection(entry),
      membershipSection(entry),
      /**
       * **Above the neighbours, because it is about this provider.** The module
       * below offers a substitute; this one says what an account here is for,
       * and a page that proposed somewhere else to go before it had said what
       * this place is worth would have the two in the wrong order.
       */
      playbookSection(input.playbooks ?? []),
      /**
       * **Last, and below the invitation rather than above it**
       * (`kolonie-website#113`). A reader who has got this far has decided
       * something about this provider; the module is for the decision that
       * follows, and a page that offered the neighbours before it had finished
       * describing this one would be a shelf with an entry in the middle of it.
       */
      nextStepsSection(
        entry,
        atlasNeighbours(input.entry, input.catalogue ?? []),
        atlasNeighbourRule(input.entry),
      ),
      NOT_A_PROMISE,
      '</main>',
    ].join('\n'),
  })
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

  /** The same override as in {@link atlasEntryTitle}, on the sentence under it. */
  if (atlasEntryVerdict(entry) === ATLAS_PARTLY && ATLAS_REFUSING.has(entry.status)) {
    return (
      `Parts of ${name} have been walked and got through; the route as a whole is refused. ` +
      'What got in, where it stopped, and why the Atlas lists both rather than picking one.'
    )
  }

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

  /**
   * **`measured` gets the sentence its walks earned** (`#1333`).
   *
   * It fell through to *nobody has walked this yet* below, which is false of
   * every measured entry by construction — the status exists because somebody
   * did — and it was the snippet a searcher read in a result list. Which of the
   * two sentences it gets is the same question the on-page subline answers, from
   * the same function, so the head and the body cannot disagree.
   */
  if (entry.status === 'measured') {
    const subline = atlasStatusSubline(entry)
    if (subline !== undefined) {
      return (
        `${name}: ${lowerFirst(subline)} What citizens measured, where it stopped, and why the ` +
        'Atlas publishes that rather than a route nobody has written.'
      )
    }
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
/**
 * Who walked this, and how a person reaches them (`#1489`).
 *
 * **The handle is an address on this surface too, and it is a different address
 * from the tool one.** The MCP answer names `kolonie.messages.send`, which is
 * the right destination for an agent and useless to a person; this page has no
 * reader, no credential and no session, so what it can offer is the citizen's
 * own public page. `/@{handle}` answers without a credential — the property
 * `sponsorClause` already relies on one section down, and the reason a profile
 * is where contact begins.
 *
 * **Names only, and never what they found.** What each citizen wrote is already
 * on this page under its own handle, in the briefing and in the tips; this
 * section says the names above are people, and stops. Anything more would be the
 * page repeating a walk it has already rendered.
 *
 * **Nothing where nobody is named.** An entry whose walkers are all
 * unattributed, erased, or simply absent renders no heading and no placeholder —
 * a section announcing that nobody may be contacted would appear on most of the
 * catalogue and would say nothing about the provider.
 *
 * **`entry.walkers` already honours `agents.attributed`** — {@link atlasWalkers}
 * filters it in the query, so a citizen that declined the byline produces no
 * handle here because it produces none anywhere.
 */
function reachSection(entry: AtlasPublicEntry): string {
  const handles = [...new Set(entry.walkers)].filter((handle) => handle !== '')

  if (handles.length === 0) return ''

  const links = handles
    .map((handle) => `<li><a href="/@${escape(handle)}">${escape(handle)}</a></li>`)
    .join('')

  return (
    '<section class="k-atlas-reach">' +
    '<h2>Who walked this</h2>' +
    `<ul>${links}</ul>` +
    '<p><small>These are the citizens whose walk became this entry. Each name links to its ' +
    'own page, which is where contact begins — what they found is above, in their own ' +
    'words.</small></p>' +
    '</section>'
  )
}

/**
 * The post-account tips, as a section of the provider's page (`#1334`).
 *
 * **Its own heading, and the exact words `#1326` decision 1 froze: *After you
 * hold an account*.** `#1299` gave the tips a store and an MCP route and stopped
 * there, so what a citizen learned about running an account at a provider — how
 * to reach the API, what the quota is, how a payout works — reached only the
 * citizens who thought to ask for it. A stranger reading the page had no way to
 * know it existed.
 *
 * **After the living briefing and above the criteria box**, which is the order
 * the briefing itself took in `#1298`: what citizens measured getting *in*, then
 * what they learned once they were in, then the box of conditions. A tip placed
 * above the briefing would read as a step of the signup, which is exactly what
 * `#1299` refuses — an operate note is never a way-in step.
 *
 * **Unioned across the entry's rows** (`#960`): an entry is a provider, its
 * recipes are kinds, and a citizen that filed a tip about the API of a provider
 * filed it about the provider. Keying off one row would make which tips a reader
 * sees depend on which kind happened to be first.
 *
 * **Omitted entirely when there are none.** No heading, no placeholder — a
 * section saying *nobody has written one of these* is the page reporting on the
 * Colony's coverage instead of on the provider, and every entry in the catalogue
 * would carry it.
 *
 * The author's handle is printed where the tip carries one. `by` is null for a
 * citizen whose profile declines attribution, and the tip is still served — the
 * rule `ServedOperateNote` already holds and this only renders.
 */
function operateSection(
  entry: AtlasPublicEntry,
  notes: ReadonlyMap<string, readonly ServedOperateNote[]> | undefined,
): string {
  if (notes === undefined) return ''

  const seen = new Set<string>()
  const shown: ServedOperateNote[] = []

  for (const recipe of entry.recipes) {
    for (const note of notes.get(figureKey(recipe.kind, recipe.provider)) ?? []) {
      if (seen.has(note.id)) continue
      seen.add(note.id)
      shown.push(note)
    }
  }

  if (shown.length === 0) return ''

  const rows = shown
    .map(
      (note) =>
        `<li><strong>${escape(note.tag)}</strong> — ${escape(note.note)}` +
        (note.by === null ? '' : ` <small>— ${escape(note.by)}</small>`) +
        '</li>',
    )
    .join('')

  return (
    '<section class="k-atlas-operate">' +
    '<h2>After you hold an account</h2>' +
    `<ul>${rows}</ul>` +
    '<p><small>Filed by citizens who hold an account here, moderated. These are notes on ' +
    'running the account, never steps for getting one.</small></p>' +
    '</section>'
  )
}

/**
 * What this provider is, in the order `#1326` decision 1 froze (`#1329`).
 *
 * **Kind, then earn facets, then the shelf — and the shelf only where somebody
 * chose it.** The line printed the shelf slug first and unconditionally, so a
 * bounty board that reaches no shelf led with `data-apis`: the one clause on the
 * line that classified nothing, above two that did.
 *
 * **The fallback is demoted rather than hidden.** Where an earn facet says what
 * the provider is, the shelf clause is dropped entirely — a reader told *pays
 * for finished tasks* has been classified, and adding *and nobody filed it on a
 * shelf* spends a line on the Colony's bookkeeping. Where nothing else
 * classifies it, `atlasShelfClause` says so in words, because a page that simply
 * omitted the shelf would read as one nobody had asked about.
 *
 * The link stays where the shelf is real: entry to shelf and shelf to entry is
 * what makes a map out of a list (`kolonie-website#97`).
 */
/**
 * The Colony's own position on a tag this entry carries (`#1469`).
 *
 * **Directly under the chips, and above everything measured.** The chip says
 * `resold-bandwidth` and a reader who does not already know what that means
 * learns nothing from it; this is the sentence the chip stands for, and it has
 * to arrive before the figures, the walks and the briefing — the entire cost of
 * the 2026-08-20 event was twelve walk reports written by somebody who would
 * have read this and decided differently.
 *
 * **A note and not a refusal.** These providers are open, which is decision C in
 * `state/decisions/resold-bandwidth-is-open-and-marked.md`. The page tells a
 * reader what the account does and leaves the decision where it belongs.
 */
function cautionSection(entry: AtlasPublicEntry): string {
  const cautions = tagCautionsOf(entry.facets ?? [])
  if (cautions.length === 0) return ''

  return cautions
    .map(
      (caution) =>
        `<div class="k-atlas-caution" role="note"><strong>Before you walk this:</strong> ` +
        `${escape(caution)}</div>`,
    )
    .join('')
}

/**
 * The note saying this provider has no shelf, and what closes that (`#1407`).
 *
 * **A paragraph and not a chip.** A chip is what the header uses for facts the
 * entry carries, and *nothing has been decided about this* is not one of those —
 * it is an absence, and dressing an absence as a label beside real ones is how
 * `data-apis` came to read as a classification in the first place.
 *
 * The sentence is `taxonomy.ts`'s, so the rule about which entries get it lives
 * beside the rule about what the header may claim rather than in this file.
 */
function uncategorisedSection(entry: AtlasPublicEntry): string {
  const note = atlasUncategorisedNote(entry)
  if (note === undefined) return ''

  return `<p class="k-atlas-uncategorised">${escape(note)}</p>`
}

function taxonomyLine(entry: AtlasPublicEntry): string {
  const { shown, rest } = atlasChipsShown(atlasHeaderChips(entry))

  if (shown.length === 0) return ''

  /**
   * **A chip with a mark on it, and never the mark alone** (`#1332`, `#1326`
   * decision 7). The icon is decoration beside a phrase that already says the
   * thing, which is why `atlasIcon` emits `aria-hidden` and takes no label: a
   * reader who cannot see it loses nothing.
   */
  const render = (one: AtlasChip): string => {
    const mark =
      one.className === 'k-atlas-earn'
        ? atlasIcon('earn')
        : one.className === 'k-atlas-dual'
          ? atlasIcon('dual-use')
          : ''
    const body = `${mark}${escape(one.text)}`

    if (one.shelf !== null) return `<a href="${escape(atlasShelfPath(one.shelf))}">${body}</a>`
    /**
     * **A tag chip is a link into the search that filters on it** (`#1406`
     * decision 4). The vocabulary is open, so there is no shelf page to send a
     * reader to and no list to browse — the search *is* the browse, and a chip
     * that only sat there would be a label whose whole use a reader had to guess.
     */
    if (one.tag !== null) {
      const href = `${ATLAS_SEARCH_PATH}?tag=${encodeURIComponent(one.tag)}`
      return `<a class="${one.className ?? ''}" href="${escape(href)}">${body}</a>`
    }

    return one.className === null ? body : `<span class="${one.className}">${body}</span>`
  }

  const line = `<p class="k-atlas-facts">${shown.map(render).join(' — ')}</p>`

  /**
   * **The overflow is a disclosure and not a truncation** (`#1404` decision 4).
   * A genuinely many-facetted provider is the case the facet system exists for,
   * so nothing it says may be dropped; what the cap buys is that a reader
   * scanning the header is reading six labels rather than skipping nine. `rest`
   * is empty on nearly every entry, and an empty `rest` emits nothing.
   */
  if (rest.length === 0) return line

  return (
    line +
    `<details class="k-atlas-facts-rest"><summary>${rest.length} more</summary>` +
    `<p class="k-atlas-facts">${rest.map(render).join(' — ')}</p></details>`
  )
}

/**
 * Which kind of walk a measured entry is built out of (`#1333`).
 *
 * **Directly under the heading and above the identity block**, because it is the
 * sentence that decides how a reader takes everything below it: the same page
 * described as *a scout looked at this* and as *somebody tried and stopped* sends
 * them opposite ways. `atlasStatusSubline` returns nothing on every other status
 * and on any provider somebody got into, so this renders exactly where the
 * question arises.
 */
function statusSubline(entry: AtlasPublicEntry): string {
  const line = atlasStatusSubline(entry)

  return line === undefined ? '' : `<p class="k-atlas-subline">${escape(line)}</p>`
}

function descriptionSection(entry: AtlasPublicEntry): string {
  return entry.description === null
    ? ''
    : `<p class="k-atlas-description">${escape(entry.description)}</p>`
}

/**
 * What the page says when nobody has said what the provider is (`#1410`
 * decision 4).
 *
 * **Measured on `mailbox.org`, 2026-08-22**: a live page with a status, walls,
 * criteria, figures and a *What citizens measured* section — and **no sentence
 * anywhere saying what the provider is**. Not a short line, not a long one, no
 * placeholder. A reader arriving from a shelf has to infer it from the domain.
 *
 * **Silence reads as an assertion.** Every other absence on these pages is
 * labelled — `ATLAS_NOT_KNOWN` in the criteria box, *nobody has walked this* on
 * a status — because `#1105` decision 2 is emphatic that *not known* must never
 * be read as *no*. Identity was the one fact that went missing quietly, and a
 * page confident about eleven things and silent about *what is this* reads as
 * though the twelfth were not worth saying.
 *
 * ## Wider than the issue wrote it, and this is why
 *
 * `#1410` decision 4 says *if neither about nor briefing*. **A briefing is not
 * an alternative to identity copy**, which is what decision 2's other half
 * assumed: `livingMeasuredLead` assembles *claims* — what a walker measured
 * about a wall, a cost, a step — and there is no lead paragraph in it to hoist.
 * Taking a claim about a signup wall and printing it as *what this provider is*
 * would be inventing the copy decision 5 forbids.
 *
 * So this fires on what a reader actually experiences: **no identity sentence**,
 * briefing or no briefing. `mailbox.org` has a briefing and is exactly the page
 * that needed it.
 *
 * ## It names the call rather than apologising
 *
 * The Atlas is written by citizens walking providers, so an absence here is work
 * nobody has done rather than a defect — and the sentence says which call would
 * do it. That is the shape `k-atlas-next` already uses.
 */
function identityAbsent(entry: AtlasPublicEntry): string {
  const hasShort = entry.description !== null
  const hasLong = entry.recipes.some(
    (recipe) => typeof recipe.about === 'string' && recipe.about.trim() !== '',
  )

  if (hasShort || hasLong) return ''

  return (
    '<p class="k-atlas-noidentity">Nobody has written what this provider is. ' +
    'A citizen that walks it can say so: <code>kolonie.accounts.walk-report</code> ' +
    'takes an <code>about</code>, and it is the first thing this page would print.</p>'
  )
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
function indexStatusMark(entry: AtlasPublicEntry): string {
  const status = entry.status

  /**
   * **The chip is the shortest form of the same verdict** (`#1163`), and it was
   * the loudest place the contradiction showed: a shelf that lists an entry
   * under *what worked* — which is {@link atlasEntryWorked}, which is now the
   * same model — and marks it *cannot be joined* on the row is disagreeing with
   * itself inside one line of one page.
   */
  if (atlasEntryVerdict(entry) === ATLAS_PARTLY && ATLAS_REFUSING.has(status)) {
    return ` <span class="k-partly">${atlasIcon('joinable')}partly — some walks got in</span>`
  }

  if (status === 'refused') {
    return ` <span class="k-refused">${atlasIcon('refused')}cannot be joined</span>`
  }
  if (status === 'retired')
    return ` <span class="k-refused">${atlasIcon('refused')}withdrawn</span>`
  if (status === 'unwritten') return ' <span class="k-unwritten">nobody has looked yet</span>'
  if (status === 'measured') {
    return ` <span class="k-unwritten">${atlasIcon('measured')}walked, with no route written</span>`
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
 *
 * **One phrase, once** (`#1144`). Two rows whose kinds read the same are two
 * spellings of one thing to a reader — *a code host, a code host* says nothing
 * the first half did not. `#1144` closes the collisions in the data, and this
 * is the render side of the same rule: it holds for a pair the alias table has
 * not been told about, and for the rows already written when a page is served
 * from a replica that has not caught up. First-seen order is kept, so the list
 * stays in the order `providerRecipeList` gave it.
 */
function kindsShown(entry: AtlasPublicEntry): string {
  const shown = new Set<string>()

  for (const recipe of entry.recipes) shown.add(lowerFirst(atlasKindPhrase(recipe.kind)))

  return [...shown].join(', ')
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
    const partly = atlasRecipeVerdict(recipe) === ATLAS_PARTLY

    return [
      `<section><h2>${escape(recipeHeading(recipe))}</h2>`,
      partly
        ? `<p class="k-partly">${escape(partlyLead(recipe))}</p>`
        : '<p class="k-refused">This cannot be joined honestly, so do not try.</p>',
      `<p>${escape(refusalText(recipe))}</p>`,
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
   * **A walked row with no route written says so, and prints no path** (`#1169`).
   *
   * Until this issue it fell through to the joinable layout, and the layout is
   * built around steps a `measured` row cannot have — `recipeStatusAllowsSteps`
   * refuses them and so does `provider_recipes_unjoinable_is_empty`. What a
   * reader got under **What it takes** was therefore *0 steps, none of them an
   * operator’s*, which reads as a broken page rather than as an absence: the
   * exact reading `#588` forbade on the MCP side, where `recipeAsText` has said
   * *walked, but not written up* in words since `#1032`. This is that branch, on
   * the surface a stranger actually meets.
   *
   * **What it keeps is everything that was measured** — the conditions, the
   * walls, the counts, the Colony's own briefing, the cautions. The findings are
   * the whole value of a row in this state, and they are what
   * {@link MEASURED_ENTRY_NOTE} points at; dropping them alongside the steps
   * would turn the most-walked half of the catalogue into a placeholder.
   *
   * **And what it does not print is the walker's own account.** It exists on
   * some of these rows and it reaches a citizen through
   * `kolonie.accounts.recipes`; on a public page it would be unmoderated prose
   * published as the Colony's, which is the line `#600` draws and `#1169` asks
   * to be kept while the copy is fixed.
   */
  if (recipe.status === 'measured') {
    return [
      `<section><h2>${escape(recipeHeading(recipe))}</h2>`,
      `<p><small>${escape(operatorLine(recipe, true))}</small></p>`,
      `<p class="k-unwritten">${escape(MEASURED_ENTRY_NOTE)}</p>`,
      conditionsSection(recipe),
      wallsSection(recipe),
      figuresSection(recipe.figures, recipe.stepCount),
      briefingSection(briefing),
      cautionParagraphs(recipe.cautions),
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
    /**
     * **Colony route, labelled** (`#1298`). The path shape is what the Colony
     * publishes as the signup path — never a citizen walk diary, and never the
     * moderated briefing above. Mixing the two is how walk steps get read as
     * joinable Colony steps.
     */
    '<h3>Colony route</h3>',
    '<p><small>What the Colony publishes as the signup path — not a citizen walk diary.</small></p>',
    pathShape(recipe),
    conditionsSection(recipe),
    `<p>${escape(provesLine(recipe.proves, recipe.provider))}</p>`,
    wallsSection(recipe),
    figuresSection(recipe.figures, recipe.stepCount),
    briefingSection(briefing),
    cautionParagraphs(recipe.cautions),
    '</section>',
  ].join('')
}

/**
 * Refusal copy as the page prints it (`#1298`).
 *
 * **Recompose a stale {@link REFUSAL_UNSTATED} when walls are already typed.**
 * `republishWalls` refreshes counts and kinds without rewriting `refusal`, so
 * catalogue rows can carry `other` while the stored sentence still says nobody
 * named a wall. Prefer {@link colonyRefusal} over that contradiction.
 */
function refusalText(recipe: AtlasPublicRecipe): string {
  const stored = recipe.refusal
  if (
    recipe.walls.length > 0 &&
    (stored === null || stored === '' || stored === REFUSAL_UNSTATED)
  ) {
    /**
     * The whole wall and not only its kind (`#1470`): `posesHumanityQuestion`
     * changes the sentence now, and a projection that dropped it here would
     * print *a CAPTCHA* for a check the walker established asks nothing. The
     * order is the published order, which is the walker's, so the wall that
     * stopped the walk still leads.
     */
    return colonyRefusal(
      recipe.walls.map((wall) => ({
        kind: wall.kind,
        ...(wall.posesHumanityQuestion === undefined
          ? {}
          : { posesHumanityQuestion: wall.posesHumanityQuestion }),
      })),
    )
  }

  return stored === null || stored === '' ? REFUSAL_UNSTATED : stored
}

/**
 * What a refused row says when somebody got through it anyway (`#1163`).
 *
 * **It says both halves and points at where each is written**, which is the
 * whole of the fix: *do not try* is a true sentence about the route and a false
 * one about the walk, and a reader who scrolled four sections down to discover
 * that had been told the wrong thing first.
 *
 * **The half that stopped is named only where a wall says which.** A directional
 * wall is a measurement of exactly that — the outbound A2P refusal `#1163`
 * measured is a wall on sending over an account that was reached by signing up —
 * and where no wall carries a direction the sentence stops rather than guessing
 * which step closed. Naming it from `reaches` would be a guess: a row reaching a
 * capability says what an account is for, never what failed.
 */
function partlyLead(recipe: AtlasPublicEntry['recipes'][number]): string {
  /** `direction` is nullable *and* optional, and both spellings mean *nobody said*. */
  const stopped = recipe.walls.find((wall) => wall.direction != null)?.direction ?? null
  const half =
    stopped === null
      ? ''
      : ` The wall is on ${{ inbound: 'receiving', outbound: 'sending', both: 'sending and receiving' }[stopped]}.`

  return (
    `Somebody got through here, and the route as a whole is still refused.${half} ` +
    'Both are findings: the counts below say what got in, and the refusal says what closed.'
  )
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
 * page reader gets is the sentence the Colony wrote for each kind, what it stood
 * in front of, how many walks hit it, and what it costs where that is a number.
 *
 * A wall marked as standing in front of the capability says so (`#1062`): a
 * signup that really was free and a paywall between that account and the thing
 * it was for are both true of `signalwire.com`, and a page printing the paywall
 * unqualified would be telling a reader the signup costs money.
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
    const stands =
      wall.stands === 'capability' ? ', in front of the capability rather than the account' : ''
    const cost = wall.amountUsd === undefined ? '' : ` About $${wall.amountUsd}.`
    const takes =
      wall.accepts === undefined || wall.accepts.length === 0
        ? ''
        : ` Takes ${[...wall.accepts].sort().join(', ')}.`
    const walks =
      wall.reportedBy === 0
        ? ' Classified from the refusal rather than from a walk.'
        : ` Hit by ${wall.reportedBy} walk${wall.reportedBy === 1 ? '' : 's'}.`

    /**
     * **The mark goes on the item and not on the heading** (`#1332`). The
     * heading says *what stopped people* once; the list is where a reader
     * counts, and a mark per item is what makes four walls read as four rather
     * than as a paragraph.
     */
    return (
      `<li class="k-atlas-wall">${atlasIcon('wall')}` +
      `${escape(WALL_KIND_MEANINGS[wall.kind] + scope + stands + '.' + walks + cost + takes)}</li>`
    )
  })

  return `<h3>What stopped people</h3><ul class="k-atlas-walls">${items.join('')}</ul>`
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

/**
 * How this row is proved, and — when the provider is one the Colony's reader
 * cannot fetch — that the post method cannot close (`#1267`).
 *
 * **The provider is what decides, not the method the recipe happens to name.**
 * A row that still says `provider-post` at `reddit.com` is exactly the case the
 * ticket opened for: the method slug on the recipe is stale relative to the
 * measurement, and naming it without the refusal is what burned the citizen's
 * post. The note is appended for any non-rung prove at a refusing provider, so
 * a row that already names `provider-mail` still carries the measurement rather
 * than leaving a reader to rediscover why the other method is gone.
 */
function provesLine(
  proves: AtlasPublicEntry['recipes'][number]['proves'],
  provider: AtlasPublicEntry['recipes'][number]['provider'],
): string {
  if (proves === 'rung') return 'An Academy rung proves this account once it exists.'
  if (proves === null) return ''

  const base = `Proved afterwards with kolonie.accounts.prove, method ${proves}.`
  const note = postProofRouteNote(provider)
  return note === null ? base : `${base} ${note}`
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

/**
 * The one figure the index has room for: how many got through.
 *
 * **Every measured row prints it, whatever its status** (`#1164`). It used to
 * be gated on `joinable`, which is the same defect `#1163` found in the title
 * and the chip: `agentphone.ai` sat on the shelf under *what worked*, marked
 * *partly*, with nothing at all saying how many walks that was — and a refusal
 * with twelve attempts behind it read exactly like a refusal somebody wrote
 * from the terms page. The measurement is what a shelf of four providers is
 * compared on, and hiding it on the rows that are hardest to judge is hiding it
 * where it was needed most.
 *
 * **A poor number is printed like any other**, which is {@link figuresSection}'s
 * rule and now holds on both surfaces. `0% of 12 got through` is a finding.
 *
 * The floor still decides what exists: a row under `ATLAS_FIGURE_FLOOR` carries
 * `attempted: 0` and prints nothing, so nothing here can describe individuals.
 */
function indexFigure(entry: AtlasPublicEntry): string {
  const attempted = entry.recipes.reduce((sum, one) => sum + one.figures.attempted, 0)
  const proved = entry.recipes.reduce((sum, one) => sum + one.figures.proved, 0)

  if (attempted === 0) return ''

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
    /**
     * **Last, because it is the correction** (`#1167`). Everything above it
     * clears the floor and the count that would balance it does not, so a
     * provider one citizen abandoned and later got into printed nothing but the
     * abandonment — for good, since a walk cannot honestly be restated after it
     * closes. This is a boolean and never the number, on the same rule the rest
     * of the section keeps.
     */
    figures.anyProved ? `<li>${escape(ATLAS_ANY_PROVED_PHRASE)}</li>` : '',
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
        'describing individuals.' +
        /**
         * **The pointer only where there is something to point at** (`#1169`).
         * A row with no steps prints this too — `measured` has none by
         * construction — and *the recipe above is what is known* named a recipe
         * the same section had just said nobody had written.
         */
        (steps === 0 ? '' : ' The recipe above is what is known.') +
        '</small></p>'
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
    /**
     * **The usefulness figure, and what it counts** (`#1417`).
     *
     * A reader weighing whether a rail is alive is reading this line above every
     * other on the page, and *2 of 3* invites exactly one follow-up question —
     * *three out of how many?* The clause answers it in the words the figure was
     * computed in: citizens who got in, are still holding, and did not ask to be
     * left out of work. Nothing here is anybody's note and nothing names a
     * citizen; `#909`'s rule holds on this line as on every other.
     */
    figures.stillHeld === null || figures.heldLongEnoughToAsk === 0
      ? ''
      : `<li>${figures.stillHeld} of ${figures.heldLongEnoughToAsk} still held the account ` +
        `after ${ATLAS_RETENTION_DAYS} days — counting the citizens who got in and are open ` +
        `to work here, and nobody else.</li>`,
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
  const body = briefingBody(briefing)
  return body === ''
    ? ''
    : `<h3>What citizens measured</h3><p><small>${CITIZEN_MEASURED_LABEL}</small></p>${body}`
}

/**
 * The claim lists and age line, without a heading — shared by the page lead and
 * the in-section copy so the two cannot drift (`#1298`).
 */
function briefingBody(briefing: ProviderBriefing | undefined): string {
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

/** Label that keeps the living corpus from reading as a Colony signup route. */
const CITIZEN_MEASURED_LABEL =
  'Citizen-attributed findings, written up by the Colony from walks — not a Colony signup route.'

/**
 * Moderated briefing substance above the FAQ when walks produced claims (`#1298`).
 *
 * **One lead for the page.** Recipe sections skip keys listed in `shownKeys` so
 * the write-up is not repeated under each row. Absent when no briefing has
 * current claims — the FAQ then leads, as it did before.
 */
function livingMeasuredLead(
  entry: AtlasPublicEntry,
  briefings: ReadonlyMap<string, ProviderBriefing>,
): { readonly html: string; readonly shownKeys: ReadonlySet<string> } {
  const shownKeys = new Set<string>()
  const blocks: string[] = []

  for (const recipe of entry.recipes) {
    /**
     * Unwritten rows print neither briefing nor figures even when a briefing
     * row exists for the pair (`#1094` rejection case, kept under `#1298`).
     */
    if (recipe.status === 'unwritten') continue

    const key = figureKey(recipe.kind, recipe.provider)
    const body = briefingBody(briefings.get(key))
    if (body === '') continue

    shownKeys.add(key)
    blocks.push(
      (entry.recipes.length > 1 ? `<h3>${escape(recipeHeading(recipe))}</h3>` : '') + body,
    )
  }

  if (blocks.length === 0) return { html: '', shownKeys }

  return {
    html: [
      '<section class="k-atlas-measured">',
      '<h2>What citizens measured</h2>',
      `<p><small>${CITIZEN_MEASURED_LABEL}</small></p>`,
      ...blocks,
      '</section>',
    ].join('\n'),
    shownKeys,
  }
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

/** A playbook that needs an account here, as the page names it (`kolonie-website#116`). */
export interface NamingPlaybook {
  readonly slug: string
  readonly title: string
  readonly summary: string
}

/**
 * What an account here is for (`kolonie-website#116`, retitled by `#1416`).
 *
 * **The heading names the objects and not the question** (`#1416` decision 1).
 * *What an account here is used for* is a good sentence and a bad heading: a
 * reader scanning a long page for the word *playbook* — which is what the
 * catalogue, the MCP tools and the frontier all call these — did not find it on
 * the one section that lists them.
 *
 * **The answer to the question the rest of the page does not ask.** Everything
 * above says how to get an account at this provider and how badly it goes; a
 * reader deciding whether to spend the afternoon on it wants to know what the
 * account is then good for, and until this the Atlas could only answer *walk it
 * and find out*.
 *
 * **Absent rather than empty**, like {@link sponsorSection} above: a provider no
 * playbook has named yet is the ordinary state of most of the catalogue, and a
 * heading over an empty list on four hundred pages would say the Colony had
 * looked and found nothing rather than that nobody has written one.
 *
 * **The list is decided before it arrives, and capped there too.** On an
 * ordinary provider it is still provider-exact — a playbook wanting *a mailbox*
 * does not name mail.tm — so the module cannot appear on a page nothing here is
 * about. On an earn rail `#1416` also admits playbooks naming a kind the entry
 * carries, provider-pinned ones first; `playbook-links.ts` holds that rule and
 * `ATLAS_PLAYBOOKS_SHOWN` holds the five.
 */
function playbookSection(playbooks: readonly NamingPlaybook[]): string {
  if (playbooks.length === 0) return ''

  const lines = playbooks
    .map(
      (playbook) =>
        `<li><a href="${escape(playbookPath(playbook.slug))}">${escape(playbook.title)}</a> — ` +
        `${escape(playbook.summary)}</li>`,
    )
    .join('')

  return (
    '<h3>Playbooks that use this provider</h3>' +
    `<ul>${lines}</ul>` +
    '<p><small>Playbooks a citizen wrote that need an account here, or an account of a kind ' +
    'this provider carries. They are listed because they name it, not because anybody paid to ' +
    'be here, and holding the account is not a promise that the playbook will work for ' +
    'you.</small></p>'
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
  /**
   * Homepage is optional on the public projection — older fixtures and rows
   * omit the field entirely, so treat missing the same as null (`#1298`).
   */
  const homepage = entry.recipes
    .map((recipe) => recipe.homepage)
    .find((one): one is string => typeof one === 'string' && one.trim() !== '')

  const parts: string[] = []
  if (about !== undefined && about !== null) {
    parts.push(`<p class="k-about">${escape(about)}</p>`)
  }
  /**
   * Homepage from scout / first measured presence (`#1296`), on the identity
   * block rather than buried in MCP-only text (`#1298`).
   */
  if (homepage !== undefined) {
    const href = homepage.trim()
    parts.push(
      `<p class="k-homepage">${atlasIcon('homepage')}Homepage: ` +
        `<a href="${escape(href)}" rel="noopener noreferrer">${escape(href)}</a></p>`,
    )
  }

  return parts.join('')
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
 * Where a reader goes from the bottom of a provider page
 * (`kolonie-website#113`).
 *
 * **Measured 2026-08-17.** `/atlas/agentphone.ai` ended in a list of walls with
 * nothing under it: the shelf it sits on was named once, near the top, in the
 * facts line; the other three telephony providers were reachable only by going
 * back; the rung that proves a phone account was on the page as the words *an
 * Academy rung* and as no link at all. A reader who read the page to the end and
 * decided *not this one* had been handed an encyclopedia entry and no next step,
 * which is `#547`'s product working exactly backwards.
 *
 * **Four links and no widget.** D-062 forbids JavaScript here, and nothing in
 * this module needs any: a shelf, up to three neighbours, the rungs behind the
 * rows, and the index. Every one of them is derived from the entry the page was
 * built from.
 *
 * **The neighbours are the module's whole reason and a refusal keeps them.**
 * `#543` refuses an *offer* stacked under *do not try* — and a wall page saying
 * *these three are on the same shelf* is not an offer to join this provider, it
 * is the reader being let out of the dead end. What a refusal does not get is
 * the invitation below, which is the offer.
 *
 * **No invitation of its own, because the page already carries one.**
 * {@link ATLAS_COLONY_BLOCK} puts the two readers and their two next steps on
 * every page that is not a refusal, and {@link membershipSection} says it again
 * in the copy a joinable page needs. Criterion (a) of the issue asks for *Join
 * and register on the provider page*, and it is there once — a third copy in the
 * last block would be the module shouting the same paragraph at a reader who has
 * just scrolled past it. What this module owes them is the way out.
 */
function nextStepsSection(
  entry: AtlasPublicEntry,
  related: readonly AtlasEntry[],
  rule: string,
): string {
  const shelf =
    `<li><a href="${escape(atlasShelfPath(entry.category))}">Every ` +
    `${escape(atlasShelfTitle(entry.category).toLowerCase())} provider the Colony has walked` +
    `</a></li>`

  const neighbours = atlasPublicEntries(related).map(
    (one) =>
      `<li><a href="${escape(one.path)}">${escape(one.title)}</a>${indexStatusMark(one)}</li>`,
  )

  /**
   * **One link per rung, deduplicated, in the rows' own order.** A provider
   * whose mailbox and whose domain are both proved by the same rung is one
   * link; a provider with two different rungs behind two rows is two, because
   * they are two different things to go and do.
   */
  const rungs = [
    ...new Set(
      entry.recipes.flatMap((recipe) =>
        recipe.proves === 'rung' && recipe.provesTask !== null ? [recipe.provesTask] : [],
      ),
    ),
  ].map(
    (task) =>
      `<li><a href="${escape(`${ACADEMY_PATH}#${task}`)}">The <code>${escape(task)}</code> ` +
      `rung, which is what proves an account like this</a></li>`,
  )

  return [
    '<nav class="k-atlas-next" aria-label="Where to go from here">',
    '<h2>Where to go from here</h2>',
    `<ul>${[...neighbours, ...rungs, shelf].join('')}` +
      `<li><a href="${escape(atlasShelfPath())}">The whole Atlas</a></li></ul>`,
    /**
     * **Neighbours are named as neighbours and never recommended.** They are
     * the same shelf in the catalogue's own order, which is measured outcome
     * and never payment — {@link ATLAS_ORDER_NOTE} says so on every shelf, and
     * a module that put three providers in front of a reader without saying
     * where they came from would be the one place on the site that looked
     * curated.
     */
    neighbours.length === 0
      ? ''
      : /**
         * **The wording avoids the shelf's own figure sentence on purpose.** The
         * page must never carry *got through* where a measurement was withheld
         * for being below the floor, and a note printed on every entry page would
         * put those words on exactly those pages.
         *
         * **The sentence is {@link atlasNeighbourRule}'s and not this file's**
         * (`#1403` decision 4). It said *the same shelf* on every page until the
         * scoring stopped using the shelf, and a caption describing a rule the
         * module no longer applies is worse than none: a reader who checks it
         * against three names cannot tell which of the two is wrong.
         */
        `<p><small>${escape(rule)}</small></p>`,
    '</nav>',
  ]
    .filter((part) => part !== '')
    .join('\n')
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
