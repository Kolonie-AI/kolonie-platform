import { describe, expect, it } from 'vitest'
import { fingerprintOf } from '@kolonie-ai/db'
import { observedOrigin } from './observed-origin.js'

/**
 * What the Colony observed about where a call came from (`#191`).
 *
 * The tests that matter here are the ones about *not* recording something: no
 * plaintext address anywhere in the result, and nothing invented when the edge
 * did not say. A local run has to produce a row with nulls in it, and a
 * Cloudflare answer that means *unknown* must not be stored as though it were a
 * place.
 */
describe('observedOrigin', () => {
  const SOCKET = '203.0.113.7'

  it('carries a digest and never the address it came from', () => {
    const origin = observedOrigin({ 'cf-connecting-ip': SOCKET }, '10.0.0.1')

    expect(origin.fingerprint).toBe(fingerprintOf(SOCKET))
    // The property the whole table is shaped around, asserted rather than
    // assumed: nothing in the result is the address.
    expect(JSON.stringify(origin)).not.toContain(SOCKET)
  })

  it('uses the same precedence every other caller does', () => {
    // `CF-Connecting-IP` wins over `X-Forwarded-For`, which is `clientIp`'s rule
    // and is not restated here — this asserts the rule is the one being used.
    const origin = observedOrigin(
      { 'cf-connecting-ip': '198.51.100.4', 'x-forwarded-for': '203.0.113.9, 198.51.100.4' },
      '10.0.0.1',
    )

    expect(origin.fingerprint).toBe(fingerprintOf('198.51.100.4'))
  })

  it('reads the country and the data centre Cloudflare reported', () => {
    const origin = observedOrigin(
      { 'cf-connecting-ip': SOCKET, 'cf-ipcountry': 'de', 'cf-ray': '7d4f2a1b9c8e0000-FRA' },
      '10.0.0.1',
    )

    expect(origin.country).toBe('DE')
    expect(origin.colo).toBe('FRA')
  })

  /**
   * The local case, and it produces an observation rather than nothing: *the
   * Colony saw you and could not tell from where* is a true thing to record, and
   * a table that stayed empty outside production would look like a feature that
   * does not work.
   */
  it('observes an origin with no geography when no edge is in front', () => {
    const origin = observedOrigin({}, SOCKET)

    expect(origin.fingerprint).toBe(fingerprintOf(SOCKET))
    expect(origin.country).toBeNull()
    expect(origin.colo).toBeNull()
  })

  /**
   * `XX` and `T1` are Cloudflare's own answers for *unknown* and *Tor*. Stored
   * as-is they would look like geography to every later reader and be none.
   */
  it('reads Cloudflare’s non-answers as no answer', () => {
    for (const value of ['XX', 'T1', 'x', '']) {
      expect(observedOrigin({ 'cf-ipcountry': value }, SOCKET).country).toBeNull()
    }
  })

  it('takes no data centre from a ray it cannot read one out of', () => {
    for (const ray of ['7d4f2a1b9c8e0000', '7d4f2a1b9c8e0000-', '7d4f-12']) {
      expect(observedOrigin({ 'cf-ray': ray }, SOCKET).colo).toBeNull()
    }
  })
})
