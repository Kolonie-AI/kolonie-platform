import { describe, expect, it } from 'vitest'
import { CHROME_CACHE_SECONDS, parseSiteChrome, siteChromeFrom } from './site-chrome.js'

/**
 * **This repository's half of a two-repository contract**
 * (`kolonie-website#99`).
 *
 * `kolonie-website` builds one page, `/site-chrome/`, out of the header and
 * footer components it already renders on every page of its own; this process
 * fetches it and puts those two elements around the Atlas pages, which had
 * neither. The other half of the contract is
 * `src/lib/chrome-fragment.built-test.ts` over there, which asserts that what
 * gets built is what this expects.
 *
 * **Both halves are needed and neither is sufficient.** A test only here goes
 * green against a fixture while the website builds something else; a test only
 * there goes green against a document nothing reads. That is the failure mode
 * of every cross-repository agreement with a test on one side, and it is worth
 * the duplication to avoid.
 *
 * The fixture below is the shape of the real document, cut down: `#99`'s whole
 * argument is that this repository never writes the site's chrome, so what is
 * asserted is the *extraction* and never the markup.
 */

const FRAGMENT = [
  '<!doctype html><html lang="en" dir="ltr" data-theme="dark"><head>',
  '<meta charset="utf-8"><title>Site chrome — Kolonie AI</title>',
  '<meta name="robots" content="noindex, nofollow">',
  '<link rel="stylesheet" href="/_astro/theme.CMUWibdJ.css">',
  '<style>.site-header{background:var(--k-surface)}</style>',
  '</head><body>',
  '<header class="site-header"><a href="/" class="site-header__mark">Kolonie AI</a></header>',
  '<footer class="site-footer"><a href="/privacy/">Privacy</a></footer>',
  '</body></html>',
].join('')

describe('taking the site chrome out of the built fragment (#99)', () => {
  it('finds the header, the footer and the styles', () => {
    const chrome = parseSiteChrome(FRAGMENT)

    expect(chrome?.header).toBe(
      '<header class="site-header"><a href="/" class="site-header__mark">Kolonie AI</a></header>',
    )
    expect(chrome?.footer).toContain('/privacy/')
    expect(chrome?.head).toContain('/_astro/theme.CMUWibdJ.css')
    expect(chrome?.head).toContain('.site-header{background:var(--k-surface)}')
  })

  /**
   * **Nothing else out of the head.** A `<title>` or a `<meta>` from that
   * document reaching an Atlas page would be the fragment quietly deciding
   * things about a page it knows nothing about — and `noindex` in particular
   * would take the whole catalogue out of every search index, which is the one
   * thing `#546` built these pages to be in.
   */
  it('takes no title, no meta and no robots directive', () => {
    const chrome = parseSiteChrome(FRAGMENT)

    expect(chrome?.head).not.toContain('<title')
    expect(chrome?.head).not.toContain('<meta')
    expect(chrome?.head).not.toContain('noindex')
  })

  describe('what it refuses to guess at', () => {
    it('gives up on a document with two headers', () => {
      expect(
        parseSiteChrome(FRAGMENT.replace('<body>', '<body><header>a</header>')),
      ).toBeUndefined()
    })

    it('gives up on a document with no footer', () => {
      expect(parseSiteChrome(FRAGMENT.replace(/<footer[\s\S]*<\/footer>/, ''))).toBeUndefined()
    })

    /**
     * The realistic version of *the website is down*: a proxy answers with an
     * error page that is valid HTML and has nothing in it.
     */
    it('gives up on a page that is not the fragment at all', () => {
      expect(parseSiteChrome('<html><body><h1>502 Bad Gateway</h1></body></html>')).toBeUndefined()
    })
  })
})

describe('fetching it, and what happens when that fails (#99)', () => {
  it('fetches the fragment from the website it already writes canonicals to', async () => {
    const asked: string[] = []
    const chrome = siteChromeFrom({
      websiteUrl: 'https://kolonie.ai',
      fetch: async (url) => {
        asked.push(String(url))

        return new Response(FRAGMENT, { status: 200 })
      },
    })

    expect((await chrome())?.header).toContain('site-header')
    expect(asked).toEqual(['https://kolonie.ai/site-chrome/'])
  })

  /**
   * **The whole point of the cache**: one fetch per interval across every Atlas
   * page, rather than a second service on the critical path of every render.
   */
  it('fetches once and reuses the answer until the interval is up', async () => {
    let calls = 0
    let clock = 0
    const chrome = siteChromeFrom({
      websiteUrl: 'https://kolonie.ai',
      now: () => clock,
      fetch: async () => {
        calls += 1

        return new Response(FRAGMENT, { status: 200 })
      },
    })

    await chrome()
    await chrome()
    await chrome()
    expect(calls).toBe(1)

    clock += CHROME_CACHE_SECONDS * 1000 + 1
    await chrome()
    expect(calls).toBe(2)
  })

  /**
   * **The failure that must not be one.** An Atlas page without the site's
   * header is worse than one with it and far better than a 500 — and a static
   * website being down must not take the catalogue with it.
   */
  it('answers with nothing when the website is unreachable, and does not throw', async () => {
    const chrome = siteChromeFrom({
      websiteUrl: 'https://kolonie.ai',
      fetch: async () => {
        throw new Error('ECONNREFUSED')
      },
    })

    await expect(chrome()).resolves.toBeUndefined()
  })

  it('answers with nothing on a non-200, and does not throw', async () => {
    const chrome = siteChromeFrom({
      websiteUrl: 'https://kolonie.ai',
      fetch: async () => new Response('nope', { status: 502 }),
    })

    await expect(chrome()).resolves.toBeUndefined()
  })

  /**
   * A website that is down is asked once per interval rather than once per
   * page render — which is the difference between a degraded catalogue and one
   * whose every request waits on a connection that will not open.
   */
  it('does not retry a failing website on every render', async () => {
    let calls = 0
    const chrome = siteChromeFrom({
      websiteUrl: 'https://kolonie.ai',
      /** Frozen: the whole assertion is that three calls inside one interval are one fetch. */
      now: () => 0,
      fetch: async () => {
        calls += 1
        throw new Error('ECONNREFUSED')
      },
    })

    await chrome()
    await chrome()
    await chrome()

    expect(calls).toBe(1)
  })

  /**
   * And it recovers: the website coming back is not something anybody has to
   * restart the API for.
   */
  it('picks the chrome up once the website answers again', async () => {
    let clock = 0
    let up = false
    const chrome = siteChromeFrom({
      websiteUrl: 'https://kolonie.ai',
      now: () => clock,
      fetch: async () =>
        up ? new Response(FRAGMENT, { status: 200 }) : new Response('', { status: 502 }),
    })

    expect(await chrome()).toBeUndefined()

    up = true
    clock += CHROME_CACHE_SECONDS * 1000 + 1

    expect((await chrome())?.footer).toContain('/privacy/')
  })

  it('serves a stale answer rather than nothing when the website goes down', async () => {
    let clock = 0
    let up = true
    const chrome = siteChromeFrom({
      websiteUrl: 'https://kolonie.ai',
      now: () => clock,
      fetch: async () =>
        up ? new Response(FRAGMENT, { status: 200 }) : new Response('', { status: 502 }),
    })

    expect(await chrome()).toBeDefined()

    up = false
    clock += CHROME_CACHE_SECONDS * 1000 + 1

    /**
     * The last good chrome, not nothing. A header that is one deploy old is a
     * page that still looks like the site; dropping it because a fetch failed
     * would make the site's chrome flicker in and out with the website's uptime.
     */
    expect((await chrome())?.header).toContain('site-header')
  })
})
