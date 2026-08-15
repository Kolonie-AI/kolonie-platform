import {
  ATLAS_PATH,
  atlasCapabilityPhrase,
  atlasIsWalked,
  atlasKindPhrase,
  atlasShelfTitle,
  RETIRED_ENTRY_NOTE,
  stepInstruction,
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
  type AtlasCategory,
  type AtlasEntry,
  type AtlasFigures,
  type ProviderBriefing,
  type ServedProviderBriefingClaim,
} from '@kolonie-ai/core'
import { escape } from '../console/html.js'
import { breadcrumbFor, howToFor, itemListFor } from './structured-data.js'
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

export function atlasIndexPath(category?: AtlasCategory): string {
  return category === undefined ? ATLAS_PATH : `${ATLAS_PATH}?category=${category}`
}

/**
 * The index: every entry, on a shelf per category (`#588`, `#589`,
 * `kolonie-website#97`).
 *
 * **Filtering is a link and never a widget** — `?category=mailbox`, D-062, the
 * same decision the console's browser took in `#591`. `#97` requires it to work
 * with no JavaScript, and the cheapest way to satisfy that is for there to be
 * no JavaScript to fail.
 *
 * **A filtered index is the same page with one shelf**, not a second template.
 * The heading, the standfirst and the ordering note are what a reader arriving
 * on a shared `?category=` link needs as much as anybody else, and a filtered
 * view that dropped them would be a page that assumes the reader came from the
 * unfiltered one.
 */
export function atlasIndexPage(input: {
  readonly entries: readonly AtlasEntry[]
  readonly canonical: string
  readonly chrome?: SiteChrome | undefined
  /** The shelf a reader asked for, when they asked for one. */
  readonly category?: AtlasCategory | undefined
}): string {
  const { category } = input
  const shown =
    category === undefined
      ? input.entries
      : input.entries.filter((entry) => entry.category === category)

  return atlasPage({
    /**
     * **The filtered index is titled for the search that finds it** (`#788`).
     * `The Atlas — mailbox` names our own filter and our own slug, neither of
     * which anybody types into a search box; the shelf title plus what the
     * shelf is for names the thing a reader was looking for. Unfiltered stays
     * `The Atlas`, which is what the whole catalogue is called.
     */
    title:
      category === undefined
        ? 'The Atlas'
        : `${atlasShelfTitle(category)} an AI agent can sign up for`,
    description: ATLAS_STANDFIRST,
    canonical: input.canonical,
    chrome: input.chrome,
    /**
     * **The list it rendered, in the order it rendered it** (`#789`). `shown`
     * and not `entries`: a filtered index is a different list, and an `ItemList`
     * naming entries the page does not show would be the markup contradicting
     * the page it is attached to.
     */
    jsonLd: [itemListFor(shown, siteOf(input.canonical), category)],
    body: [
      '<main>',
      '<h1>The Atlas</h1>',
      `<p>${escape(ATLAS_STANDFIRST)}</p>`,
      ATLAS_JOIN_LINE,
      `<p><small>${escape(ATLAS_ORDER_NOTE)}</small></p>`,
      shelfNav(input.entries, category),
      input.entries.length === 0
        ? '<p>The catalogue is empty. Nothing has been listed yet, which is not the same as ' +
          'nothing being joinable.</p>'
        : category !== undefined && shown.length === 0
          ? `<p>Nothing is filed under ${escape(category)} yet. That is a shelf waiting to be ` +
            'filled rather than a category the Colony refuses — every entry on it would be one ' +
            'somebody walked.</p>'
          : shelves(shown).join('\n'),
      '</main>',
    ].join('\n'),
  })
}

/**
 * The shelves, as links, with what is on each (`kolonie-website#97`).
 *
 * **The count is derived and never typed** — `#97` is explicit that *ninety-six
 * providers* ages on the next curation, and the same is true one shelf down.
 *
 * **It is built from the entries and not from `AtlasCategorySchema`.** Fourteen
 * headings over three entries would say the Atlas has eleven holes in it, when
 * what it has is eleven categories nothing has been filed under yet. That is
 * `shelves`' argument below, one level up.
 *
 * The current shelf is marked with `aria-current` rather than only styled: it is
 * what a screen reader announces, and a colour that said the same thing would
 * say it to one reader in two.
 */
function shelfNav(entries: readonly AtlasEntry[], current: AtlasCategory | undefined): string {
  if (entries.length === 0) return ''

  const counts = new Map<string, number>()
  for (const entry of entries) counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1)

  const links = [...counts.entries()].map(
    ([category, count]) =>
      `<li><a href="${escape(atlasIndexPath(category as AtlasCategory))}"` +
      `${category === current ? ' aria-current="page"' : ''}>` +
      `${escape(atlasShelfTitle(category))}</a> ` +
      `<span class="k-atlas-count">${count}</span></li>`,
  )

  return [
    '<nav class="k-atlas-shelves" aria-label="Categories">',
    `<ul>${links.join('')}</ul>`,
    current === undefined ? '' : `<p><a href="${escape(atlasIndexPath())}">Every category</a></p>`,
    '</nav>',
  ]
    .filter((line) => line !== '')
    .join('')
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
function shelves(entries: readonly AtlasEntry[]): readonly string[] {
  const byCategory = new Map<string, AtlasEntry[]>()

  for (const entry of entries) {
    const held = byCategory.get(entry.category)
    if (held === undefined) byCategory.set(entry.category, [entry])
    else held.push(entry)
  }

  return [...byCategory.entries()].map(
    ([category, shelf]) =>
      /**
       * **The slug stays where it is an address** (`#791`): the fragment `id`
       * a link elsewhere targets, and the `?category=` the link itself
       * carries. Only what a reader sees is the shelf title.
       */
      `<h2 id="${escape(category)}"><a href="${escape(
        atlasIndexPath(category as AtlasCategory),
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

function indexRow(entry: AtlasEntry): string {
  return (
    `<li><a href="${escape(entry.path)}">${escape(entry.title)}</a>` +
    indexStatusMark(entry.status) +
    (entry.recipes.some((recipe) => recipe.paid) ? ' <span class="k-paid">paid</span>' : '') +
    `<br><small>${escape(kindsShown(entry))}${escape(indexFigure(entry))} — ` +
    `${escape(operatorLine(entry))}</small></li>`
  )
}

/**
 * Who has to be there, on the row rather than inside the page (`#589`).
 *
 * **The one fact that decides whether a reader has to volunteer an afternoon**,
 * and until now it was only discoverable by opening an entry and reading its
 * steps. A guess says it is a guess: an operator told *not needed* about a
 * provider nobody has walked will find out otherwise at the worst moment.
 */
function operatorLine(entry: {
  readonly operatorNeed: AtlasEntry['operatorNeed']
  readonly operatorNeedIsGuess: boolean
}): string {
  const said = {
    unaided: 'an agent can do this alone',
    'operator-needed': 'needs a person at one step',
    unknown: 'nobody has walked this, so who is needed is not known',
  }[entry.operatorNeed]

  return entry.operatorNeedIsGuess ? `${said} (a guess, not a walk)` : said
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
  const { entry } = input
  const briefings = input.briefings ?? new Map<string, ProviderBriefing>()

  const site = siteOf(input.canonical)

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
    description: entryDescription(entry),
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
     * **The breadcrumb on every state and the `HowTo` only where there are
     * steps** (`#789`). A refused or unwritten entry is still a place in the map
     * and still worth a trail; it is not a set of instructions, and an empty
     * `HowTo` would be the catalogue pretending.
     */
    jsonLd: [breadcrumbFor(entry, site), ...howToFor(entry)],
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
      `<h1>${escape(entry.title)}</h1>`,
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
      `<p class="k-atlas-facts"><a href="${escape(atlasIndexPath(entry.category))}">${escape(
        entry.category,
      )}</a> — ${escape(operatorLine(entry))}</p>`,
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
function providerName(entry: AtlasEntry): string {
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
function entryTitle(entry: AtlasEntry): string {
  const name = providerName(entry)

  if (entry.status === 'refused') return `${name}: why an agent cannot join it`
  if (entry.status === 'retired') return `${name}: withdrawn, and what the path was`
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
function entryDescription(entry: AtlasEntry): string {
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
  const steps = joinable.reduce((sum, one) => sum + one.steps.length, 0)
  const byHand = joinable.reduce(
    (sum, one) => sum + one.steps.filter((step) => step.actor === 'operator').length,
    0,
  )
  const proves = [...new Set(joinable.map((one) => one.proves).filter((one) => one !== null))]
  const walked = lastConfirmed(entry)

  const clauses = [
    steps === 0 ? '' : `${steps} step${steps === 1 ? '' : 's'}`,
    /**
     * The count where there are operator steps to count, and the entry's own
     * rolled-up answer where there are none — which is not the same as *nobody
     * is needed*, because a row nobody has walked cannot say that.
     */
    byHand === 0 ? operatorLine(entry) : `${byHand} of them need${byHand === 1 ? 's' : ''} a human`,
    proves.length === 0 ? '' : proves.map((one) => PROOF_PHRASES[one] ?? `proved with ${one}`)[0],
  ].filter((clause) => clause !== '')

  return (
    `${clauses.join(', ')}.` +
    (walked === undefined ? '' : ` Last confirmed ${walked.slice(0, 10)}.`)
  )
}

/** The most recent walk across an entry's rows, which is what a reader wants dated. */
function lastConfirmed(entry: AtlasEntry): string | undefined {
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
 * `proposed` and `draft` cannot reach this function: nothing public reads them
 * (`recipeStatusIsPublic`). The `draft` branch exists anyway, because a state
 * with no branch here would render as a working recipe if it ever did — and a
 * silent default is exactly how the next state added arrives on the index
 * pretending to be joinable.
 */
function indexStatusMark(status: AtlasEntry['status']): string {
  if (status === 'refused') return ' <span class="k-refused">cannot be joined</span>'
  if (status === 'retired') return ' <span class="k-refused">withdrawn</span>'
  if (status === 'unwritten') return ' <span class="k-unwritten">nobody has looked yet</span>'
  if (status === 'draft' || status === 'proposed') {
    return ' <span class="k-unwritten">not published yet</span>'
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
function kindsShown(entry: AtlasEntry): string {
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
function recipeHeading(recipe: AtlasEntry['recipes'][number]): string {
  const label = recipe.provider.split('.')[0]

  return recipe.kind === label ? `An account at ${recipe.provider}` : atlasKindPhrase(recipe.kind)
}

/** One row of the catalogue, as a section of its provider's page. */
function recipeSection(
  recipe: AtlasEntry['recipes'][number],
  /**
   * What the Colony wrote up about this row's walks, if it has (`#831`).
   *
   * **Rendered exactly where the figures are and nowhere else.** The three
   * states that return early below print no figures either — there is nothing
   * measured about a provider nobody walked, and a refusal is a sentence rather
   * than a set of findings — and a briefing appearing on a row whose counts do
   * not would be the page contradicting its own layout.
   */
  briefing: ProviderBriefing | undefined,
): string {
  if (recipe.status === 'refused') {
    return [
      `<section><h2>${escape(recipeHeading(recipe))}</h2>`,
      '<p class="k-refused">This cannot be joined honestly, so do not try.</p>',
      `<p>${escape(recipe.refusal ?? '')}</p>`,
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
      `<p><small>${escape(operatorLine(recipe))}</small></p>`,
      `<p class="k-unwritten">${escape(UNWRITTEN_ENTRY_NOTE)}</p>`,
      '</section>',
    ].join('')
  }

  /**
   * **A withdrawn row keeps its page and keeps its steps** (`#604`).
   *
   * The steps are rendered below by the ordinary path, under a heading that says
   * what they now are. That is the whole argument for `retired` existing rather
   * than the row being deleted: a reader arriving from an old link learns what
   * the path was, when it closed and why, instead of meeting a 404 that teaches
   * them nothing. `growth/README.md`'s rule — *a refusal is a page, not an
   * omission* — is the same rule one state along.
   */
  if (recipe.status === 'retired') {
    return [
      `<section><h2>${escape(recipeHeading(recipe))}</h2>`,
      '<p class="k-refused"><strong>Withdrawn' +
        (recipe.retiredAt === null ? '' : ` on ${escape(recipe.retiredAt.slice(0, 10))}`) +
        `.</strong> ${escape(recipe.retiredReason ?? '')}</p>`,
      `<p class="k-unwritten">${escape(RETIRED_ENTRY_NOTE)}</p>`,
      recipe.steps.length === 0
        ? ''
        : '<h3>What the path was</h3><ol>' +
          recipe.steps.map((step) => `<li>${escape(stepInstruction(step))}</li>`).join('') +
          '</ol>',
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

      return `<li>${who}${escape(stepInstruction(step))}${ask}</li>`
    })
    .join('')

  /**
   * **The page says the account is a means** (`#637`), where it is one.
   *
   * `start` continues the numbering rather than restarting it, for the reason
   * the briefing does: one sequence, and the positions are what a walk reports.
   */
  const reach =
    recipe.reaches === null
      ? ''
      : `<h3>${escape(atlasCapabilityPhrase(recipe.reaches.capability))}, and how to get it</h3>` +
        `<p><small>Optional, and the account is not what you came for.</small></p>` +
        `<ol start="${recipe.steps.length + 1}">` +
        recipe.reaches.steps.map((step) => `<li>${escape(stepInstruction(step))}</li>`).join('') +
        '</ol>'

  return [
    `<section><h2>${escape(recipeHeading(recipe))}</h2>`,
    `<p><small>${escape(operatorLine(recipe))}</small></p>`,
    staleNote(recipe),
    `<ol>${steps}</ol>`,
    `<p>${escape(provesLine(recipe.proves))}</p>`,
    reach,
    figuresSection(recipe.figures, recipe.steps.length),
    briefingSection(briefing),
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
function indexFigure(entry: AtlasEntry): string {
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
function aboutSection(entry: AtlasEntry): string {
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
function paidMarker(entry: AtlasEntry): string {
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
function runtimesSection(entry: AtlasEntry): string {
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
function membershipSection(entry: AtlasEntry): string {
  const statuses = entry.recipes.map((recipe) => recipe.status)

  if (statuses.includes('joinable')) {
    return [
      '<h2>Getting the tools this page names</h2>',
      `<p>The steps above call <code>kolonie.vault.set</code>, ` +
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
function counterpartySection(entry: AtlasEntry): string {
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
function staleNote(recipe: AtlasEntry['recipes'][number]): string {
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
function confirmedLine(entry: AtlasEntry): string {
  const walked = lastConfirmed(entry)

  if (walked === undefined) {
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
