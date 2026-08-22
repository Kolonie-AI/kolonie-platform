import { describe, expect, it, vi } from 'vitest'

/**
 * `vi.mock` is lifted above the imports, so the resolver's dependencies have to
 * be hoisted with it — the shape `website.test.ts` uses, and this file goes in
 * the **isolated** vitest project for the reason `vitest.config.ts` states at
 * length: a file that stubs a global belongs to whoever assigned it last.
 */
const dns = vi.hoisted(() => ({ lookup: vi.fn() }))
vi.mock('node:dns/promises', () => ({ lookup: dns.lookup }))

const { iconCandidates } = await import('./provider-icon.js')

/**
 * Where a provider's icon might be (`#1405` decision 1).
 *
 * **Only the resolution is asserted here.** Whether a fetched image is safe to
 * re-serve is `sanitiseAvatar`'s question and `avatar-bytes` owns its cases;
 * whether the host may be fetched at all is `safeFetch`'s and `website-verify`
 * owns those. This file is about one thing: given a homepage, which URLs are
 * worth trying and in what order.
 */
const page = (html: string): ((url: string) => Promise<Response>) =>
  vi.fn(async () => new Response(html, { headers: { 'content-type': 'text/html' } }))

const HOME = 'https://provider.example/'

describe('where a provider icon might be', () => {
  it('reads the icons a page declares, and resolves them against it', async () => {
    const found = await iconCandidates(HOME, page('<link rel="icon" href="/static/mark.png">'))

    expect(found.outcome).toBe('candidates')
    if (found.outcome !== 'candidates') return
    expect(found.urls[0]).toBe('https://provider.example/static/mark.png')
  })

  /**
   * Decision 1's order. `apple-touch-icon` is usually the largest and cleanest
   * mark a site has; `/favicon.ico` is the one that exists whether or not
   * anybody chose it, so it is always last.
   */
  it('prefers the apple touch icon, and keeps favicon.ico last', async () => {
    const found = await iconCandidates(
      HOME,
      page('<link rel="icon" href="/small.png">' + '<link rel="apple-touch-icon" href="/big.png">'),
    )

    if (found.outcome !== 'candidates') throw new Error(found.reason)
    expect(found.urls[0]).toBe('https://provider.example/big.png')
    expect(found.urls[1]).toBe('https://provider.example/small.png')
    expect(found.urls.at(-1)).toBe('https://provider.example/favicon.ico')
  })

  it('deduplicates a page that declares the same href twice', async () => {
    const found = await iconCandidates(
      HOME,
      page('<link rel="icon" href="/m.png"><link rel="shortcut icon" href="/m.png">'),
    )

    if (found.outcome !== 'candidates') throw new Error(found.reason)
    expect(found.urls.filter((url) => url.endsWith('/m.png'))).toHaveLength(1)
  })

  /**
   * **A page with no `<link>` still has a candidate.** `/favicon.ico` is a
   * convention rather than something the document has to declare, and a site
   * with nothing in its head usually still answers there.
   */
  it('falls back to the convention when a page declares nothing', async () => {
    const found = await iconCandidates(HOME, page('<html><head></head></html>'))

    if (found.outcome !== 'candidates') throw new Error(found.reason)
    expect(found.urls).toEqual(['https://provider.example/favicon.ico'])
  })

  /** And a homepage that could not be read is not a provider without an icon. */
  it('still offers the convention when the homepage will not load', async () => {
    const found = await iconCandidates(HOME, async () => {
      throw new Error('connection reset')
    })

    if (found.outcome !== 'candidates') throw new Error(found.reason)
    expect(found.urls).toEqual(['https://provider.example/favicon.ico'])
  })

  /**
   * **Rejection case: plaintext.** The Colony re-serves what it fetches from its
   * own domain, so a hop somebody else can rewrite is one it will not take —
   * the same rule `fetchAvatar` states for the same reason.
   */
  it('refuses a homepage that is not https', async () => {
    const found = await iconCandidates(
      'http://provider.example/',
      page('<link rel="icon" href="/m.png">'),
    )

    expect(found.outcome).toBe('refused')
    if (found.outcome !== 'refused') return
    expect(found.reason).toContain('https')
  })

  /** A declared icon on another scheme is dropped rather than followed. */
  it('drops a declared icon that is not https', async () => {
    const found = await iconCandidates(
      HOME,
      page('<link rel="icon" href="http://elsewhere.example/m.png">'),
    )

    if (found.outcome !== 'candidates') throw new Error(found.reason)
    expect(found.urls).toEqual(['https://provider.example/favicon.ico'])
  })

  it('refuses a homepage that is not a URL at all', async () => {
    expect((await iconCandidates('not a url')).outcome).toBe('refused')
  })
})
