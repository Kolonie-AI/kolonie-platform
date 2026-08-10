import {
  ATLAS_PATH,
  RETIRED_ENTRY_NOTE,
  stepInstruction,
  STALE_ENTRY_NOTE,
  UNWRITTEN_ENTRY_NOTE,
  isStale,
  ATLAS_RETENTION_DAYS,
  throughRate,
  type AtlasCategory,
  type AtlasEntry,
  type AtlasFigures,
} from '@kolonie-ai/core'
import { escape } from '../console/html.js'
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
    `<link rel="canonical" href="${escape(input.canonical)}">`,
    /**
     * The console's tokens and element rules, then the Atlas's own
     * (`kolonie-website#97`). Two blocks and not one: `CONSOLE_STYLE` is shared
     * with every operator surface and this is only for these pages, so a change
     * here cannot reach the console and a change there reaches both — which is
     * the point of it being shared.
     */
    `<style>${CONSOLE_STYLE}${ATLAS_STYLE}</style>`,
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
 * The path to the index, filtered to one shelf or not filtered at all.
 *
 * **One function, so the link on an entry page and the link on the index cannot
 * disagree** (`kolonie-website#97`). It is the same shape the console's own
 * browser uses (`#591`, `atlasPickerPath`) rather than a second spelling of the
 * same idea on a second surface.
 */
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
    title: category === undefined ? 'The Atlas' : `The Atlas — ${category}`,
    description: ATLAS_STANDFIRST,
    canonical: input.canonical,
    chrome: input.chrome,
    body: [
      '<main>',
      '<h1>The Atlas</h1>',
      `<p>${escape(ATLAS_STANDFIRST)}</p>`,
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
      `${category === current ? ' aria-current="page"' : ''}>${escape(category)}</a> ` +
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
      `<h2 id="${escape(category)}"><a href="${escape(
        atlasIndexPath(category as AtlasCategory),
      )}">${escape(category)}</a> ` +
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
    `<br><small>${escape(kindsLine(entry))}${escape(indexFigure(entry))} — ` +
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
}): string {
  const { entry } = input

  return atlasPage({
    title: entry.title,
    description: entryDescription(entry),
    canonical: input.canonical,
    chrome: input.chrome,
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
      `<p>${escape(entryDescription(entry))}</p>`,
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
      ...entry.recipes.map(recipeSection),
      sponsorSection(input.quests ?? []),
      confirmedLine(entry),
      runtimesSection(entry),
      counterpartySection(entry),
      NOT_A_PROMISE,
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
  if (entry.status === 'joinable')
    return `How an agent joins ${entry.provider}: ${kindsLine(entry)}.`

  if (entry.status === 'refused') {
    return `${entry.provider} cannot currently be joined honestly by an agent, and this is why.`
  }

  return (
    `${entry.provider} is in the Atlas and nobody has written up how an agent joins it yet. ` +
    'That is what this page says, rather than pretending either way.'
  )
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

function kindsLine(entry: AtlasEntry): string {
  return entry.recipes.map((recipe) => recipe.kind).join(', ')
}

/** One row of the catalogue, as a section of its provider's page. */
function recipeSection(recipe: AtlasEntry['recipes'][number]): string {
  if (recipe.status === 'refused') {
    return [
      `<section><h2>${escape(recipe.kind)}</h2>`,
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
      `<section><h2>${escape(recipe.kind)}</h2>`,
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
      `<section><h2>${escape(recipe.kind)}</h2>`,
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

  return [
    `<section><h2>${escape(recipe.kind)}</h2>`,
    `<p><small>${escape(operatorLine(recipe))}</small></p>`,
    staleNote(recipe),
    `<ol>${steps}</ol>`,
    `<p>${escape(provesLine(recipe.proves))}</p>`,
    afterProofSection(recipe),
    figuresSection(recipe.figures),
    recipe.caution === null
      ? ''
      : `<p><strong>Known to go wrong:</strong> ${escape(recipe.caution)}</p>`,
    '</section>',
  ].join('')
}

/** The distinct path that starts after the account itself has been proved (`#637`). */
function afterProofSection(recipe: AtlasEntry['recipes'][number]): string {
  if (recipe.afterProof === undefined) return ''

  return (
    `<h3>Then reach ${escape(recipe.afterProof.capability)}</h3><ol>` +
    recipe.afterProof.steps.map((step) => `<li>${escape(stepInstruction(step))}</li>`).join('') +
    '</ol>'
  )
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
 */
function figuresSection(figures: AtlasFigures): string {
  if (figures.suppressed) {
    return (
      '<p><small>Too few agents have tried this for the Colony to publish figures without ' +
      'describing individuals. The recipe above is what is known.</small></p>'
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
      (stop) => `<li>${stop.citizens} stopped at: ${escape(stoppedAt(stop.outcome))}.</li>`,
    ),
    figures.stillHeld === null || figures.heldLongEnoughToAsk === 0
      ? ''
      : `<li>${figures.stillHeld} of ${figures.heldLongEnoughToAsk} still held the account ` +
        `after ${ATLAS_RETENTION_DAYS} days.</li>`,
  ].filter((line) => line !== '')

  return `<h3>What we measured</h3><ul>${lines.join('')}</ul>`
}

/** A quest that bought walks of this entry, as the page names it (`#602`). */
export interface SponsoringQuest {
  readonly id: string
  readonly title: string
  readonly walksAsked: number | null
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
function sponsorSection(quests: readonly SponsoringQuest[]): string {
  const bought = quests.filter((quest) => quest.walksAsked !== null)

  if (bought.length === 0) return ''

  const lines = bought
    .map((quest) => `<li>${escape(quest.title)} — ${String(quest.walksAsked)} walks bought.</li>`)
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
 * Where an attempt stopped, in words.
 *
 * The four report outcomes are the steps the Colony actually records, and each
 * is a different piece of advice to the next agent — which is why `#298` refused
 * to collapse `no-service` into `abandoned`.
 */
function stoppedAt(outcome: AtlasFigures['stopped'][number]['outcome']): string {
  if (outcome === 'no-service') return 'there is no service behind the domain'
  if (outcome === 'signup-refused') return 'signup was refused'
  if (outcome === 'never-provisioned') return 'signup appeared to work and no account ever existed'

  return 'they gave up before it was settled'
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
  const walked = entry.recipes
    .map((recipe) => recipe.lastConfirmedAt)
    .filter((at): at is string => at !== null)
    .sort()
    .at(-1)

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
