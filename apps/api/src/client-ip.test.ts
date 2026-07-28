import { describe, expect, it } from 'vitest'
import { clientIp } from './client-ip.js'

/**
 * Every address here is from a documentation range — RFC 5737 for IPv4, RFC 3849
 * for IPv6. `AGENTS.md` §9 forbids a real host or address anywhere in this
 * repository, and a test file is not an exception: an address in a fixture is an
 * address in the repository.
 */
const CLIENT = '192.0.2.10'
const CLOUDFLARE_EDGE = '198.51.100.7'
const TRAEFIK = '203.0.113.4'

describe('clientIp', () => {
  it('prefers what Cloudflare says, because Cloudflare overwrites it', () => {
    expect(clientIp({ 'cf-connecting-ip': CLIENT, 'x-forwarded-for': `${TRAEFIK}` }, TRAEFIK)).toBe(
      CLIENT,
    )
  })

  it('falls back to the leftmost X-Forwarded-For entry when Cloudflare is not in the path', () => {
    expect(
      clientIp({ 'x-forwarded-for': `${CLIENT}, ${CLOUDFLARE_EDGE}, ${TRAEFIK}` }, TRAEFIK),
    ).toBe(CLIENT)
  })

  /**
   * The bug this module exists to prevent. Taking the *last* entry keys the
   * limiter on the nearest proxy, which is one value for every caller in the
   * world — kolonie-platform#10: "a limiter keyed on the proxy IP limits
   * everyone at once and nobody in particular".
   */
  it('never returns the nearest proxy when a chain is present', () => {
    const resolved = clientIp({ 'x-forwarded-for': `${CLIENT}, ${TRAEFIK}` }, TRAEFIK)

    expect(resolved).not.toBe(TRAEFIK)
  })

  it('uses the socket address when there is no proxy at all', () => {
    expect(clientIp({}, CLIENT)).toBe(CLIENT)
  })

  it('ignores a header that is present but empty', () => {
    expect(clientIp({ 'cf-connecting-ip': '   ', 'x-forwarded-for': '' }, CLIENT)).toBe(CLIENT)
  })

  it('trims the whitespace a comma-separated chain leaves behind', () => {
    expect(clientIp({ 'x-forwarded-for': `  ${CLIENT}  ,${TRAEFIK}` }, TRAEFIK)).toBe(CLIENT)
  })

  /**
   * Node collapses a repeated header into an array. The first occurrence is the
   * one closest to the caller, for the same reason as the leftmost chain entry.
   */
  it('takes the first occurrence of a repeated header', () => {
    expect(clientIp({ 'cf-connecting-ip': [CLIENT, TRAEFIK] }, TRAEFIK)).toBe(CLIENT)
  })

  it('carries an IPv6 address through unchanged', () => {
    expect(clientIp({ 'cf-connecting-ip': '2001:db8::1' }, TRAEFIK)).toBe('2001:db8::1')
  })
})
