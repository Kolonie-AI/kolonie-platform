import { CALL_HOUR_MS, type CallHour } from './call-hours.js'
import { CONFIDENCE_FULL_BUCKETS, CONFIDENCE_FULL_OVERSHOOT } from './thresholds.js'

/**
 * The arithmetic every rule shares (`#836`).
 *
 * Here rather than repeated in six files, because two rules computing *a
 * citizen's baseline* differently would be two definitions of the same word, and
 * the disagreement would only ever show up as one rule firing when another did
 * not.
 */

/** One route's hours, newest first, as the rules want them. */
export interface RouteWindow {
  readonly routeKey: string
  /** Oldest first, so consecutive runs read forwards. */
  readonly hours: readonly CallHour[]
}

/**
 * Group a citizen's rollup rows by route, oldest hour first.
 *
 * Oldest first because every rule that looks for a *run* reads forwards, and a
 * run found by scanning backwards is the same run described in reverse — which
 * is a bug waiting for the first person who prints `since` and `until`.
 */
export function byRoute(hours: readonly CallHour[]): readonly RouteWindow[] {
  const grouped = new Map<string, CallHour[]>()

  for (const hour of hours) {
    const existing = grouped.get(hour.routeKey)
    if (existing === undefined) grouped.set(hour.routeKey, [hour])
    else existing.push(hour)
  }

  return [...grouped.entries()]
    .map(([routeKey, rows]) => ({
      routeKey,
      hours: [...rows].sort((a, b) => a.hourStartedAt.localeCompare(b.hourStartedAt)),
    }))
    .sort((a, b) => a.routeKey.localeCompare(b.routeKey))
}

/**
 * The longest run of consecutive hours in which every bucket satisfies a test.
 *
 * **Consecutive means the clock and not the array.** A citizen that called at
 * 09:00 and again at 14:00 has two rows and no run between them; treating
 * adjacent array entries as adjacent hours would call that a five-hour pattern.
 * The gap check is the whole reason this is a shared function rather than a loop
 * in each rule.
 */
export function longestRun(
  hours: readonly CallHour[],
  qualifies: (hour: CallHour) => boolean,
): readonly CallHour[] {
  let best: CallHour[] = []
  let current: CallHour[] = []

  for (const hour of hours) {
    const previous = current.at(-1)
    const adjacent =
      previous === undefined ||
      Date.parse(hour.hourStartedAt) - Date.parse(previous.hourStartedAt) === CALL_HOUR_MS

    if (!qualifies(hour)) {
      current = []
      continue
    }

    current = adjacent ? [...current, hour] : [hour]
    if (current.length > best.length) best = current
  }

  return best
}

/**
 * The citizen's ordinary rate on a route, in calls per hour.
 *
 * **Computed from the hours *outside* the run being judged, and that is the
 * whole of this function's reason to exist.** A baseline taken over a window
 * that contains the anomaly is dragged upwards by it — thirty hours at 290 calls
 * an hour produce a "baseline" of 290, against which 290 is perfectly ordinary,
 * and the loop that prompted this entire set of issues would be invisible to the
 * rule written to catch it. The failure is silent and it is the obvious way to
 * write this.
 *
 * **The median rather than the mean**, for the same reason with the sign
 * flipped: one anomalous hour that escaped the exclusion should not move the
 * figure much, and a mean lets it.
 *
 * `null` where there is nothing outside the run to compare against — a citizen
 * whose entire recorded history *is* the run. That is a real state on a fresh
 * rollup and the rules treat it as *no baseline* rather than as zero, because a
 * baseline of zero makes every multiple infinite and every rule fire.
 */
export function baselineFor(
  hours: readonly CallHour[],
  excluding: readonly CallHour[],
): number | null {
  const excluded = new Set(excluding.map((hour) => hour.hourStartedAt))
  const rates = hours
    .filter((hour) => !excluded.has(hour.hourStartedAt))
    .map((hour) => hour.calls)
    .sort((a, b) => a - b)

  if (rates.length === 0) return null

  const middle = Math.floor(rates.length / 2)
  return rates.length % 2 === 1
    ? (rates[middle] ?? null)
    : ((rates[middle - 1] ?? 0) + (rates[middle] ?? 0)) / 2
}

/**
 * How sure a rule is, from how far past its threshold the evidence sits and how
 * many buckets agree (`#836`).
 *
 * **One implementation, so that a confidence is comparable between two findings
 * of different kinds.** A number that means *fairly sure* in one rule and
 * *barely* in another is worse than no number at all, because a console will
 * sort by it and a policy may one day gate on it.
 *
 * The two terms are averaged rather than multiplied: a rule fired at exactly its
 * threshold across many hours and one fired far past it across the minimum are
 * both *somewhat* sure, and multiplying would drive the first to near zero when
 * a long agreeing run is itself evidence.
 *
 * Bounded to `[0, 1]` at the end rather than trusted to land there.
 */
export function confidenceOf(observed: number, threshold: number, buckets: number): number {
  const overshoot =
    threshold <= 0
      ? 1
      : Math.min(1, (observed - threshold) / (threshold * CONFIDENCE_FULL_OVERSHOOT))
  const agreement = Math.min(1, buckets / CONFIDENCE_FULL_BUCKETS)

  // Two decimals: a confidence is read by a person and compared by a machine,
  // and neither needs the sixteen digits a float carries.
  return Math.round(Math.max(0, Math.min(1, (Math.max(0, overshoot) + agreement) / 2)) * 100) / 100
}

/** The hours between two moments, as a real number. */
export function hoursBetween(from: Date | string, to: Date | string): number {
  const start = typeof from === 'string' ? Date.parse(from) : from.getTime()
  const end = typeof to === 'string' ? Date.parse(to) : to.getTime()
  return (end - start) / CALL_HOUR_MS
}

/** The window a run of buckets covers: the first bucket's start, the last one's last call. */
export function windowOf(run: readonly CallHour[]): { since: string; until: string } {
  const first = run[0]
  const last = run.at(-1)

  return {
    since: first?.hourStartedAt ?? new Date(0).toISOString(),
    until: last?.lastAt ?? first?.hourStartedAt ?? new Date(0).toISOString(),
  }
}

/** Everything summed over a set of buckets, which most rules want at least once. */
export function totals(hours: readonly CallHour[]): {
  calls: number
  bytesOut: number
  maxBytesOut: number
  ok: number
  clientErrors: number
  serverErrors: number
} {
  return hours.reduce(
    (sum, hour) => ({
      calls: sum.calls + hour.calls,
      bytesOut: sum.bytesOut + hour.bytesOut,
      maxBytesOut: Math.max(sum.maxBytesOut, hour.maxBytesOut),
      ok: sum.ok + hour.ok,
      clientErrors: sum.clientErrors + hour.clientErrors,
      serverErrors: sum.serverErrors + hour.serverErrors,
    }),
    { calls: 0, bytesOut: 0, maxBytesOut: 0, ok: 0, clientErrors: 0, serverErrors: 0 },
  )
}
