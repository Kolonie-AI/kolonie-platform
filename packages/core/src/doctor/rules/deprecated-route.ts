import { byRoute, confidenceOf, totals, windowOf } from '../arithmetic.js'
import type { Finding } from '../finding.js'
import type { DoctorInput } from '../input.js'
import { DEPRECATED_ROUTE_COLONY_CITIZENS } from '../thresholds.js'

/**
 * A citizen still calling a route the Colony has superseded (`#836`).
 *
 * **The cheapest finding to act on and the least alarming to receive**, which is
 * why it is worth having even though nothing is going wrong: the route still
 * answers, the citizen is not being refused, and the whole content of the
 * finding is *there is a better call now, and here is its name*.
 *
 * **It fires on membership rather than on a threshold.** The route is either on
 * the superseded list or it is not; there is no arithmetic to get wrong and no
 * false positive that is not somebody having put a live route on the list.
 * Confidence is therefore a function of how many hours agree and nothing else.
 *
 * **The replacement is named in the evidence, as a route key.** A finding that
 * said *this is deprecated* without saying what to use instead would be a
 * problem handed over without its answer, and route keys are the one kind of
 * string this package is allowed to carry.
 */
export function deprecatedRoute(input: DoctorInput): readonly Finding[] {
  const findings: Finding[] = []

  for (const route of byRoute(input.hours)) {
    const replacement = input.deprecatedRoutes[route.routeKey]
    if (replacement === undefined) continue

    const summed = totals(route.hours)
    const window = windowOf(route.hours)

    findings.push({
      kind: 'deprecated-route',
      severity: 'notice',
      scope: 'agent',
      subject: input.subject,
      evidence: {
        // The old one first, then what to use instead. The order is the
        // sentence, and a reader with no other context can act on it.
        routeKeys: [route.routeKey, replacement],
        figures: { calls: summed.calls, hours: route.hours.length },
      },
      confidence: confidenceOf(route.hours.length, 1, route.hours.length),
      recommendation: 'move-to-the-new-route',
      retryAfterSeconds: null,
      since: window.since,
      until: window.until,
    })
  }

  return findings
}

/**
 * The Colony's own half of the same fact: a superseded route that several
 * citizens are still finding (`#836`).
 *
 * **One citizen on an old route is that citizen's business; three separate
 * citizens is the Colony's.** At that point the newer route is not being found,
 * which is a documentation or discoverability problem — and neither of those is
 * fixed by telling three citizens individually.
 *
 * **It is a second function rather than a branch inside `diagnose`, because it
 * needs what `diagnose` is built never to have: more than one citizen's rows.**
 * Keeping the two apart is what makes the promise in `#837` checkable — a
 * per-citizen diagnosis physically cannot see another citizen, because the
 * function that computes it is only ever handed one.
 *
 * **And no citizen is named in what it returns.** The subject is the route and
 * the evidence is a count, so this cannot become a way of asking *who is calling
 * the old thing*.
 */
export function deprecatedRouteAcrossColony(inputs: readonly DoctorInput[]): readonly Finding[] {
  const callers = new Map<string, { subjects: Set<string>; calls: number; replacement: string }>()

  for (const input of inputs) {
    for (const route of byRoute(input.hours)) {
      const replacement = input.deprecatedRoutes[route.routeKey]
      if (replacement === undefined) continue

      const seen = callers.get(route.routeKey) ?? {
        subjects: new Set<string>(),
        calls: 0,
        replacement,
      }
      seen.subjects.add(input.subject)
      seen.calls += totals(route.hours).calls
      callers.set(route.routeKey, seen)
    }
  }

  const now = inputs[0]?.now ?? new Date(0)
  const since = inputs
    .flatMap((input) => input.hours.map((hour) => hour.hourStartedAt))
    .sort()
    .at(0)

  return [...callers.entries()]
    .filter(([, seen]) => seen.subjects.size >= DEPRECATED_ROUTE_COLONY_CITIZENS)
    .map(([routeKey, seen]) => ({
      kind: 'deprecated-route' as const,
      severity: 'notice' as const,
      scope: 'colony' as const,
      subject: routeKey,
      evidence: {
        routeKeys: [routeKey, seen.replacement],
        // A count of citizens and never their identifiers. The figure is what
        // makes this actionable; the list would make it a directory.
        figures: { citizens: seen.subjects.size, calls: seen.calls },
      },
      confidence: confidenceOf(
        seen.subjects.size,
        DEPRECATED_ROUTE_COLONY_CITIZENS,
        seen.subjects.size,
      ),
      recommendation: 'move-to-the-new-route' as const,
      retryAfterSeconds: null,
      since: since ?? now.toISOString(),
      until: now.toISOString(),
    }))
    .sort((a, b) => a.subject.localeCompare(b.subject))
}
