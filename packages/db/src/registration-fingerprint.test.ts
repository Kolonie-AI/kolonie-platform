import { describe, expect, it } from 'vitest'
import { fingerprintOf } from './registration-fingerprint.js'

/** RFC 5737 / RFC 3849 documentation addresses. `AGENTS.md` §9 — never a real one. */
const CALLER = '192.0.2.10'
const OTHER_CALLER = '192.0.2.11'

describe('fingerprintOf', () => {
  /**
   * The only property the column is built on: the same caller registering twice
   * is recognisable as the same caller. Without this, D-028's whole answer to
   * account farming is a column of unrelated noise.
   */
  it('gives one address one value, every time', () => {
    expect(fingerprintOf(CALLER)).toBe(fingerprintOf(CALLER))
  })

  it('separates two addresses that differ by one character', () => {
    expect(fingerprintOf(CALLER)).not.toBe(fingerprintOf(OTHER_CALLER))
  })

  it('does not contain the address it was made from', () => {
    // The point of hashing at all: a raw address must not survive into a column
    // that is read in queries, exports and screenshots.
    expect(fingerprintOf(CALLER)).not.toContain(CALLER)
  })

  it('is 64 hex characters, which is what the column is sized for', () => {
    expect(fingerprintOf(CALLER)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('handles an IPv6 address, since half the internet arrives on one', () => {
    expect(fingerprintOf('2001:db8::1')).toMatch(/^[0-9a-f]{64}$/)
  })
})
