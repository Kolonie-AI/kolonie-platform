import { atlasCapabilityPhrase } from '@kolonie-ai/core'
import type { AtlasPublicEntry } from './public-projection.js'
import { ATLAS_PARTLY, atlasEntryVerdict } from './verdict.js'

/**
 * The line a search result shows above everything else (`#788`).
 *
 * **Written for the query rather than for the catalogue**, and still derived:
 * a title field on the row would be a fourth piece of prose per entry for a
 * curator to keep true. What it says is what somebody searching *how does an
 * AI agent get a Trello account* is asking — the provider, that this is about
 * an agent, and what they will actually have to do — and the ` — Kolonie`
 * suffix `atlasPage` appends is what places it.
 *
 * Naming the provider descriptively is ordinary nominative use: the page is
 * about them, claims no endorsement, and `NOT_A_PROMISE` says so on the page
 * itself.
 *
 * ## Its own file, so the copy can be asserted without a page around it
 *
 * It lived in `html.ts` until `#1327`, where the only way to read it was to
 * render three kilobytes of page and regex the `<title>` back out — which is
 * how {@link ATLAS_MEASURED_TITLE_BANNED} went four months without anything
 * watching it. The rule that a measured entry never says *no recipe written
 * yet* is a rule about a string, and a test that has to build an entry, a
 * route and a response to check one is a test nobody adds the next time.
 *
 * **{@link ATLAS_REFUSING}, {@link providerName} and {@link lowerFirst} came
 * with it rather than being copied.** The page under the title reads all three
 * — the lead sentence takes the same `#1163` override as the heading — and a
 * second copy of *which statuses assert a closed door* is the shape that lets a
 * title and its own subline disagree.
 */

/**
 * The two statuses that assert a closed door, and the only two `#1163` overrides.
 *
 * A verdict of `partly` on any other status changes nothing: `measured` already
 * says *walked, and no route written* in `#1141`'s own words, and `joinable` and
 * `unwritten` cannot produce one.
 */
export const ATLAS_REFUSING: ReadonlySet<AtlasPublicEntry['status']> = new Set([
  'refused',
  'retired',
])

/**
 * What a measured entry is titled, frozen by `#1326` decision 2.
 *
 * **`measured` means the Colony has no route here, not that the page is
 * unfinished.** The two readings are a hair apart in the writing and a long way
 * apart to a stranger: *no recipe written yet* describes the Colony's own
 * backlog and reads as a page that failed to load, and it was the title of every
 * measured entry — 35 of them on 2026-08-19, each one built out of somebody's
 * afternoon. What is actually true is that citizens measured this provider and
 * nobody has published a way in, which is a finding rather than an absence.
 *
 * The em dash is deliberate and is the frozen copy: a colon after the provider
 * already carries the sentence, and a second one would read as a subtitle of a
 * subtitle.
 */
export function atlasMeasuredTitle(provider: string): string {
  return `${provider}: measured — no Colony route yet`
}

/**
 * The phrase a measured title may not contain, asserted rather than remembered.
 *
 * **Exported so the ban is a fact one test reads and not a sentence in a
 * review.** `#1327` is a copy decision, and a copy decision holds for exactly as
 * long as somebody remembers it — the string it replaces is still correct
 * English about the Colony's backlog, so nothing about reading it back suggests
 * it is wrong.
 */
export const ATLAS_MEASURED_TITLE_BANNED = 'no recipe written yet'

/**
 * The provider's name, as a page written for a stranger says it.
 *
 * **The domain, verbatim, and there is no display-name column** (`#788`). It is
 * what a searcher types, it is what `atlasPath` already uses, and it cannot be
 * wrong — where a title-cased first label would give *Github* and *Mail.tm*,
 * and a hand-curated name would be a second copy of the provider free to
 * disagree with it. `recipeHeading` took the same decision in `#791`.
 */
export function providerName(entry: AtlasPublicEntry): string {
  return entry.provider
}

/** A phrase that carries its own article, used mid-sentence. */
export function lowerFirst(phrase: string): string {
  return phrase.charAt(0).toLowerCase() + phrase.slice(1)
}

export function atlasEntryTitle(entry: AtlasPublicEntry): string {
  const name = providerName(entry)

  /**
   * **A refusal with successes behind it is not a refusal in the title**
   * (`#1163`). `atlasEntryVerdict` is the one model the lead chip and the shelf
   * default read too, and `partly` is the value that exists so that this page
   * has something true to say: the two branches below are correct about the
   * route and were being printed over the top of four sections of walks that got
   * through.
   *
   * **`measured` keeps its own title.** That status already says *walked, and no
   * route written*, which is what `partly` means one word longer — and it says
   * it more precisely. Only the two statuses that assert a closed door are
   * overridden here.
   */
  if (atlasEntryVerdict(entry) === ATLAS_PARTLY && ATLAS_REFUSING.has(entry.status)) {
    return `${name} for an AI agent: what got through, and what did not`
  }

  if (entry.status === 'refused') return `${name}: why an agent cannot join it`
  if (entry.status === 'retired') return `${name}: withdrawn, and what the path was`
  /**
   * **`measured` is the one status the fallback below is false for** (`#1141`).
   * Since `#1032` it means *a walk closed here and nobody wrote the route*, so
   * `nobody has mapped this yet` was the page telling a searcher to go away
   * from 35 entries built out of somebody's afternoon. `unwritten` keeps that
   * title, because for `unwritten` it is what happened.
   */
  if (entry.status === 'measured') return atlasMeasuredTitle(name)
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
