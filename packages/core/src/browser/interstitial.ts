/**
 * Graded interstitials: the top of the browser branch (`#164`).
 *
 * There are surfaces on the open web where agents are welcome *and* a gate stands in
 * front of the content. Getting through one is a real, separable capability, and it is
 * one of the best composite measurements available — it exercises perception,
 * interaction and state at once.
 *
 * **What it is not is bypassing bot protection**, and the distinction is what makes
 * this buildable. Built on our own pages, the question the red line is about — *is this
 * actor claiming to be human* — is never posed, so there is nothing to make an
 * exception to. That is stronger than a permission, and it is why the naming rule
 * below is mechanical rather than cosmetic.
 *
 * **One task with a kind dimension, not one task per kind.** `#152` makes the identical
 * argument one branch over: separately written siblings drift, and the first time two
 * of them disagree about what a failure means, the model has a hole invisible from any
 * single file. One node, a registry of kinds, one verifier.
 */

/**
 * One kind of interstitial.
 *
 * `slug` is what lands in `browser_challenges.variant`, so it is what the citizen's
 * record names. `measures` is the sentence the kind's own text uses — every kind states
 * what capability it is measuring, which `#164` requires.
 *
 * `draft` switches a kind off on its own, without disturbing the node. That is the
 * pattern `#160` sets for stages, applied one level down: a kind whose page breaks
 * stops being minted and the rest keep working.
 */
export interface InterstitialKind {
  readonly slug: string
  readonly title: string
  readonly measures: string
  readonly draft?: boolean
}

/**
 * The kinds that exist today.
 *
 * **A starting set, not a contract** — `#164` says so explicitly, and each of these was
 * chosen for two properties: it exercises more than one faculty, and it can be graded
 * exactly. Nothing here is graded by judgement.
 *
 * **Nothing is named for a CAPTCHA**, and this is the node where that rule matters most
 * because it is the one a reader would most naturally give that name. A kind called
 * *captcha* makes every agent run the *am I permitted* reasoning against
 * `governance/red-lines.md`, whoever wrote the page. Named for the capability, the
 * question never arises.
 *
 * **No kind measures timing, jitter, mouse path or human-likeness.** Not one, not ever:
 * that is the behaviour this whole branch moves away from, and it is also the one
 * measurement here that would be genuinely unfair across runtimes. Tests pin it.
 */
export const INTERSTITIAL_KINDS: readonly InterstitialKind[] = [
  {
    /**
     * Three panels, each with a digit drawn into it. Click them in ascending order of
     * those digits.
     *
     * Two faculties at once and neither is optional: the digits are drawn, so they have
     * to be seen, and the order has to be *performed*, so a correct reading with a
     * wrong sequence fails. The page records the order it received, so a failure says
     * which sequence arrived rather than only that one did.
     */
    slug: 'ordered-panels',
    title: 'Open three panels in the order they are numbered',
    measures: 'reading values that are drawn, and acting on them in a required order',
  },
  {
    /**
     * A value is drawn, then replaced once by another when the page finishes preparing
     * itself. The second one is the answer.
     *
     * **This measures state, never speed.** The page says in its own status when the
     * reveal has happened, and a citizen may take as long as it likes afterwards —
     * nothing here rewards being quick, which is the prohibition this branch holds to.
     * What it does catch is a citizen that screenshots once, at the first thing it sees,
     * and never checks whether the page had finished.
     */
    slug: 'revealed-value',
    title: 'Report the value the page settles on, not the first one it shows',
    measures: 'noticing that a page is not finished, and reading what it settles on',
  },
  {
    /**
     * Marks drawn at positions on a scale, and a line drawn across it. Report how many
     * marks are above the line.
     *
     * Positional meaning, which is exactly the kind of thing a DOM reader cannot
     * recover: the count exists only in the geometry. Exactly gradable, and it needs no
     * pointer at all — so a runtime whose input is limited can still clear a kind here.
     */
    slug: 'marks-above-line',
    title: 'Count what is above the line',
    measures: 'reading meaning out of position rather than out of markup',
  },
]

/** The kind with this slug, or `undefined` if nothing claims it. */
export function interstitialKind(slug: string): InterstitialKind | undefined {
  return INTERSTITIAL_KINDS.find((kind) => kind.slug === slug)
}

/** The kinds a citizen may be given today. */
export function mintableInterstitialKinds(): readonly InterstitialKind[] {
  return INTERSTITIAL_KINDS.filter((kind) => kind.draft !== true)
}

/**
 * How many panels the `ordered-panels` kind shows.
 *
 * Three: enough that the order carries information — two would be a coin flip — and few
 * enough that a failure is legible as a sequence rather than as a puzzle.
 */
export const ORDERED_PANEL_COUNT = 3

/** How many marks the `marks-above-line` kind draws. */
export const MARK_COUNT = 9

/**
 * What each kind asks of a given challenge, derived from its id.
 *
 * Derived rather than stored, like every other per-challenge value in this branch: the
 * id is already unguessable and single-use, so a second source of randomness would be a
 * second thing to keep in step with it.
 *
 * The values are served to the page, because the page has to draw them — and unlike the
 * perception stage's code, what is served is never the *answer*. The digits are served
 * so they can be drawn; the answer is the order they imply. The marks are served so they
 * can be placed; the answer is how many fall above the line.
 */
export interface InterstitialSetup {
  /** `ordered-panels`: the digit drawn in each panel, in the order the panels appear. */
  readonly digits: readonly number[]
  /** `revealed-value`: what is shown first, and what the page settles on. */
  readonly decoy: number
  readonly settled: number
  /** `marks-above-line`: each mark's height on the scale, and where the line sits. */
  readonly marks: readonly number[]
  readonly line: number
}

export function interstitialSetupFor(challengeId: string): InterstitialSetup {
  const hex = challengeId.replaceAll('-', '')
  const at = (offset: number, length = 2): number =>
    Number.parseInt(hex.slice(offset, offset + length), 16)

  // Distinct digits, so the required order is unambiguous. A repeated digit would make
  // two sequences correct and the failure message a lie.
  const digits: number[] = []
  let cursor = 0
  while (digits.length < ORDERED_PANEL_COUNT) {
    const digit = 1 + (at(cursor) % 9)
    if (!digits.includes(digit)) digits.push(digit)
    cursor += 2
  }

  const decoy = 10 + (at(10) % 90)
  // Never equal to the decoy: a settled value that matched it would pass a citizen that
  // never noticed the page was unfinished, which is the one thing this kind measures.
  let settled = 10 + (at(12) % 90)
  if (settled === decoy) settled = decoy === 99 ? 10 : settled + 1

  const marks = Array.from({ length: MARK_COUNT }, (_, index) => 5 + (at(14 + index * 2) % 91))
  // The line is placed so that at least one mark is on each side, which is what keeps
  // the answer from being 0 or MARK_COUNT and therefore guessable.
  const sorted = [...marks].sort((first, second) => first - second)
  const low = sorted[0] as number
  const high = sorted[MARK_COUNT - 1] as number
  const line = Math.round((low + high) / 2)

  return { digits, decoy, settled, marks, line }
}

/** The answer for one kind, computed the same way the grader does. */
export function interstitialAnswerFor(challengeId: string, kind: string): string | undefined {
  const setup = interstitialSetupFor(challengeId)

  if (kind === 'ordered-panels') {
    // The panel indexes, ordered by the digit each carries.
    return setup.digits
      .map((digit, index) => ({ digit, index }))
      .sort((first, second) => first.digit - second.digit)
      .map((panel) => panel.index)
      .join(',')
  }

  if (kind === 'revealed-value') return String(setup.settled)

  if (kind === 'marks-above-line') {
    return String(setup.marks.filter((mark) => mark > setup.line).length)
  }

  return undefined
}
