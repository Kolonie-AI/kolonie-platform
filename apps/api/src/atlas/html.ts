import {
  ATLAS_PATH,
  RETIRED_ENTRY_NOTE,
  STALE_ENTRY_NOTE,
  UNWRITTEN_ENTRY_NOTE,
  isStale,
  ATLAS_RETENTION_DAYS,
  throughRate,
  type AtlasEntry,
  type AtlasFigures,
} from '@kolonie-ai/core'
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
  'joined honestly, that is what the page says — and where nobody has looked yet, it says that ' +
  'instead of guessing.'

/** The index: every entry, joinable first, then unwritten, then refusals (`#588`). */
export function atlasIndexPage(input: {
  readonly entries: readonly AtlasEntry[]
  readonly canonical: string
}): string {
  return atlasPage({
    title: 'The Atlas',
    description: ATLAS_STANDFIRST,
    canonical: input.canonical,
    body: [
      '<main>',
      '<h1>The Atlas</h1>',
      `<p>${escape(ATLAS_STANDFIRST)}</p>`,
      `<p><small>${escape(ATLAS_ORDER_NOTE)}</small></p>`,
      input.entries.length === 0
        ? '<p>The catalogue is empty. Nothing has been listed yet, which is not the same as ' +
          'nothing being joinable.</p>'
        : shelves(input.entries).join('\n'),
      '</main>',
    ].join('\n'),
  })
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
      `<h2>${escape(category)}</h2>` +
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
}): string {
  const { entry } = input

  return atlasPage({
    title: entry.title,
    description: entryDescription(entry),
    canonical: input.canonical,
    body: [
      '<main>',
      `<h1>${escape(entry.title)}</h1>`,
      /**
       * The two facts `#589` adds, above everything else on the page. A reader
       * arrives asking *what sort of thing is this* and *will I be needed*, and
       * both used to be answerable only by reading five steps.
       */
      `<p class="k-atlas-facts"><a href="${ATLAS_PATH}">${escape(entry.category)}</a> — ` +
        `${escape(operatorLine(entry))}</p>`,
      paidMarker(entry),
      aboutSection(entry),
      `<p>${escape(entryDescription(entry))}</p>`,
      ...entry.recipes.map(recipeSection),
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
          recipe.steps.map((step) => `<li>${escape(step.instruction)}</li>`).join('') +
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

      return `<li>${who}${escape(step.instruction)}${ask}</li>`
    })
    .join('')

  return [
    `<section><h2>${escape(recipe.kind)}</h2>`,
    `<p><small>${escape(operatorLine(recipe))}</small></p>`,
    staleNote(recipe),
    `<ol>${steps}</ol>`,
    `<p>${escape(provesLine(recipe.proves))}</p>`,
    figuresSection(recipe.figures),
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
