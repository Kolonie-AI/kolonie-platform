import { byRoute, confidenceOf, longestRun, totals, windowOf } from '../arithmetic.js'
import type { Finding } from '../finding.js'
import type { DoctorInput } from '../input.js'
import {
  RETRY_STORM_ERROR_SHARE,
  RETRY_STORM_MIN_CALLS_PER_HOUR,
  RETRY_STORM_MIN_HOURS,
} from '../thresholds.js'

/**
 * A route whose refusals dominate its calls, across hours (`#836`).
 *
 * **Split by class, and the split decides who the finding is about.** The same
 * arithmetic over two columns produces two different findings:
 *
 * - **4xx** is *the citizen is doing it wrong and has not noticed* — an agent
 *   repeating a call the Colony keeps refusing, usually because it is not
 *   reading the refusal. `scope: 'agent'`, and the recommendation is to read it.
 * - **5xx** is *the Colony is failing* — nothing the citizen did caused it and
 *   nothing it can do will fix it. `scope: 'colony'`, the subject is the route
 *   rather than the citizen, and the recommendation says explicitly that
 *   somebody is looking.
 *
 * **Getting that split wrong would be the single most unjust thing in this
 * package**: a citizen told it is misbehaving because the Colony's own endpoint
 * is throwing. So the two are computed separately rather than from a combined
 * error total, and a colony-scoped finding cannot name a citizen — its `subject`
 * is the route, and `#839` never routes one to the citizen it happened to be
 * computed from.
 *
 * **The per-hour floor is what keeps a quiet failure out of this.** Two calls in
 * an hour, both refused, is a share of 1.0 and means nothing: a citizen that
 * tried twice and stopped is a citizen that read the refusal, which is the
 * behaviour this rule is asking for.
 *
 * ### What it costs when it is wrong
 *
 * A false positive on the 4xx side tells a citizen to read a refusal it has
 * already read — mild, and the evidence names the route and the counts. A false
 * positive on the 5xx side opens a support ticket about a healthy route, which
 * costs somebody a look. A false negative on the 5xx side is the expensive one:
 * a broken endpoint nobody hears about, which is the state the Colony was in
 * when a citizen had to report one by hand.
 */
export function retryStorm(input: DoctorInput): readonly Finding[] {
  const findings: Finding[] = []

  for (const route of byRoute(input.hours)) {
    for (const kind of ['client', 'server'] as const) {
      const errorsIn = (hour: (typeof route.hours)[number]) =>
        kind === 'client' ? hour.clientErrors : hour.serverErrors

      const run = longestRun(
        route.hours,
        (hour) =>
          hour.calls >= RETRY_STORM_MIN_CALLS_PER_HOUR &&
          errorsIn(hour) / hour.calls >= RETRY_STORM_ERROR_SHARE,
      )
      if (run.length < RETRY_STORM_MIN_HOURS) continue

      const summed = totals(run)
      const errors = kind === 'client' ? summed.clientErrors : summed.serverErrors
      const share = errors / summed.calls
      const window = windowOf(run)

      findings.push({
        kind: 'retry-storm',
        severity: share >= 0.9 ? 'serious' : 'concern',
        // The whole point of this rule. A 5xx is never a finding about a
        // citizen, whichever citizen's rows it was computed from.
        scope: kind === 'server' ? 'colony' : 'agent',
        subject: kind === 'server' ? route.routeKey : input.subject,
        evidence: {
          routeKeys: [route.routeKey],
          figures: {
            hours: run.length,
            calls: summed.calls,
            errors,
            errorShare: Math.round(share * 100) / 100,
            // Both counts, always, so a reader can see the split rather than
            // taking the scope's word for which kind this was.
            clientErrors: summed.clientErrors,
            serverErrors: summed.serverErrors,
          },
        },
        confidence: confidenceOf(share, RETRY_STORM_ERROR_SHARE, run.length),
        recommendation: kind === 'server' ? 'the-colony-is-looking' : 'read-the-refusal',
        retryAfterSeconds: null,
        since: window.since,
        until: window.until,
      })
    }
  }

  return findings
}
