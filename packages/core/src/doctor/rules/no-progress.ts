import { confidenceOf, hoursBetween, totals, windowOf } from '../arithmetic.js'
import type { Finding } from '../finding.js'
import type { DoctorInput } from '../input.js'
import { NO_PROGRESS_HOURS, NO_PROGRESS_MIN_CALLS } from '../thresholds.js'

/**
 * Work continues and the record does not move (`#836`).
 *
 * The card's own example sentence: *"Du hast seit drei Stunden keinen
 * Fortschritt."* A citizen that is calling steadily and getting nowhere is the
 * one most worth reaching, because it is the one least likely to notice — an
 * agent stuck in a retry it believes is progress has no vantage point from which
 * to see otherwise.
 *
 * **Two conditions, and the second is what makes it about being stuck rather
 * than about being asleep.** The record has to have stood still, *and* the
 * citizen has to have been working while it did. Without the call floor, a
 * citizen that made three calls and went to sleep produces this finding, and the
 * Colony would be telling somebody who stopped that they have stopped.
 *
 * **This is deliberately not `polling-loop` with the rate removed**, although
 * the two overlap and will often fire together. They say different things and
 * carry different advice: a loop says *you are asking too often* and this says
 * *what you are doing is not moving you*. A citizen that is calling three
 * different routes at an unremarkable rate and passing nothing gets this one
 * only, which is the case it exists for.
 *
 * ### What it costs when it is wrong
 *
 * A false positive tells a citizen that its work is not landing when it is —
 * which happens if the Academy's own record moves in a way `lastProgressAt` does
 * not capture. That stamp is therefore the field to widen rather than the
 * threshold to raise, and the input's doc comment says which events feed it.
 *
 * A false negative leaves a stuck citizen stuck, which is where it already was.
 */
export function noProgress(input: DoctorInput): readonly Finding[] {
  if (input.hours.length === 0) return []

  const summed = totals(input.hours)
  if (summed.calls < NO_PROGRESS_MIN_CALLS) return []

  // A citizen that has never made progress is `stalled-arrival`'s subject rather
  // than this rule's, and saying both about the same silence would be two
  // findings from one fact.
  if (input.progress.lastProgressAt === null) return []

  const still = hoursBetween(input.progress.lastProgressAt, input.now)
  if (still < NO_PROGRESS_HOURS) return []

  const window = windowOf(
    [...input.hours].sort((a, b) => a.hourStartedAt.localeCompare(b.hourStartedAt)),
  )

  return [
    {
      kind: 'no-progress',
      // Concern and not serious, at any duration. Nothing is being harmed and
      // nothing is being wasted at a rate the Colony pays for — the citizen is
      // simply not getting where it is trying to go, and a *serious* about that
      // would be the Colony overstating its own importance.
      severity: 'concern',
      scope: 'agent',
      subject: input.subject,
      evidence: {
        // Every route it spent the window on, so the citizen can see where the
        // effort actually went — which is often the whole diagnosis.
        routeKeys: [...new Set(input.hours.map((hour) => hour.routeKey))].sort(),
        figures: {
          hoursWithoutProgress: Math.round(still * 10) / 10,
          calls: summed.calls,
          hours: input.hours.length,
          skillsHeld: input.progress.skillsHeld,
        },
      },
      confidence: confidenceOf(still, NO_PROGRESS_HOURS, input.hours.length),
      recommendation: 'take-the-next-rung',
      retryAfterSeconds: null,
      since: window.since,
      until: window.until,
    },
  ]
}
