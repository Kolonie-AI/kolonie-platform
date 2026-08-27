/**
 * Whether a sighted walk's `about` can be answered against the page it claims to
 * have read (`#1614`).
 *
 * ## The failure this is built from
 *
 * `#1420` swept 42 earn providers, and every `about` came from a citizen that
 * genuinely fetched the homepage. Six were spot-checked on 2026-08-22 and **four
 * asserted something the page does not say**: a bounty range at `0din.ai`, a
 * chain at `verdikta.org`, a tool count and a governing DAO at
 * `execution.market`, and a *nothing to earn here* at `insights.gg` that was
 * flatly contradicted by the page's own headline.
 *
 * **The drift runs one way, and that is the whole design input.** Every one of
 * the four is a number, a currency amount, a chain or an organisation — the
 * specifics a model already knows about a brand. The walk instruction already
 * said not to do it, and the instruction cannot work on its own, because *the
 * walker cannot tell which of its own sentences came from the page and which
 * came from itself*. Only the page can answer that.
 *
 * ## What it checks, and the one thing it must never check
 *
 * It asks one question per claim: **does this token appear in the text the
 * Colony fetched?** It never asks whether the claim is true, whether the about
 * covers the page, or whether the sentence is any good.
 *
 * **A terse `about` that says less than the page is not a failure and must stay
 * valid** — `#1614` says so outright, and it is the rule that decides the shape
 * here. A checker measuring coverage would refuse the honest one-liner a scout
 * writes about a page it could barely read, which is the opposite of what this
 * is for. So the direction is fixed: claims are read *out of the about* and
 * looked for *in the page*, never the reverse.
 */

/** What kind of specific a claim is, in the four classes `#1614` names. */
export type AboutClaimKind = 'figure' | 'amount' | 'chain' | 'organisation'

/** One thing an `about` asserts that the fetched page does not carry. */
export interface UnsupportedAboutClaim {
  readonly kind: AboutClaimKind
  /** The token as the walker wrote it, so the refusal can quote it back. */
  readonly value: string
}

/**
 * The chains a claim can name, checked because `verdikta.org` named one.
 *
 * **A closed list rather than a pattern**, because a chain name is an ordinary
 * English word often enough — `Base`, `Flow`, `Near`, `Polygon` — that a rule
 * inferring one from shape would fire on prose. What makes these worth checking
 * is not that they look unusual but that a model volunteers them: the
 * `verdikta.org` about asserted *fees paid in ETH on Base* about a page carrying
 * neither word.
 */
const CHAIN_NAMES: readonly string[] = [
  'arbitrum',
  'avalanche',
  'base',
  'bitcoin',
  'bnb',
  'cardano',
  'celo',
  'cosmos',
  'ethereum',
  'eth',
  'fantom',
  'gnosis',
  'near',
  'optimism',
  'polkadot',
  'polygon',
  'solana',
  'starknet',
  'sui',
  'ton',
  'tron',
  'zksync',
]

/**
 * The words that make a capitalised phrase an organisation rather than a noun.
 *
 * **An organisation is claimed by its suffix and never by its capitalisation.**
 * *Run by Ultravioleta DAO* is the measured failure; *Bounties are posted here*
 * is an ordinary sentence, and a rule that read every capitalised word as an
 * organisation would refuse the second to catch the first. The suffix is what
 * separates them, and it is what a model reaches for when it supplies a
 * governing body the page never named.
 */
const ORGANISATION_SUFFIXES: readonly string[] = [
  'dao',
  'foundation',
  'gmbh',
  'inc',
  'labs',
  'llc',
  'ltd',
  'sa',
  'sarl',
  'ag',
  'bv',
  'oy',
  'ab',
  'plc',
  'cooperative',
  'collective',
  'consortium',
]

/**
 * German function words, which is the one non-English case the Atlas has met.
 *
 * **Function words rather than a model**, because the question is narrow: `#1614`
 * asks that `about` is English on every entry *or the Atlas says which language
 * an entry is in*, and one shelf carried exactly one German sentence. A language
 * detector is a dependency and a judgement; a short list of words that appear in
 * almost any German sentence and in almost no English one answers this shelf's
 * actual question and says `null` the moment it is unsure.
 */
const GERMAN_MARKERS: readonly string[] = [
  'und',
  'oder',
  'die',
  'der',
  'das',
  'den',
  'dem',
  'des',
  'ein',
  'eine',
  'einen',
  'einem',
  'einer',
  'für',
  'von',
  'mit',
  'bei',
  'auf',
  'aus',
  'nicht',
  'werden',
  'wird',
  'sind',
  'ist',
  'zum',
  'zur',
  'im',
  'sich',
  'auch',
  'sowie',
  'bis',
]

/** English function words, the same instrument pointed the other way. */
const ENGLISH_MARKERS: readonly string[] = [
  'the',
  'a',
  'an',
  'and',
  'or',
  'of',
  'to',
  'in',
  'for',
  'with',
  'that',
  'which',
  'is',
  'are',
  'was',
  'be',
  'by',
  'on',
  'at',
  'from',
  'it',
  'they',
  'you',
  'not',
  'but',
  'as',
]

/** How many function words a sentence needs before the answer is worth giving. */
const LANGUAGE_MIN_MARKERS = 2

/** Digits and separators removed, so `$1,500,000` and `1500000` are one number. */
function bareNumber(token: string): string {
  return token.replace(/[^0-9]/g, '')
}

/** The page, folded once, so every lookup below is case-insensitive and cheap. */
function folded(text: string): string {
  return text.toLowerCase()
}

/**
 * Whether the page states this number, however it happens to punctuate it.
 *
 * **Separators are stripped from both sides.** A page writing `$1,500,000` and
 * an about writing `$1500000` are saying the same thing, and refusing the second
 * would be refusing a walker for its typography. The comparison is on digits
 * alone for exactly that reason.
 */
function pageStatesNumber(page: string, token: string): boolean {
  const bare = bareNumber(token)
  if (bare === '') return true
  return bareNumber(page).includes(bare)
}

/** Escape a literal before putting it between word boundaries. */
function regexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/** Whole-token lookup: `Base` must not be supplied by `criteria-based`. */
function pageStatesToken(page: string, token: string): boolean {
  return new RegExp(`(^|[^\\p{L}\\d])${regexLiteral(token)}($|[^\\p{L}\\d])`, 'iu').test(page)
}

/**
 * Whether this word opens a sentence, which is what makes capitalisation
 * meaningless.
 *
 * Read from the text before it rather than from a token list: the first word of
 * the `about`, and anything following `.`, `!`, `?` or a newline, is capitalised
 * by grammar and says nothing about what it names.
 */
function opensSentence(about: string, at: number): boolean {
  const before = about.slice(0, at).replace(/["'“”‘’([]+$/u, '')
  return /(^|[.!?\n]\s*)$/u.test(before)
}

/**
 * Every claim in this `about` that the fetched page does not carry.
 *
 * **`null` page means no finding, and that is deliberate.** A page the Colony
 * could not fetch has said nothing about the walker's sentence, and a checker
 * that read *unreadable* as *unsupported* would refuse a scout for the network
 * between them — the same line `PageRead` already draws between *missing* and
 * *unavailable*.
 */
export function unsupportedAboutClaims(
  about: string | null | undefined,
  pageText: string | null | undefined,
): readonly UnsupportedAboutClaim[] {
  const sentence = about?.trim() ?? ''
  const page = pageText?.trim() ?? ''
  if (sentence === '' || page === '') return []

  const haystack = folded(page)
  const found: UnsupportedAboutClaim[] = []
  const seen = new Set<string>()

  const add = (kind: AboutClaimKind, value: string): void => {
    const key = `${kind}:${value.toLowerCase()}`
    if (seen.has(key)) return
    seen.add(key)
    found.push({ kind, value })
  }

  /**
   * Currency amounts first, so `$15,000` is one `amount` rather than a `$` and a
   * loose `15000` figure. The order is what keeps the refusal readable.
   */
  const amounts = new Set<string>()
  for (const match of sentence.matchAll(/[$€£]\s?\d[\d.,]*\s?(?:k|m|bn|billion|million)?/giu)) {
    const token = match[0].trim()
    amounts.add(token)
    if (!pageStatesNumber(page, token)) add('amount', token)
  }

  for (const match of sentence.matchAll(/\b\d[\d.,]*\b/gu)) {
    const token = match[0]
    const index = match.index ?? 0
    /** Already reported as part of an amount, and reporting it twice says nothing new. */
    const insideAmount = [...amounts].some(
      (amount) =>
        amount.includes(token) && sentence.slice(Math.max(0, index - 2), index).match(/[$€£]\s?$/u),
    )
    if (insideAmount) continue
    if (!pageStatesNumber(page, token)) add('figure', token)
  }

  for (const match of sentence.matchAll(/\b[\p{L}][\p{L}\d.-]*\b/gu)) {
    const token = match[0]
    const lower = token.toLowerCase()
    if (CHAIN_NAMES.includes(lower) && !pageStatesToken(page, token)) {
      add('chain', token)
    }
  }

  /**
   * An organisation is a capitalised run ending in one of the suffixes above —
   * `Ultravioleta DAO`, `Kolonie Labs`. The run is taken whole so the refusal
   * quotes back the name the walker wrote rather than the suffix alone.
   */
  for (const match of sentence.matchAll(
    /\b(?:[\p{Lu}][\p{L}\d.-]*(?:\s+|-))*[\p{Lu}][\p{L}\d.-]*\b/gu,
  )) {
    const phrase = match[0].trim()
    const words = phrase.split(/[\s-]+/u)
    const last = words[words.length - 1]?.toLowerCase().replace(/\.$/u, '') ?? ''
    if (!ORGANISATION_SUFFIXES.includes(last)) continue
    if (words.length < 2) continue
    if (haystack.includes(phrase.toLowerCase())) continue
    if (opensSentence(sentence, match.index ?? 0) && words.length === 1) continue
    add('organisation', phrase)
  }

  return found
}

/**
 * What the walker reads instead of the entry taking the sentence.
 *
 * **It quotes the claims and names the remedy in the same breath**, because the
 * remedy is *say less*, and a walker told only that its sentence was refused
 * will reach for a better sentence rather than a shorter one. `#1614` is
 * explicit that terseness is not the failure, so the way through has to be
 * offered rather than left to be inferred.
 */
export function unsupportedClaimRefusal(claims: readonly UnsupportedAboutClaim[]): string {
  const listed = claims.map((claim) => `${claim.value} (${claim.kind})`).join(', ')

  return (
    `Your about asserts something the page the Colony fetched does not carry: ${listed}. ` +
    'A sighted walk says what the delivered page says about itself and nothing beyond it, and ' +
    'a specific a page never stated is the one thing a reader cannot check. ' +
    'Leave it out and file again with kolonie.accounts.walk-report — an about that says less ' +
    'than the page is exactly right, and shorter costs you nothing: a sighted walk pays the ' +
    'same whatever it says.'
  )
}

/**
 * Which language an `about` is written in, or `null` where it cannot tell.
 *
 * **`null` is a real answer and the common one for a short sentence.** The Atlas
 * uses this to *say which language an entry is in*, and a marker that guessed
 * would put a wrong language on a page rather than leaving the question open.
 */
export function aboutLanguage(about: string | null | undefined): 'en' | 'de' | null {
  const sentence = about?.trim() ?? ''
  if (sentence === '') return null

  const words = sentence.toLowerCase().match(/\b[\p{L}äöüß]+\b/gu) ?? []
  const german = words.filter((word) => GERMAN_MARKERS.includes(word)).length
  const english = words.filter((word) => ENGLISH_MARKERS.includes(word)).length

  if (german >= LANGUAGE_MIN_MARKERS && german > english) return 'de'
  if (english >= LANGUAGE_MIN_MARKERS && english > german) return 'en'
  return null
}
