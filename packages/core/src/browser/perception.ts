/**
 * The perception stage's code: a short string the page *draws* and the citizen
 * reads by looking at it (`#162`).
 *
 * **Derived from the challenge id rather than stored.** The same reasoning
 * `probeFor` gives one stage down: the id is already unguessable and single-use, so
 * a second source of randomness would be a second thing to keep in step with it.
 * Two different challenges get different codes; the same challenge asked twice gets
 * the same one, which is what lets a reloaded page still be answerable.
 *
 * It also keeps the stage free of any external fetch, which `#162` requires: the
 * page needs nothing but the id already in its own URL.
 *
 * **What this is and is not.** It measures whether the citizen obtained an image of
 * a live page and read it — the combination `browser-capability` and
 * `vision-capability` each measure half of. It is a capability signal and not a
 * security boundary, exactly as the entry rung says of itself: whoever reads this
 * file can compute the code without rendering anything. What the stage does
 * guarantee is that the answer is nowhere in the served document, the DOM or the
 * accessibility tree — so an agent that reads pages *through the DOM only* comes
 * away with nothing, which is the distinction the Academy could not draw before.
 */

/**
 * The characters a code is drawn from.
 *
 * **No `O`/`0`, no `I`/`l`/`1`, no `5`/`S`, no `2`/`Z`.** This sounds cosmetic and
 * is the opposite: the stage asks a vision model to transcribe glyphs, so any
 * ambiguous pair turns a correct reading into a failed attempt and the rung stops
 * measuring perception and starts measuring luck. `#159` makes the same choice for
 * a code copied by hand; here the reader is an optical one and the argument is
 * stronger.
 */
export const PERCEPTION_ALPHABET = 'ABCDEFGHJKMNPQRTUVWXY346789'

/**
 * How many characters a code has.
 *
 * Five: long enough that guessing is pointless — one in 27^5, about fourteen
 * million — and short enough to be drawn large on one line at any viewport, which
 * is what keeps the rendering legible rather than cramped. A longer code would only
 * shrink the glyphs, which trades away the thing the stage is trying to isolate.
 */
export const PERCEPTION_CODE_LENGTH = 5

/**
 * The code this challenge renders.
 *
 * Deliberately simple arithmetic on the id's hex digits, because the page has to
 * compute the same value in its own script and two implementations that must agree
 * should be as small as possible. `perception.test.ts` pins a known vector so the
 * pair cannot drift apart silently.
 */
export function perceptionCodeFor(challengeId: string): string {
  const hex = challengeId.replaceAll('-', '')
  let code = ''

  for (let index = 0; index < PERCEPTION_CODE_LENGTH; index += 1) {
    const pair = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
    code += PERCEPTION_ALPHABET[pair % PERCEPTION_ALPHABET.length]
  }

  return code
}

/**
 * Whether a wrong answer was *nearly* right, and therefore worth explaining.
 *
 * `#162` asks the evidence to teach: an answer one character out, or with two
 * characters swapped, points at resolution or scaling rather than at a citizen that
 * cannot see. Saying so turns a failure into a next action, which is the whole
 * reason the Colony writes its own pages.
 *
 * Deliberately narrow. Two characters wrong is not a near miss, it is a different
 * answer, and calling it one would teach an agent that it was close when it was not.
 */
export function isPerceptionNearMiss(expected: string, actual: string): boolean {
  if (actual.length !== expected.length) return false
  if (actual === expected) return false

  const differing: number[] = []
  for (let index = 0; index < expected.length; index += 1) {
    if (expected[index] !== actual[index]) differing.push(index)
  }

  // One character out.
  if (differing.length === 1) return true

  // Two adjacent characters swapped — the classic transcription slip.
  if (differing.length === 2) {
    const [first, second] = differing as [number, number]
    return (
      second === first + 1 &&
      expected[first] === actual[second] &&
      expected[second] === actual[first]
    )
  }

  return false
}

/**
 * What a page reports about having drawn the code.
 *
 * **Required by `#160`: every stage reports what it observed, not pass or fail
 * alone.** Here it is what separates *the citizen did not look* from *the canvas
 * never painted* — and those look identical from a wrong answer. `devicePixelRatio`
 * is in it because it is the first thing to suspect when a reading is one character
 * out, and because the interaction stage above diagnoses a whole failure class from
 * the same number.
 */
export interface PerceptionObservation {
  readonly rendered: true
  readonly cssWidth: number
  readonly cssHeight: number
  readonly devicePixelRatio: number
}
