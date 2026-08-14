import { describe, expect, it } from 'vitest'
import { NARROWER_CALL_FOR, unreadableResponse } from './unreadable-response.js'
import { bucket, input } from '../__fixtures__/windows.js'
import { UNREADABLE_RESPONSE_BYTES } from '../thresholds.js'

/**
 * One response too large for the caller to take (`#884`).
 *
 * **The rejection case is the test this file exists for**, and it is the second
 * one below: a window whose largest response is under the threshold must produce
 * nothing. Everything else here would fail loudly if the rule broke. That one
 * would fail quietly, in the direction of telling a citizen its ordinary traffic
 * was too large for it — and a citizen that has been told that once stops
 * reading the finding.
 */
describe('unreadable-response', () => {
  /**
   * The measured window: one `kolonie.tasks.frontier` response of 128,058 bytes
   * on 2026-08-13, which the calling client refused while `kolonie.doctor`
   * returned nothing at all.
   */
  const measured = () =>
    input({
      hours: [
        bucket({
          hour: 0,
          routeKey: 'kolonie.tasks.frontier',
          calls: 1,
          bytesOut: 128_058,
          maxBytesOut: 128_058,
        }),
      ],
    })

  it('fires on a single response above the threshold, with no minimum call count', () => {
    const found = unreadableResponse(measured())

    expect(found).toHaveLength(1)
    expect(found[0]?.kind).toBe('unreadable-response')
    expect(found[0]?.severity).toBe('serious')
    expect(found[0]?.evidence.figures['calls']).toBe(1)
  })

  /**
   * **The rejection case.** The same one call, one byte under the threshold. The
   * volume rules are right to want a habit before they speak; this one speaks at
   * n=1, so the only thing standing between it and an ordinary citizen is the
   * number itself.
   */
  it('says nothing about a window whose largest response is below the threshold', () => {
    const found = unreadableResponse(
      input({
        hours: [
          bucket({
            hour: 0,
            routeKey: 'kolonie.tasks.frontier',
            calls: 1,
            bytesOut: UNREADABLE_RESPONSE_BYTES - 1,
            maxBytesOut: UNREADABLE_RESPONSE_BYTES - 1,
          }),
        ],
      }),
    )

    expect(found).toEqual([])
  })

  /**
   * Many small responses summing past the threshold are what `oversized-reads`
   * is for. This rule reads one response, and a window of ordinary ones is
   * ordinary however many there are.
   */
  it('does not add up small responses to reach the threshold', () => {
    const found = unreadableResponse(
      input({
        hours: Array.from({ length: 30 }, (_, hour) =>
          bucket({
            hour,
            routeKey: '/v1/tasks',
            calls: 200,
            bytesOut: 400_000,
            maxBytesOut: 8_000,
          }),
        ),
      }),
    )

    expect(found).toEqual([])
  })

  it('names the route and the byte figure', () => {
    const finding = unreadableResponse(measured())[0]

    expect(finding?.evidence.routeKeys[0]).toBe('kolonie.tasks.frontier')
    expect(finding?.evidence.figures['maxBytesOut']).toBe(128_058)
    expect(finding?.evidence.figures['bytesOut']).toBe(128_058)
    expect(finding?.recommendation).toBe('narrow-the-request')
  })

  it('points at the narrower call as the second route key where one exists', () => {
    const finding = unreadableResponse(measured())[0]

    expect(finding?.evidence.routeKeys).toEqual([
      'kolonie.tasks.frontier',
      NARROWER_CALL_FOR['kolonie.tasks.frontier'],
    ])
  })

  /**
   * The ordinary case, and the reason the map is allowed to be short: a route
   * with no narrower call carries one key, and the recommendation still says
   * what to do — bound this same call's own arguments.
   */
  it('carries a single route key where there is no narrower call', () => {
    const finding = unreadableResponse(
      input({
        hours: [
          bucket({
            hour: 0,
            routeKey: 'kolonie.support.read',
            calls: 1,
            bytesOut: 200_000,
            maxBytesOut: 200_000,
          }),
        ],
      }),
    )[0]

    expect(NARROWER_CALL_FOR['kolonie.support.read']).toBeUndefined()
    expect(finding?.evidence.routeKeys).toEqual(['kolonie.support.read'])
    expect(finding?.recommendation).toBe('narrow-the-request')
  })

  /**
   * Confidence is not lowered for having been seen in one hour. The agreement
   * term asks whether a pattern holds across buckets, and this finding is not a
   * pattern — the one response is complete evidence of itself, so only the
   * overshoot is left to be less than sure about.
   */
  it('does not penalise a one-hour window for being one hour long', () => {
    const oneHour = unreadableResponse(measured())[0]
    const spread = unreadableResponse(
      input({
        hours: Array.from({ length: 6 }, (_, hour) =>
          bucket({
            hour,
            routeKey: 'kolonie.tasks.frontier',
            calls: 1,
            bytesOut: 128_058,
            maxBytesOut: 128_058,
          }),
        ),
      }),
    )[0]

    expect(oneHour?.confidence).toBe(spread?.confidence)
    expect(oneHour?.confidence).toBeGreaterThan(0.5)
  })

  /**
   * Nothing here is rate-shaped: calling the same thing later returns the same
   * response, so a retry time would be advice about the wrong axis.
   */
  it('offers no retry time', () => {
    expect(unreadableResponse(measured())[0]?.retryAfterSeconds).toBeNull()
  })

  it('reports one finding per route rather than one per hour', () => {
    const found = unreadableResponse(
      input({
        hours: [
          bucket({
            hour: 0,
            routeKey: 'kolonie.tasks.frontier',
            bytesOut: 128_058,
            maxBytesOut: 128_058,
          }),
          bucket({
            hour: 1,
            routeKey: 'kolonie.tasks.frontier',
            bytesOut: 128_058,
            maxBytesOut: 128_058,
          }),
          bucket({ hour: 2, routeKey: '/v1/tasks', bytesOut: 300_000, maxBytesOut: 300_000 }),
        ],
      }),
    )

    expect(found.map((finding) => finding.evidence.routeKeys[0]).sort()).toEqual([
      '/v1/tasks',
      'kolonie.tasks.frontier',
    ])
    expect(
      found.find((f) => f.evidence.routeKeys[0] === 'kolonie.tasks.frontier')?.evidence.figures[
        'hours'
      ],
    ).toBe(2)
  })
})
