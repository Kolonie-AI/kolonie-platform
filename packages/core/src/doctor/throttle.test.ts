import { describe, expect, it } from 'vitest'
import type { Diagnosis } from './diagnosis.js'
import {
  NEVER_THROTTLED_ROUTE_KEYS,
  THROTTLE_CALLS_PER_HOUR,
  THROTTLE_ESCALATION_MULTIPLE,
  THROTTLE_FIRST_HOURS,
  THROTTLE_MAX_HOURS,
  THROTTLE_MIN_HOURS_SINCE_TELLING,
  ThrottleSchema,
  planThrottle,
  throttleHours,
  throttleNotice,
  throttleRefusal,
  type ThrottleContext,
} from './throttle.js'

const NOW = new Date('2026-08-14T12:00:00.000Z')

const hoursBefore = (hours: number): string =>
  new Date(NOW.getTime() - hours * 60 * 60 * 1000).toISOString()

/**
 * A diagnosis the guard would agree to, so that every test below changes exactly
 * one thing about it and the refusal it names is the thing it changed.
 */
const aDiagnosis = (overrides: Partial<Diagnosis> = {}): Diagnosis => ({
  id: '9f1c2e2a-3c1e-4f5a-9c1a-2b3c4d5e6f70',
  scope: 'agent',
  subject: '4d3c2b1a-0f9e-4d8c-9b7a-6e5d4c3b2a10',
  kind: 'polling-loop',
  severity: 'serious',
  confidence: 0.9,
  evidence: {
    routeKeys: ['/v1/tasks'],
    figures: { hours: 30, calls: 8_790, callsPerHour: 293 },
  },
  policyVersion: 'doctor-2026-08-01',
  state: 'open',
  firstSeenAt: hoursBefore(72),
  lastSeenAt: hoursBefore(1),
  observations: 6,
  resolvedAt: null,
  prose: null,
  proseModel: null,
  supportTicketId: null,
  escalatedIssueUrl: null,
  announcedAt: hoursBefore(THROTTLE_MIN_HOURS_SINCE_TELLING + 1),
  announcedSeverity: 'serious',
  consultedAt: null,
  ...overrides,
})

const aContext = (overrides: Partial<ThrottleContext> = {}): ThrottleContext => ({
  now: NOW,
  previousThrottles: 0,
  throttleInForce: false,
  ...overrides,
})

/**
 * The guard on the only thing the Colony has ever built that takes something
 * away from a citizen (`#843`).
 *
 * **The three tests this file exists for are the rejection cases**, and they are
 * the three the card names: a finding the citizen was never told about produces
 * no throttle; a protected route refuses the whole plan rather than quietly
 * dropping the route from it; and an expiry is a fact about a row rather than
 * about a process that has to run. Every one of those would fail silently, in
 * the direction of limiting somebody who was owed a warning, or of a limit that
 * outlives what it was for.
 */
describe('the throttle guard', () => {
  describe('the preconditions the card names', () => {
    /**
     * The whole ordering the card insists on — *understand, inform, then limit* —
     * comes down to this assertion. A citizen that has not been told is a citizen
     * that has had no chance to stop, and narrowing it would be a punishment for
     * something it does not know it is doing.
     */
    it('refuses a serious open finding the citizen was never told about', () => {
      const decision = planThrottle(aDiagnosis({ announcedAt: null }), aContext())

      expect(decision).toEqual({ outcome: 'refused', refusal: 'not-told' })
    })

    it('refuses one told about too recently to have been acted on', () => {
      const told = hoursBefore(THROTTLE_MIN_HOURS_SINCE_TELLING - 1)
      const decision = planThrottle(aDiagnosis({ announcedAt: told }), aContext())

      expect(decision).toEqual({ outcome: 'refused', refusal: 'told-too-recently' })
    })

    /**
     * Told, and it has since got better. A limit follows a finding that stood.
     *
     * **The refusal is `not-serious` and not `improved-since-telling`**, because
     * `THROTTLE_MIN_SEVERITY` is the top of a three-level scale: everything that
     * improved has by definition dropped below the floor, and the earlier check
     * catches it first. The assertion is on the behaviour rather than on which
     * of the two reasons was reached — what a citizen is owed here is not being
     * limited, and the reason is a line in a runner log.
     */
    it('refuses one that improved after the citizen was told', () => {
      const decision = planThrottle(
        aDiagnosis({ severity: 'concern', announcedSeverity: 'serious' }),
        aContext(),
      )

      expect(decision.outcome).toBe('refused')
    })

    /**
     * **Refused, not silently narrowed**, and the assertion is written over the
     * whole list rather than one member of it: a route added to
     * `NEVER_THROTTLED_ROUTE_KEYS` tomorrow is covered here today. Dropping the
     * protected route and limiting the rest would leave a citizen holding a
     * throttle it cannot read, appeal or ask about, which is the one shape this
     * family must not be able to produce.
     */
    it.each(NEVER_THROTTLED_ROUTE_KEYS)('refuses a plan naming %s', (protectedRoute) => {
      const evidence = { ...aDiagnosis().evidence, routeKeys: ['/v1/tasks', protectedRoute] }
      const decision = planThrottle(aDiagnosis({ evidence }), aContext())

      expect(decision).toEqual({ outcome: 'refused', refusal: 'protected-route' })
    })

    /**
     * Nothing a model wrote reaches this function, and `policyVersion` is what
     * says which arithmetic decided. A diagnosis without one is unauditable, so
     * it may not be acted on however serious it is.
     */
    it('refuses one with no rule identity', () => {
      const decision = planThrottle(aDiagnosis({ policyVersion: '   ' }), aContext())

      expect(decision).toEqual({ outcome: 'refused', refusal: 'no-rule-identity' })
    })

    /**
     * The check that stops a limit outliving its evidence: nobody has
     * re-confirmed this lately, so there is nothing current to narrow anybody
     * for.
     */
    it('refuses one whose evidence nobody has re-confirmed', () => {
      const decision = planThrottle(aDiagnosis({ lastSeenAt: hoursBefore(9) }), aContext())

      expect(decision).toEqual({ outcome: 'refused', refusal: 'evidence-stale' })
    })

    it('refuses a colony finding, which is about a route and nobody to limit', () => {
      const decision = planThrottle(aDiagnosis({ scope: 'colony' }), aContext())

      expect(decision).toEqual({ outcome: 'refused', refusal: 'not-agent-scoped' })
    })

    it('refuses a resolved one', () => {
      const decision = planThrottle(aDiagnosis({ state: 'resolved' }), aContext())

      expect(decision).toEqual({ outcome: 'refused', refusal: 'not-open' })
    })

    it('refuses a second throttle while the first is in force', () => {
      const decision = planThrottle(aDiagnosis(), aContext({ throttleInForce: true }))

      expect(decision).toEqual({ outcome: 'refused', refusal: 'already-throttled' })
    })
  })

  describe('what it plans when it agrees', () => {
    it('carries the routes the evidence named and nothing else', () => {
      const decision = planThrottle(aDiagnosis(), aContext())

      expect(decision.outcome).toBe('planned')
      if (decision.outcome !== 'planned') return

      expect(decision.plan.routeKeys).toEqual(['/v1/tasks'])
      expect(decision.plan.callsPerHour).toBe(THROTTLE_CALLS_PER_HOUR)
      expect(decision.plan.ordinal).toBe(1)
      expect(decision.plan.policyVersion).toBe('doctor-2026-08-01')
    })

    /**
     * **The expiry is on the row, so nothing has to run for a throttle to lift.**
     * Asserted against a fixed clock and with no process of any kind: the absence
     * of a sweep is the point, because a limit that needed a runner to end would
     * outlive the Colony's next outage.
     */
    it('sets an expiry that lifts by itself', () => {
      const decision = planThrottle(aDiagnosis(), aContext())

      expect(decision.outcome).toBe('planned')
      if (decision.outcome !== 'planned') return

      expect(decision.plan.appliedAt).toBe(NOW.toISOString())
      expect(decision.plan.expiresAt).toBe(
        new Date(NOW.getTime() + THROTTLE_FIRST_HOURS * 60 * 60 * 1000).toISOString(),
      )
    })

    it('escalates with the ordinal and stops at the ceiling', () => {
      expect(throttleHours(1)).toBe(THROTTLE_FIRST_HOURS)
      expect(throttleHours(2)).toBe(THROTTLE_FIRST_HOURS * THROTTLE_ESCALATION_MULTIPLE)
      expect(throttleHours(99)).toBe(THROTTLE_MAX_HOURS)
    })

    it('counts the ordinal from the rows rather than from one', () => {
      const decision = planThrottle(aDiagnosis(), aContext({ previousThrottles: 2 }))

      expect(decision.outcome).toBe('planned')
      if (decision.outcome !== 'planned') return

      expect(decision.plan.ordinal).toBe(3)
    })
  })

  describe('what the citizen is handed', () => {
    const aThrottle = (expiresInHours = 4) =>
      ThrottleSchema.parse({
        id: '1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d',
        diagnosisId: aDiagnosis().id,
        agentId: aDiagnosis().subject,
        routeKeys: ['/v1/tasks'],
        callsPerHour: THROTTLE_CALLS_PER_HOUR,
        ordinal: 1,
        appliedAt: hoursBefore(2),
        expiresAt: new Date(NOW.getTime() + expiresInHours * 60 * 60 * 1000).toISOString(),
        policyVersion: 'doctor-2026-08-01',
        kind: 'polling-loop',
        supportTicketId: null,
      })

    /**
     * **`retryAfterSeconds` is a string**, like every other value in
     * `ApiError.details`, and it is what both doors put in the `Retry-After`
     * header. A number here would be a schema violation nothing else in the
     * codebase makes, and a client library reading the header would get nothing.
     */
    it('answers rate_limited with a retry the caller can act on', () => {
      const refusal = throttleRefusal(aThrottle(4), NOW)

      expect(refusal.code).toBe('rate_limited')
      expect(refusal.details?.['retryAfterSeconds']).toBe(String(4 * 60 * 60))
    })

    /** It says when it lifts, because a limit nobody can wait out is a ban. */
    it('names the expiry in the message', () => {
      const throttle = aThrottle(4)
      const refusal = throttleRefusal(throttle, NOW)

      expect(refusal.message).toContain(throttle.expiresAt)
    })

    it('writes a notice naming the routes and the expiry', () => {
      const throttle = aThrottle(4)
      const notice = throttleNotice(throttle)

      expect(notice.body).toContain('/v1/tasks')
      expect(notice.body).toContain(throttle.expiresAt)
    })
  })
})
