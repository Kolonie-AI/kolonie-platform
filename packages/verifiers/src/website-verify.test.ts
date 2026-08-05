import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The resolver, replaced, because this file is about how a *failure to resolve*
 * is classified and nothing about whether this machine has DNS. `vi.hoisted` for
 * the reason `proof-of-work.test.ts` gives: `vi.mock` is lifted above the
 * imports, so the handle has to be created before them.
 */
const dns = vi.hoisted(() => ({ lookup: vi.fn() }))

vi.mock('node:dns/promises', () => ({ lookup: dns.lookup }))

const { AddressRefused, isPrivateIP, safeFetch } = await import('./website-verify.js')

/** A resolver failure exactly as `node:dns` reports one. */
function resolverFailure(code: string): Error & { code: string } {
  return Object.assign(new Error(`getaddrinfo ${code} nowhere.example`), { code })
}

beforeEach(() => {
  dns.lookup.mockReset()
  vi.unstubAllGlobals()
})

/**
 * `#401`. The verdict a rung reaches for an unfetchable image is decided here:
 * an {@link AddressRefused} is *this will be just as true in five minutes* and
 * becomes `fail`, and everything else is a socket and becomes `pending`. Both
 * image rungs read that distinction and nothing else, so this is the file that
 * has to be right about it.
 */
describe('safeFetch, on what it refuses and what it merely could not reach', () => {
  it('refuses an address inside our own network, by type and not by wording', async () => {
    dns.lookup.mockResolvedValue([{ address: '10.0.0.5', family: 4 }])

    await expect(safeFetch('http://intranet.example/')).rejects.toBeInstanceOf(AddressRefused)
  })

  /**
   * A name that does not exist is the submission's own typo, and the resolver
   * has answered rather than failed to answer. Retrying it would spend a
   * citizen's deadline discovering the same thing.
   */
  it('refuses a hostname the resolver says does not exist', async () => {
    dns.lookup.mockRejectedValue(resolverFailure('ENOTFOUND'))

    await expect(safeFetch('http://nowhere.example/')).rejects.toBeInstanceOf(AddressRefused)
  })

  /**
   * `EAI_AGAIN` is the resolver saying *ask me later*, which is the one thing a
   * retry is for. Reading it as a verdict would fail a citizen for our DNS.
   */
  it('does not refuse a hostname the resolver could not answer for yet', async () => {
    dns.lookup.mockRejectedValue(resolverFailure('EAI_AGAIN'))

    const error = await safeFetch('http://nowhere.example/').catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(AddressRefused)
  })

  /**
   * A redirect loop answers the same way every time, so there is nothing for a
   * later attempt to discover — the address's own configuration, not the
   * network's weather.
   */
  it('refuses an address that redirects in a circle', async () => {
    dns.lookup.mockResolvedValue([{ address: '203.0.113.10', family: 4 }])
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(null, { status: 302, headers: { location: 'http://203.0.113.10/again' } }),
      ),
    )

    await expect(safeFetch('http://203.0.113.10/')).rejects.toBeInstanceOf(AddressRefused)

    vi.unstubAllGlobals()
  })

  /**
   * The default for an unrecognised failure is *unreachable*, deliberately: a
   * socket that died is far more likely to be weather than a judgement, and
   * every refusal worth failing a citizen over is thrown by name.
   */
  it('leaves a dead socket unclassified, which is what makes it retryable', async () => {
    dns.lookup.mockResolvedValue([{ address: '203.0.113.10', family: 4 }])
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')))

    const error = await safeFetch('http://203.0.113.10/').catch((thrown: unknown) => thrown)

    vi.unstubAllGlobals()

    expect(error).not.toBeInstanceOf(AddressRefused)
  })
})

/**
 * The list the domain rung shares (`#60`). Asserted here because a second copy
 * of it is the thing that lets a submission reach the metadata service, and a
 * change to it should have to break a test.
 */
describe('isPrivateIP', () => {
  it('blocks every range the Colony could be on', () => {
    for (const ip of [
      '127.0.0.1',
      '::1',
      '10.1.2.3',
      '169.254.169.254',
      '172.20.0.1',
      '192.168.1.1',
      '0.0.0.0',
      'fd00::1',
      'fe80::1',
    ]) {
      expect(isPrivateIP(ip), ip).toBe(true)
    }
  })

  it('lets an ordinary public address through', () => {
    for (const ip of ['203.0.113.10', '8.8.8.8', '172.32.0.1', '2606:4700::1111']) {
      expect(isPrivateIP(ip), ip).toBe(false)
    }
  })
})
