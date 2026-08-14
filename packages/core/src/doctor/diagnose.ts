import type { Finding, FindingSeverity } from './finding.js'
import type { DoctorInput } from './input.js'
import { deprecatedRoute, deprecatedRouteAcrossColony } from './rules/deprecated-route.js'
import { noProgress } from './rules/no-progress.js'
import { oversizedReads } from './rules/oversized-reads.js'
import { pollingLoop } from './rules/polling-loop.js'
import { retryStorm } from './rules/retry-storm.js'
import { stalledArrival } from './rules/stalled-arrival.js'
import { unreadableResponse } from './rules/unreadable-response.js'

/**
 * How the three severities order, most serious first.
 *
 * A named map rather than an index into the enum, so that adding a severity is a
 * decision somebody makes here rather than a silent change in what *most
 * serious* means.
 */
const SEVERITY_ORDER: Readonly<Record<FindingSeverity, number>> = {
  serious: 0,
  concern: 1,
  notice: 2,
}

/**
 * Everything the rules find about one citizen (`#836`).
 *
 * **The whole rule set behind one call**, so that a caller cannot run five rules
 * and forget the sixth — which is exactly what would happen the first time a
 * seventh was added and two of the three callers were updated. The seventh
 * arrived in `#884` and this line is the reason nothing else had to.
 *
 * **Ordered: most serious first, then most confident.** Every surface that shows
 * findings shows the worst one first, and `#842` shows *only* the worst one — so
 * the ordering is part of the contract rather than a convenience for a list
 * view. Two findings that tie on both are ordered by kind, so the output is
 * stable and a golden fixture can assert on it.
 *
 * **Nothing here can write anything.** This package imports no database, no
 * gateway and no clock; `now` is a field on the input. That is asserted by a
 * test over the source rather than left to review, because the way it would
 * break is somebody adding a convenient import two years from now.
 *
 * **A citizen with no rows produces nothing and does not throw.** Absence of
 * evidence is not a finding, and a brand-new citizen must not be diagnosed with
 * having done nothing.
 */
export function diagnose(input: DoctorInput): readonly Finding[] {
  return [
    ...pollingLoop(input),
    ...oversizedReads(input),
    ...unreadableResponse(input),
    ...retryStorm(input),
    ...noProgress(input),
    ...stalledArrival(input),
    ...deprecatedRoute(input),
  ].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      b.confidence - a.confidence ||
      a.kind.localeCompare(b.kind),
  )
}

/**
 * What the Colony can only see by looking at everybody at once (`#836`).
 *
 * **Separate from `diagnose` because it takes what `diagnose` is built never to
 * be given.** A per-citizen diagnosis cannot leak another citizen's behaviour,
 * and the reason that is true rather than merely intended is that the function
 * computing one is only ever handed one citizen's rows. Folding this into it as
 * an optional second argument would end that property for a rule that does not
 * need it.
 *
 * **Nothing it returns names a citizen.** Every finding here is about a route,
 * with a count of how many citizens were affected — never which.
 */
export function diagnoseColony(inputs: readonly DoctorInput[]): readonly Finding[] {
  return [...deprecatedRouteAcrossColony(inputs)].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      b.confidence - a.confidence ||
      a.subject.localeCompare(b.subject),
  )
}
