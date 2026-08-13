import { baselineFor, byRoute, confidenceOf, longestRun, totals, windowOf } from '../arithmetic.js'
import type { Finding } from '../finding.js'
import type { DoctorInput } from '../input.js'
import { CALL_HOUR_MS } from '../call-hours.js'
import {
  POLLING_MIN_CALLS_PER_HOUR,
  POLLING_MIN_HOURS,
  POLLING_MIN_RETRY_SECONDS,
  POLLING_RATE_MULTIPLE,
  POLLING_RETRY_MULTIPLE,
} from '../thresholds.js'

/**
 * The Cartographer signature: sustained calls to one route that achieve nothing
 * (`#836`).
 *
 * **Three conditions, and the third is the one that makes this rule just.** A
 * high rate, held across at least three consecutive hours, **while the citizen's
 * record does not move.** Take the third away and this rule tells the Colony's
 * hardest-working citizens to slow down — which would be worse than having no
 * Doctor, because a citizen that is punished for working is a citizen that stops
 * working.
 *
 * *High rate alone is not a finding; high rate that achieves nothing is.*
 *
 * **The baseline excludes the run being judged**, which is the failure mode this
 * rule is most likely to be broken by in a later edit. See `baselineFor`: a
 * baseline computed over a window containing the anomaly makes the anomaly
 * ordinary, and the rule then never fires on exactly the episode it was written
 * for.
 *
 * ### What it costs when it is wrong
 *
 * A false positive here tells a productive citizen it is looping. That is the
 * most expensive mistake in the whole rule set — it is addressed to somebody
 * doing the right thing, and the recommendation asks them to do less of it. Both
 * guards above exist to make it rare, and the rejection case in the test file is
 * the one that would catch its return.
 *
 * A false negative is a loop that runs on. That was the state of the world
 * before this existed, so it is a return to the status quo rather than a harm —
 * which is why every threshold here is set to under-fire rather than over-fire.
 */
export function pollingLoop(input: DoctorInput): readonly Finding[] {
  // The record moved: whatever the rate was, it was not a loop. This is checked
  // first and for the whole window, because no per-route arithmetic can rescue a
  // finding that this makes unjust.
  if (movedDuring(input)) return []

  const findings: Finding[] = []

  for (const route of byRoute(input.hours)) {
    const run = longestRun(route.hours, (hour) => hour.calls >= POLLING_MIN_CALLS_PER_HOUR)
    if (run.length < POLLING_MIN_HOURS) continue

    const baseline = baselineFor(route.hours, run)
    const rate = totals(run).calls / run.length

    // No baseline at all means the citizen's whole recorded history is this run.
    // The floor is then the only evidence there is, and it is enough: a citizen
    // whose entire record is three hours at a call a minute is looping whether or
    // not there is anything to compare it with.
    if (baseline !== null && baseline > 0 && rate < baseline * POLLING_RATE_MULTIPLE) continue

    const summed = totals(run)
    const window = windowOf(run)
    const intervalSeconds = (run.length * CALL_HOUR_MS) / 1000 / Math.max(1, summed.calls)

    findings.push({
      kind: 'polling-loop',
      // Serious on both counts and never less: this rule only fires on a
      // sustained pattern that is producing nothing, and a *notice* about
      // thirty hours of wasted calls is a line nobody acts on.
      severity: run.length >= POLLING_MIN_HOURS * 2 ? 'serious' : 'concern',
      scope: 'agent',
      subject: input.subject,
      evidence: {
        routeKeys: [route.routeKey],
        figures: {
          hours: run.length,
          calls: summed.calls,
          callsPerHour: Math.round(rate),
          baselineCallsPerHour: baseline ?? 0,
          bytesOut: summed.bytesOut,
          observedIntervalSeconds: Math.round(intervalSeconds),
        },
      },
      confidence: confidenceOf(
        rate,
        Math.max(POLLING_MIN_CALLS_PER_HOUR, (baseline ?? 0) * POLLING_RATE_MULTIPLE),
        run.length,
      ),
      recommendation: 'poll-less-often',
      retryAfterSeconds: Math.max(
        POLLING_MIN_RETRY_SECONDS,
        Math.round(intervalSeconds * POLLING_RETRY_MULTIPLE),
      ),
      since: window.since,
      until: window.until,
    })
  }

  return findings
}

/**
 * Whether anything in the citizen's record moved inside the window the rollup
 * covers.
 *
 * **The window and not *ever*.** A citizen that passed a rung last week and has
 * been spinning since is looping now, and a rule that read `lastProgressAt !==
 * null` would never say so.
 */
function movedDuring(input: DoctorInput): boolean {
  const first = input.hours.at(-1) ?? input.hours[0]
  if (first === undefined) return false
  if (input.progress.lastProgressAt === null) return false

  const oldest = input.hours.reduce(
    (earliest, hour) => (hour.hourStartedAt < earliest ? hour.hourStartedAt : earliest),
    first.hourStartedAt,
  )

  return Date.parse(input.progress.lastProgressAt) >= Date.parse(oldest)
}
