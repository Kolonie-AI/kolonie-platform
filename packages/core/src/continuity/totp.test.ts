import { describe, expect, it } from 'vitest'
import {
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
  base32Decode,
  base32Encode,
  mintTotpSecret,
  totpCodeAt,
  totpCounterAt,
  totpMatches,
} from './totp.js'

/**
 * RFC 6238's own secret, `12345678901234567890` in ASCII, base32-encoded.
 *
 * The vectors below are the RFC's, truncated to six digits — which is what the
 * citizen that proposed this rung verified its own fifteen lines of Python
 * against before filing. Checking against them rather than against a second
 * function of ours is the whole value of having them.
 */
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'))

describe('RFC 6238 test vectors', () => {
  it.each([
    [59, '287082'],
    [1_111_111_109, '081804'],
    [1_234_567_890, '005924'],
    [2_000_000_000, '279037'],
  ])('answers %i with %s', (atSeconds, expected) => {
    expect(totpCodeAt(RFC_SECRET, totpCounterAt(atSeconds))).toBe(expected)
  })
})

describe('base32', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = Uint8Array.from([0, 1, 127, 128, 255, 42, 7])

    expect([...base32Decode(base32Encode(bytes))]).toEqual([...bytes])
  })

  it('encodes without padding, which is what an authenticator expects', () => {
    expect(base32Encode(Uint8Array.from([1]))).not.toContain('=')
  })

  /** A citizen copying a secret out of a message is the ordinary case. */
  it('forgives padding, spaces and lower case on the way in', () => {
    const secret = base32Encode(Uint8Array.from([9, 8, 7, 6, 5]))
    const mangled = `${secret.toLowerCase().slice(0, 4)} ${secret.toLowerCase().slice(4)}==`

    expect([...base32Decode(mangled)]).toEqual([...base32Decode(secret)])
  })

  it('refuses something that is not base32 rather than guessing', () => {
    expect(() => base32Decode('not!base32')).toThrow()
  })
})

describe('checking a code', () => {
  const secret = mintTotpSecret()
  const at = 1_770_000_000

  it('accepts the code for this moment', () => {
    expect(totpMatches(secret, totpCodeAt(secret, totpCounterAt(at)), at)).toBe(true)
  })

  /** Clock skew is not something this rung is entitled to measure. */
  it('accepts one period either side', () => {
    const counter = totpCounterAt(at)

    expect(totpMatches(secret, totpCodeAt(secret, counter - 1), at)).toBe(true)
    expect(totpMatches(secret, totpCodeAt(secret, counter + 1), at)).toBe(true)
  })

  it('refuses a code two periods old', () => {
    const stale = totpCodeAt(secret, totpCounterAt(at) - 2)

    expect(totpMatches(secret, stale, at)).toBe(false)
  })

  it('refuses somebody else’s secret', () => {
    const other = mintTotpSecret()

    expect(totpMatches(secret, totpCodeAt(other, totpCounterAt(at)), at)).toBe(false)
  })

  it('refuses anything that is not six digits, without throwing', () => {
    for (const wrong of ['', '12345', '1234567', 'abcdef', '12 34 56', '  ']) {
      expect(totpMatches(secret, wrong, at)).toBe(false)
    }
  })

  /** `007041` is a code and `7041` is not. */
  it('keeps leading zeros, which a numeric field would lose', () => {
    const zeroLeading = totpCodeAt(RFC_SECRET, totpCounterAt(1_234_567_890))

    expect(zeroLeading).toBe('005924')
    expect(zeroLeading).toHaveLength(TOTP_DIGITS)
  })

  it('mints a different secret every time', () => {
    expect(mintTotpSecret()).not.toBe(mintTotpSecret())
  })

  it('steps once per period', () => {
    expect(totpCounterAt(0)).toBe(0)
    expect(totpCounterAt(TOTP_PERIOD_SECONDS - 1)).toBe(0)
    expect(totpCounterAt(TOTP_PERIOD_SECONDS)).toBe(1)
  })
})
