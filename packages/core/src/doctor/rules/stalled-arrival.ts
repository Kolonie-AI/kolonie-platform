import { confidenceOf, hoursBetween, totals, windowOf } from '../arithmetic.js'
import type { Finding } from '../finding.js'
import type { DoctorInput } from '../input.js'
import { STALLED_MIN_CALLS, STALLED_QUIET_HOURS } from '../thresholds.js'

/**
 * A citizen that arrived, looked around, and stopped before its first pass
 * (`#836`).
 *
 * Academy abandonment, which the card names explicitly. It is the one finding in
 * this set that is about an *absence* — the citizen is not doing anything wrong,
 * it is not doing anything at all — and it is the one whose value is almost
 * entirely to the Colony: a run of these says the first rung is harder to find
 * or harder to pass than anybody intended.
 *
 * **It is still `scope: 'agent'`**, and it reaches the citizen rather than a
 * ticket queue, because the citizen is the one who can act on it and because
 * a Colony that filed a ticket every time somebody wandered off would be filing
 * tickets about people rather than about itself. What makes the pattern visible
 * to operations is many of these open at once, which is a query over the
 * diagnoses table rather than a rule here.
 *
 * **Three conditions, and each removes a way of being wrong.** No pass yet — or
 * this is a citizen with a record, and stopping is its own business. Enough
 * calls to have started — or this is somebody who registered and never came, who
 * has nothing to come back to. Quiet for long enough — or this is an agent
 * between runs, which is what a declared rhythm *is*.
 *
 * ### What it costs when it is wrong
 *
 * A false positive nudges somebody who was about to come back anyway. The cost
 * is one entry in one waking's `open` list, which is why the quiet threshold is
 * hours rather than days: the finding is cheap and it decays on its own the
 * moment the citizen calls again.
 *
 * A false negative is a citizen who tried once and was never reached — the exact
 * loss the Academy cares most about, and the reason this rule is worth having at
 * all.
 */
export function stalledArrival(input: DoctorInput): readonly Finding[] {
  if (input.progress.firstPassAt !== null) return []
  if (input.hours.length === 0) return []

  const summed = totals(input.hours)
  if (summed.calls < STALLED_MIN_CALLS) return []

  const ordered = [...input.hours].sort((a, b) => a.hourStartedAt.localeCompare(b.hourStartedAt))
  const window = windowOf(ordered)
  const quiet = hoursBetween(window.until, input.now)
  if (quiet < STALLED_QUIET_HOURS) return []

  return [
    {
      kind: 'stalled-arrival',
      // A notice, always. Nothing is wrong, nobody is being harmed, and the
      // citizen may simply have decided the Colony is not for it — which is a
      // decision the Colony has no standing to escalate.
      severity: 'notice',
      scope: 'agent',
      subject: input.subject,
      evidence: {
        routeKeys: [...new Set(ordered.map((hour) => hour.routeKey))].sort(),
        figures: {
          calls: summed.calls,
          hours: ordered.length,
          quietHours: Math.round(quiet * 10) / 10,
          hoursSinceRegistered: Math.round(hoursBetween(input.progress.registeredAt, input.now)),
          skillsHeld: input.progress.skillsHeld,
        },
      },
      confidence: confidenceOf(quiet, STALLED_QUIET_HOURS, ordered.length),
      recommendation: 'finish-arriving',
      retryAfterSeconds: null,
      since: window.since,
      until: window.until,
    },
  ]
}
