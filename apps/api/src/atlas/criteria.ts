import {
  atlasKindPhrase,
  kindHasDirection,
  providerTermsSentence,
  signupCostSentence,
  WALL_KIND_MEANINGS,
  type RecipeDirection,
  type WallKind,
} from '@kolonie-ai/core'
import type { AtlasPublicEntry, AtlasPublicRecipe } from './public-projection.js'

/**
 * The criteria box, as questions and answers (`#1105` decisions 1, 2 and 4).
 *
 * ## Why the rows are built once and rendered twice
 *
 * The box a reader scans and the `FAQPage` a crawler parses are the same nine
 * facts, and `#1105` decision 4 is that every question in the markup has its
 * answer *visible on the page*. Two builders would satisfy that on the day they
 * were written and drift on the first edit to either — so there is one builder,
 * `html.ts` renders its rows into a `<dl>` and `structured-data.ts` renders the
 * same rows into `Question`/`Answer` pairs. The test that extracts both and
 * compares them is then checking a property this module makes structurally true,
 * which is the cheap way round.
 *
 * ## The rule the answers are written under
 *
 * **Every line is a field already on the entry, and an unset field says so**
 * (decision 2). There is deliberately no branch here that fills a missing `cost`
 * with *free*, a missing `terms` with *allowed*, or an absent wall with *no*: a
 * catalogue that guesses on behalf of a provider is a catalogue that sends an
 * agent to spend an afternoon on a wall nobody recorded. {@link ATLAS_NOT_KNOWN}
 * is the one string for all of it, so *nobody has looked* and *somebody looked
 * and found nothing* can never be read as each other.
 *
 * ## Why a wall question has three answers and not two
 *
 * A wall is recorded when somebody hit it. Its absence therefore means one of two
 * different things, and the difference is the whole value of the box: on an entry
 * somebody walked, *no wall of this kind* is a measurement — nobody who got
 * through was asked for a phone number — and on an entry nobody has touched it is
 * the absence of any measurement at all. {@link atlasCriteria} answers the first
 * with what the walks found and the second with {@link ATLAS_NOT_KNOWN}.
 */

/** What an unset field renders as, everywhere in the box (`#1105` decision 2). */
export const ATLAS_NOT_KNOWN = 'Not known.'

/** What a walked entry says about a wall nobody hit. */
const NOT_REPORTED = 'Not reported by anybody who walked it.'

/** One line of the criteria box: a question a reader typed, and the answer. */
export type AtlasCriterion = {
  readonly question: string
  readonly answer: string
}

/**
 * The six wall kinds the box asks about, in the order a reader weighs them.
 *
 * **Six of the ten**, and the four left out are left out on purpose: `absent`
 * and `other` name no criterion a reader can act on, and `public-endpoint-
 * required` and `terms-forbid-agents` are answered by the operator row and the
 * terms row directly above them. They still render in `wallsSection`, which
 * prints every wall on the row — the box is the scannable five seconds, not a
 * second copy of the findings.
 */
const WALL_QUESTIONS: readonly (readonly [WallKind, string])[] = [
  ['human-check', 'Is there a human check to get past?'],
  ['payment-required', 'Does it want money before the account works?'],
  ['phone-verification', 'Does it need a phone number?'],
  ['identity-document', 'Does it need an identity document?'],
  ['invite-only', 'Is it invite-only?'],
  ['approval-required', 'Does a person have to approve the account?'],
]

/**
 * The question a reader actually typed, as the page's `h1` (`#1105` decision 3).
 *
 * **It supersedes `#788` for the heading and not for the `<title>`.** `#788` made
 * the title element the search line — *GitHub for an AI agent: sign up, prove
 * it* — and that is still what a result list shows. What a reader lands on should
 * be their own sentence back: the kind phrase carries its own article, so
 * `lowerFirst` is all the joining this needs.
 *
 * An entry with several recipes asks about all of them in one heading rather than
 * picking one, because picking one would silently answer about a capability the
 * reader did not come for.
 *
 * **The provider is named by its domain and never by `entry.title`**
 * (`kolonie-website#112`). The two were the same word on the day this was written
 * and stopped being it at `#1146`, which made a row's title say *what the account
 * is* — so the live heading on `github.com` read *How can an AI agent create a
 * GitHub account at A GitHub machine account of the agent's own?*, two noun
 * phrases joined by a preposition that cannot hold them. The domain is what a
 * searcher typed, it is what `providerName` in `html.ts` already prints in the
 * `<title>`, and it cannot be wrong — `#788` took the same decision there.
 */
export function atlasEntryQuestion(entry: AtlasPublicEntry): string {
  const kinds = [
    ...new Set(entry.recipes.map((recipe) => lowerFirst(atlasKindPhrase(recipe.kind)))),
  ]
  const asked = kinds.length === 0 ? 'an account' : kinds.join(' or ')

  return `How can an AI agent create ${asked} at ${entry.provider}?`
}

/**
 * The same heading, one level up: a shelf's own `h1` (`#1107`, decision 4).
 *
 * **Here rather than beside `atlasShelfTitle` in `core`**, because what it is
 * doing is `#1105`'s decision and not the taxonomy's: `#1107` says the category
 * page applies that decision one level up rather than deciding it again, and a
 * reader wondering why a shelf asks a question should find the answer next to the
 * page that asks the same one about a provider.
 *
 * **The title is not rewritten**, only joined: *Mailboxes* becomes *Which
 * mailboxes can an AI agent sign up for?*, and the words are the ones the
 * category row already carries. A title whose second character is upper case is
 * left alone — `DNS providers` is an acronym and not a sentence, and lowercasing
 * it would produce a word nobody typed.
 */
export function atlasShelfQuestion(title: string): string {
  const opening = /^[A-Z][A-Z]/.test(title) ? title : lowerFirst(title)

  return `Which ${opening} can an AI agent sign up for?`
}

/**
 * The nine facts, plus a direction where the kind has one (`#1105` decision 1).
 *
 * The order is the order a reader weighs them in: what it costs, what stands in
 * the way, what the terms say, and who has to be there.
 */
export function atlasCriteria(entry: AtlasPublicEntry): readonly AtlasCriterion[] {
  const walls = entry.recipes.flatMap((recipe) => recipe.walls)

  /**
   * Whether anybody has been here at all, which is what tells an absent wall from
   * an unmeasured one. A recipe nobody has written is the placeholder `#790`
   * asks not to be indexed; every other status is somebody having looked.
   */
  const measured = entry.recipes.some((recipe) => recipe.status !== 'unwritten')

  return [
    /**
     * **An entry is one provider and several capabilities**, and `cost` and
     * `terms` are properties of the provider rather than of the capability — so a
     * mailbox row saying *free* answers for the phone row beside it that nobody
     * has priced. Where two rows disagree the first wins, which is the rule the
     * shelf ordering already takes; where none of them says anything, nobody
     * knows, and the sentence helpers in `atlas-conditions.ts` return nothing for
     * `unknown` precisely so that this cannot be papered over here.
     */
    {
      /** The domain, for the reason {@link atlasEntryQuestion} gives at length. */
      question: `What does it cost to sign up at ${entry.provider}?`,
      answer:
        signupCostSentence(
          entry.recipes.find((recipe) => recipe.cost !== 'unknown')?.cost ?? 'unknown',
        ) ?? ATLAS_NOT_KNOWN,
    },
    ...WALL_QUESTIONS.map(([kind, question]) => ({
      question,
      answer: wallAnswer(
        walls.find((wall) => wall.kind === kind),
        measured,
      ),
    })),
    {
      question: 'Do the terms allow an account held by an agent?',
      answer:
        providerTermsSentence(
          entry.recipes.find((recipe) => recipe.terms !== 'unknown')?.terms ?? 'unknown',
        ) ?? ATLAS_NOT_KNOWN,
    },
    {
      question: 'Can an agent do this alone, or is a person needed?',
      answer: operatorAnswer(entry),
    },
    ...directionRow(entry.recipes),
  ]
}

/**
 * What the walks found about one kind of wall, in the sentence the Colony wrote
 * for that kind.
 *
 * The count, the direction and the amount are the wall's own typed fields —
 * `wallsSection` prints the same four and this is deliberately the same shape, so
 * a reader who scans the box and then reads the findings is not told two things.
 * The prose half of a wall (`title`, `symptom`, `remedy`) never leaves the
 * projection and is not reachable from here (`#1100` decision 3).
 */
function wallAnswer(
  wall: AtlasPublicEntry['recipes'][number]['walls'][number] | undefined,
  measured: boolean,
): string {
  if (wall === undefined) return measured ? NOT_REPORTED : ATLAS_NOT_KNOWN

  const scope = directionScope(wall.direction ?? null)
  const walks =
    wall.reportedBy === 0
      ? ' Classified from the refusal rather than from a walk.'
      : ` Hit by ${wall.reportedBy} walk${wall.reportedBy === 1 ? '' : 's'}.`
  const cost = wall.amountUsd === undefined ? '' : ` About $${wall.amountUsd}.`

  return `Yes — ${WALL_KIND_MEANINGS[wall.kind]}${scope}.${walks}${cost}`
}

/**
 * Who has to be there, as a sentence rather than as the index row's clause.
 *
 * `operatorLine` in `html.ts` answers the same field mid-sentence and lowercased,
 * which is what a one-line summary under a link needs and not what a box of
 * standalone answers does. A guess still says it is a guess: an operator told
 * *not needed* about a provider nobody has walked finds out otherwise at the
 * worst possible moment (`#589`).
 */
function operatorAnswer(entry: AtlasPublicEntry): string {
  const said = {
    unaided: 'An agent can do this alone.',
    'operator-needed': 'A person is needed at one step.',
    unknown: ATLAS_NOT_KNOWN,
  }[entry.operatorNeed]

  if (said === ATLAS_NOT_KNOWN) return said

  return entry.operatorNeedIsGuess ? `${said.slice(0, -1)} (a guess, not a walk).` : said
}

/**
 * The direction row, on the kinds where the axis means anything (`#976`).
 *
 * `phone` is the one kind today, and `kindHasDirection` owns the list — a second
 * one is a data change there rather than an edit here. An entry whose kinds have
 * no direction gets no row at all, because a row reading *not known* about an
 * axis that does not exist is noise a reader has to learn to skip.
 */
function directionRow(recipes: readonly AtlasPublicRecipe[]): readonly AtlasCriterion[] {
  const directional = recipes.filter((recipe) => kindHasDirection(recipe.kind))
  if (directional.length === 0) return []

  const measured = directional.find((recipe) => recipe.direction !== null)?.direction ?? null
  const said = {
    inbound: 'Receiving.',
    outbound: 'Sending.',
    both: 'Sending and receiving.',
  }

  return [
    {
      question: 'Which direction was this measured in?',
      answer: measured === null ? ATLAS_NOT_KNOWN : said[measured],
    },
  ]
}

/** The parenthesised scope `wallsSection` and `cautionParagraphs` both print. */
function directionScope(direction: RecipeDirection | null): string {
  if (direction === null) return ''
  if (direction === 'both') return ' (sending and receiving)'

  return direction === 'inbound' ? ' (receiving)' : ' (sending)'
}

/** Lowercases the first character and leaves every other one alone. */
function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1)
}
