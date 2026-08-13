import { byRoute, confidenceOf, totals, windowOf } from '../arithmetic.js'
import type { Finding } from '../finding.js'
import type { DoctorInput } from '../input.js'
import { OVERSIZED_MEAN_BYTES, OVERSIZED_MIN_CALLS, OVERSIZED_WINDOW_BYTES } from '../thresholds.js'

/**
 * Repeated large responses from one route (`#836`).
 *
 * **The bytes half of the original observation.** The episode behind this set
 * moved roughly 346 MB in thirty hours, and the Colony could see the megabytes
 * in Traefik and the citizen in its own database and could join neither to the
 * other. This is the rule that reads the joined figure.
 *
 * **Two ways to fire, because there are two shapes of the same problem.** A
 * route with a large *mean* response is a citizen asking for the whole thing
 * when a narrower call exists; a route with a large *total* is a citizen asking
 * for a reasonable thing far too often. Either is worth a sentence, and a rule
 * that could only see one of them would miss whichever the next citizen has.
 *
 * **The minimum call count is what keeps a legitimate download out of this.** A
 * citizen that fetched one large artefact has done nothing wrong and has nothing
 * to change; twenty of them is a habit.
 *
 * ### What it costs when it is wrong
 *
 * A false positive tells a citizen to ask for less where less would not do —
 * cheap, because the recommendation is an offer and the evidence names the route
 * and the figures, so the citizen can see immediately whether it applies.
 *
 * It is also the rule most likely to *under*-report, and the reason is written
 * at `bytesOf` in `apps/api/src/call-rollup.ts`: a streamed response carries no
 * `content-length` at the moment the rollup is written, and is counted as zero.
 * Avatars and share images are the streamed routes today. This rule is therefore
 * about routes that report a size, and it says so rather than pretending the
 * figure is complete.
 */
export function oversizedReads(input: DoctorInput): readonly Finding[] {
  const findings: Finding[] = []

  for (const route of byRoute(input.hours)) {
    const summed = totals(route.hours)
    if (summed.calls === 0) continue

    const mean = summed.bytesOut / summed.calls
    const byMean = summed.calls >= OVERSIZED_MIN_CALLS && mean >= OVERSIZED_MEAN_BYTES
    const byVolume = summed.bytesOut >= OVERSIZED_WINDOW_BYTES

    if (!byMean && !byVolume) continue

    const window = windowOf(route.hours)

    findings.push({
      kind: 'oversized-reads',
      // Volume is the serious one: a hundred megabytes through a single route is
      // a cost the Colony is carrying now, where a large mean is a shape that
      // will become one.
      severity: byVolume ? 'serious' : 'concern',
      scope: 'agent',
      subject: input.subject,
      evidence: {
        routeKeys: [route.routeKey],
        figures: {
          hours: route.hours.length,
          calls: summed.calls,
          bytesOut: summed.bytesOut,
          meanBytesOut: Math.round(mean),
          maxBytesOut: summed.maxBytesOut,
        },
      },
      confidence: byVolume
        ? confidenceOf(summed.bytesOut, OVERSIZED_WINDOW_BYTES, route.hours.length)
        : confidenceOf(mean, OVERSIZED_MEAN_BYTES, route.hours.length),
      recommendation: 'ask-for-less',
      // Not rate-shaped: the answer is a narrower call, not a slower one, and a
      // retry time here would be advice about the wrong axis.
      retryAfterSeconds: null,
      since: window.since,
      until: window.until,
    })
  }

  return findings
}
