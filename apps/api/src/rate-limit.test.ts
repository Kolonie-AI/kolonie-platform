import { describe, expect, it } from 'vitest'
import { fixedWindowLimiter, REGISTRATION_LIMIT, registrationLimiter } from './rate-limit.js'

/** RFC 5737 documentation addresses — see the note in `client-ip.test.ts`. */
const CALLER = '192.0.2.10'
const OTHER_CALLER = '192.0.2.11'

/** A clock the test moves, so a one-hour window costs no wall time. */
const stoppedClock = (start = 1_000_000) => {
  let current = start
  return { now: () => current, advance: (ms: number) => (current += ms) }
}

describe('fixedWindowLimiter', () => {
  it('allows up to the limit and refuses the one after it', () => {
    const limiter = fixedWindowLimiter({ limit: 3, windowMs: 1000 })

    expect(limiter.take(CALLER).allowed).toBe(true)
    expect(limiter.take(CALLER).allowed).toBe(true)
    expect(limiter.take(CALLER).allowed).toBe(true)
    expect(limiter.take(CALLER).allowed).toBe(false)
  })

  it('counts each key separately, so one caller cannot spend another allowance', () => {
    const limiter = fixedWindowLimiter({ limit: 1, windowMs: 1000 })

    expect(limiter.take(CALLER).allowed).toBe(true)
    expect(limiter.take(OTHER_CALLER).allowed).toBe(true)
  })

  it('says how long to wait, rounded up so the answer is never early', () => {
    const clock = stoppedClock()
    const limiter = fixedWindowLimiter({ limit: 1, windowMs: 10_000, now: clock.now })

    limiter.take(CALLER)
    clock.advance(1500)
    const verdict = limiter.take(CALLER)

    expect(verdict.allowed).toBe(false)
    if (verdict.allowed) throw new Error('unreachable')
    expect(verdict.retryAfterSeconds).toBe(9)
  })

  it('never tells a caller to retry in zero seconds', () => {
    const clock = stoppedClock()
    const limiter = fixedWindowLimiter({ limit: 1, windowMs: 1000, now: clock.now })

    limiter.take(CALLER)
    clock.advance(999)
    const verdict = limiter.take(CALLER)

    if (verdict.allowed) throw new Error('expected a refusal')
    expect(verdict.retryAfterSeconds).toBe(1)
  })

  it('opens a fresh window once the old one has passed', () => {
    const clock = stoppedClock()
    const limiter = fixedWindowLimiter({ limit: 1, windowMs: 1000, now: clock.now })

    limiter.take(CALLER)
    expect(limiter.take(CALLER).allowed).toBe(false)

    clock.advance(1001)
    expect(limiter.take(CALLER).allowed).toBe(true)
  })

  it('reports what is left, so a caller can slow down before it is refused', () => {
    const limiter = fixedWindowLimiter({ limit: 2, windowMs: 1000 })

    expect(limiter.take(CALLER)).toEqual({ allowed: true, remaining: 1 })
    expect(limiter.take(CALLER)).toEqual({ allowed: true, remaining: 0 })
  })

  /**
   * The map is swept on use rather than by a timer, so this asserts the sweep
   * happens at all: without it the process holds one entry per address that has
   * ever called, forever, and the front door is a memory leak with a limit
   * attached.
   */
  it('forgets a key whose window has expired instead of holding it forever', () => {
    const clock = stoppedClock()
    const limiter = fixedWindowLimiter({ limit: 1, windowMs: 1000, now: clock.now })

    limiter.take(CALLER)
    clock.advance(1001)
    // Another caller arrives, which is what triggers the sweep. The first key is
    // gone, so its allowance is whole again.
    limiter.take(OTHER_CALLER)

    expect(limiter.take(CALLER)).toEqual({ allowed: true, remaining: 0 })
  })
})

describe('registrationLimiter', () => {
  it('runs at the documented registration limit', () => {
    const limiter = registrationLimiter()

    for (let attempt = 0; attempt < REGISTRATION_LIMIT; attempt += 1) {
      expect(limiter.take(CALLER).allowed).toBe(true)
    }

    expect(limiter.take(CALLER).allowed).toBe(false)
  })
})
