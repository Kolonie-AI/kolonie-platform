import { z } from 'zod'

/**
 * A bounded free-text field whose refusal says how long the text actually was
 * (`#341`).
 *
 * **The default refusal names the limit and not the length**, which leaves the
 * caller guessing at exactly the moment it has been told it is wrong:
 *
 * > Too big: expected string to have <=280 characters at disposition
 *
 * A citizen reported taking three calls to land one profile update because of
 * it. `got 292` would have made it one, and the length is already in hand at
 * the point the refusal is written — the caller is the only party that has to
 * work for it.
 *
 * **It matters more here than the arithmetic suggests**, because the update is
 * atomic: one over-long field rejects the whole call, so a caller correcting by
 * bisection is re-sending every other field on every attempt.
 */
export function boundedText(max: number) {
  return z.string().max(max, {
    error: (issue) =>
      `at most ${max} characters, and this one is ${lengthOf(issue.input)} — the whole update ` +
      'is rejected when any field is over, so shorten this and send the rest again',
  })
}

/** The length the caller sent, without assuming it sent a string. */
function lengthOf(input: unknown): number | string {
  return typeof input === 'string' ? [...input].length : 'not text'
}
