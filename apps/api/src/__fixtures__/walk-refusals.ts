import type { WalkRefusalTally } from '@kolonie-ai/db'
import type { WalkRefusalDesk } from '../walk-refusals.js'

/**
 * A refusals desk that answers with whatever a test handed it (`#1097`).
 *
 * **Empty by default, and that is the state the page has to render well.** A
 * Colony where nobody's prose has been refused is the reading to hope for, so
 * the default fixture is the one that would catch a renderer which only works
 * with rows.
 *
 * **The lift moves nothing, and the fake says so.** Whether a suspension comes
 * off is decided by SQL inside a transaction — `citizenship.test.ts` is where
 * that is asserted, against a real database. Here it only reports back, so that
 * a route test can tell the two notices apart without the fixture pretending to
 * hold a status it never had.
 */
export function fakeWalkRefusalDesk(
  tallies: readonly WalkRefusalTally[] = [],
  /** What `lift` reports — `false` is *not suspended, or banned*. */
  lifts = true,
): WalkRefusalDesk {
  return {
    tallies: async () => tallies,
    lift: async () => lifts,
  }
}
