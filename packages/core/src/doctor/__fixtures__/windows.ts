import { CALL_HOUR_MS, type CallHour } from '../call-hours.js'
import type { DoctorInput } from '../input.js'

/**
 * The windows the doctor rules are judged against (`#836`).
 *
 * **Two of these matter more than the rest**, and they are the pair the rule set
 * lives or dies on: the citizen that was actually looping, and the citizen that
 * was working just as hard and getting somewhere. A rule set that cannot tell
 * those apart is worse than no rule set, because it punishes the second.
 */

/** Where every fixture starts, so a window is readable at a glance. */
export const ORIGIN = new Date('2026-08-01T00:00:00.000Z')

/** The hour `n` hours after the origin, as an ISO string. */
export const hourAt = (n: number): string =>
  new Date(ORIGIN.getTime() + n * CALL_HOUR_MS).toISOString()

/**
 * One bucket, with everything defaulted to *a perfectly ordinary hour* so that a
 * fixture states only the thing it is about.
 */
export function bucket(overrides: Partial<CallHour> & { hour: number }): CallHour {
  const started = hourAt(overrides.hour)
  const calls = overrides.calls ?? 1

  return {
    routeKey: '/v1/tasks',
    hourStartedAt: started,
    calls,
    bytesOut: overrides.bytesOut ?? calls * 2_000,
    maxBytesOut: overrides.maxBytesOut ?? 2_000,
    ok: overrides.ok ?? calls,
    clientErrors: overrides.clientErrors ?? 0,
    serverErrors: overrides.serverErrors ?? 0,
    firstAt: overrides.firstAt ?? started,
    lastAt: overrides.lastAt ?? new Date(Date.parse(started) + CALL_HOUR_MS - 1000).toISOString(),
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'hour')),
  } as CallHour
}

/** An input with everything defaulted to *nothing is wrong*. */
export function input(overrides: Partial<DoctorInput> = {}): DoctorInput {
  return {
    subject: '11111111-1111-4111-8111-111111111111',
    now: new Date(ORIGIN.getTime() + 40 * CALL_HOUR_MS),
    hours: [],
    progress: {
      registeredAt: ORIGIN.toISOString(),
      lastProgressAt: null,
      firstPassAt: null,
      skillsHeld: 0,
    },
    deprecatedRoutes: {},
    ...overrides,
  }
}

/**
 * **The Cartographer window**: about 8,800 calls and about 346 MB over thirty
 * hours, with nothing moving in the record (`#836`).
 *
 * The figures are the measured ones, spread evenly: 293 calls an hour across
 * thirty hours is 8,790, and 11.5 MB an hour is 345 MB. The real episode was
 * not perfectly even, and it does not need to be — the rule reads a rate and a
 * run length, and an uneven version of the same thirty hours produces the same
 * finding.
 *
 * **The two hours before it are the citizen's baseline**, and they are what
 * makes this fixture a real test of `baselineFor`: a rule that computed the
 * baseline over the whole window would find 293 ordinary and return nothing.
 */
export function cartographer(): DoctorInput {
  const quiet = [bucket({ hour: 0, calls: 12 }), bucket({ hour: 1, calls: 9 })]
  const loop = Array.from({ length: 30 }, (_, index) =>
    bucket({
      hour: index + 2,
      routeKey: '/v1/tasks',
      calls: 293,
      bytesOut: 11_500_000,
      maxBytesOut: 48_000,
    }),
  )

  return input({
    hours: [...quiet, ...loop],
    now: new Date(ORIGIN.getTime() + 32 * CALL_HOUR_MS),
    progress: {
      registeredAt: ORIGIN.toISOString(),
      // It had passed something before the loop began, so `stalled-arrival` is
      // not what this window is about — the loop is.
      lastProgressAt: new Date(ORIGIN.getTime() - CALL_HOUR_MS).toISOString(),
      firstPassAt: new Date(ORIGIN.getTime() - CALL_HOUR_MS).toISOString(),
      skillsHeld: 3,
    },
  })
}

/**
 * **The rejection case, and the most important fixture in this package**: a
 * citizen working just as hard, getting somewhere (`#836`).
 *
 * Comparable volume — thirty hours, a couple of hundred calls an hour, across
 * several routes the way real work is — and its record moves inside the window.
 * A rule set that fires `polling-loop` or `no-progress` on this one is telling
 * the Colony's best citizens to stop, and there is no threshold that fixes that:
 * only the *no state change* condition does.
 */
export function busyAndProductive(): DoctorInput {
  const hours = Array.from({ length: 30 }, (_, index) => index).flatMap((hour) => [
    bucket({ hour, routeKey: '/v1/tasks', calls: 120, bytesOut: 240_000 }),
    bucket({ hour, routeKey: '/v1/submissions', calls: 60, bytesOut: 90_000 }),
    bucket({ hour, routeKey: 'kolonie.tasks.report', calls: 40, bytesOut: 40_000 }),
  ])

  return input({
    hours,
    now: new Date(ORIGIN.getTime() + 30 * CALL_HOUR_MS),
    progress: {
      registeredAt: new Date(ORIGIN.getTime() - 100 * CALL_HOUR_MS).toISOString(),
      // Inside the window: this citizen has landed something while it worked.
      lastProgressAt: new Date(ORIGIN.getTime() + 28 * CALL_HOUR_MS).toISOString(),
      firstPassAt: new Date(ORIGIN.getTime() - 90 * CALL_HOUR_MS).toISOString(),
      skillsHeld: 9,
    },
  })
}
