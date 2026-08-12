/**
 * The website's own header and footer, fetched rather than reproduced
 * (`kolonie-website#99`).
 *
 * ## What this is for
 *
 * `kolonie.ai/atlas` and every `/atlas/<provider>` page are served by this
 * process as host routes on the website's domain (`#546`). They therefore had
 * none of the site's chrome: measured 2026-08-08, `/atlas` had no `<header>`,
 * no `<footer>` and one link in a `nav`. A visitor arriving from a search
 * result or a shared link saw a page with no navigation, no way back to the
 * site, and no link to the privacy policy, the terms or the imprint — the last
 * of which `kolonie-website#42` and `#44` require of *every* page.
 *
 * ## Why the chrome is fetched and not written here
 *
 * `#99` sets out three options and warns which one will be reached for:
 *
 * > Option 1 is the one that will be reached for because it is nearest, and it
 * > is the one that quietly recreates two footers.
 *
 * That is this file's alternative — reproducing the site's header and footer in
 * this repository — and it is the failure `kolonie-website#42` and `#51` were
 * written about, this time across two repositories and two languages. `#42`
 * exists because two hand-maintained footers is how `/privacy/` ended up linked
 * from five pages out of six.
 *
 * `#99` recommends option 2, the website rendering the Atlas itself, and asks
 * that anything ruling it out be said out loud. **Two of the issue's own
 * criteria rule it out together**: the catalogue must stay live, and the pages
 * must work with JavaScript off. The website is a static build served by nginx
 * — there is no request-time render — so "the site renders the Atlas" is either
 * baked at build time, which is not live and is the deploy storm `#546`
 * rejected, or fetched in the browser the way `/academy` does it, which needs
 * JavaScript. The Atlas is the page an *agent* fetches, and an agent runs no
 * scripts.
 *
 * So: **option 3, in its narrowest form.** `kolonie-website` builds one page,
 * `/site-chrome/`, out of the components it already renders on every page of
 * its own; this fetches it and takes three things out of it. One source, two
 * consumers, and the coupling is one URL on a host this process already knows
 * because it writes a canonical link to it on every Atlas page.
 *
 * ## What can go wrong, and what happens then
 *
 * **A failed fetch is not an error.** If the website is unreachable, or the
 * document is not the shape this expects, every Atlas page renders exactly as
 * it did before `#99` — its own shell, no site chrome. That is a visible
 * degradation and not a broken page, and the alternative is that a static site
 * being down takes the catalogue with it.
 *
 * **The cache is a whole-document one with a short life.** The chrome changes
 * when the website deploys, which is rarely; the pages that include it are
 * already cached for {@link ATLAS_CACHE_SECONDS} at the edge. One fetch per
 * {@link CHROME_CACHE_SECONDS} across every Atlas page is the smallest thing
 * that keeps the header current without making the catalogue's latency depend
 * on another service on every request.
 */

import type { Log } from '@kolonie-ai/core'

/**
 * The path the website builds the fragment at.
 *
 * **`/site-chrome/` and not `/_chrome/`**: Astro excludes any route under
 * `src/pages/` whose name begins with an underscore, so the first spelling
 * built nothing and did so silently.
 */
export const SITE_CHROME_PATH = '/site-chrome/'

/**
 * How long a fetched chrome document is reused.
 *
 * Five minutes, chosen against what it protects rather than against a feeling:
 * the website deploys rarely, and the cost of being stale is a header one
 * deploy behind. The cost of no cache is a second service on the critical path
 * of every Atlas render.
 */
export const CHROME_CACHE_SECONDS = 300

/** What an Atlas page puts around itself. */
export interface SiteChrome {
  /** The `<link rel="stylesheet">` and `<style>` elements, for the `<head>`. */
  readonly head: string
  /** The one `<header class="site-header">` element. */
  readonly header: string
  /** The one `<footer class="site-footer">` element. */
  readonly footer: string
}

/**
 * Pull the three pieces out of the built document.
 *
 * **Exported for the test, and the test is half of a contract.** The other half
 * is `chrome-fragment.built-test.ts` in `kolonie-website`, which asserts that
 * what gets built is what this expects. Either test alone would go green while
 * the pair was broken, which is the failure mode of every cross-repository
 * agreement that has a test on only one side.
 *
 * Returns `undefined` rather than throwing on anything unexpected: this is
 * called on a page render, and a malformed fragment must cost the chrome rather
 * than the catalogue.
 */
export function parseSiteChrome(document: string): SiteChrome | undefined {
  const element = (tag: 'header' | 'footer'): string | undefined => {
    const opens = document.indexOf(`<${tag}`)
    const closes = document.indexOf(`</${tag}>`)
    if (opens === -1 || closes === -1 || closes < opens) return undefined

    /**
     * **One of each, or nothing.** The website's own test asserts there is
     * exactly one; this refuses to guess if that ever stops being true, because
     * taking the first of two would be silently wrong rather than obviously so.
     */
    if (document.indexOf(`<${tag}`, opens + 1) !== -1) return undefined

    return document.slice(opens, closes + `</${tag}>`.length)
  }

  const header = element('header')
  const footer = element('footer')
  if (header === undefined || footer === undefined) return undefined

  /**
   * The stylesheet links and inline styles, and **nothing else out of the
   * head**. A `<title>`, a `<meta>` or a script from that document reaching an
   * Atlas page would be the fragment quietly deciding things about a page it
   * knows nothing about — and the Content-Security-Policy on these responses
   * allows no script anyway, so one arriving would be silently dropped by the
   * browser rather than by us.
   *
   * **What it takes has to be permitted, and for four days it was not** (`#786`).
   * The same policy that drops a script was also dropping every stylesheet this
   * function deliberately lifts, because `style-src` carried `'unsafe-inline'`
   * and no `'self'`. Both halves of the contract in this file were green
   * throughout: one asserts the `<link>` string is in the body, the other that
   * the fragment's classes have rules — and neither asks whether the browser is
   * allowed to fetch the file. `atlas-pages.test.ts` now asks.
   */
  const head = [
    ...document.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/g),
    ...document.matchAll(/<style\b[^>]*>[\s\S]*?<\/style>/g),
  ]
    .map((match) => match[0])
    .join('\n')

  return { head, header, footer }
}

/** Where a chrome document comes from, so a test can supply one without a server. */
export interface SiteChromeSource {
  (): Promise<SiteChrome | undefined>
}

/**
 * Fetch the fragment from the website, with a cache and no way to fail loudly.
 *
 * `websiteUrl` is the same value every Atlas page already writes into its
 * canonical link, so this introduces no new configuration.
 */
export function siteChromeFrom(input: {
  readonly websiteUrl: string
  readonly log?: Log
  /** Injected in tests; `globalThis.fetch` in production. */
  readonly fetch?: typeof globalThis.fetch
  readonly now?: () => number
}): SiteChromeSource {
  const fetched = input.fetch ?? globalThis.fetch
  const clock = input.now ?? (() => Date.now())

  let cached: SiteChrome | undefined
  let cachedAt = Number.NEGATIVE_INFINITY

  return async () => {
    if (clock() - cachedAt < CHROME_CACHE_SECONDS * 1000) return cached

    try {
      const response = await fetched(`${input.websiteUrl}${SITE_CHROME_PATH}`)
      if (!response.ok) throw new Error(`site chrome answered ${response.status}`)

      const parsed = parseSiteChrome(await response.text())
      if (parsed === undefined) throw new Error('site chrome was not the shape it has to be')

      cached = parsed
      cachedAt = clock()
    } catch (error: unknown) {
      /**
       * **Logged and swallowed.** An Atlas page without the site's header is
       * worse than one with it and far better than a 500 — and the whole
       * catalogue going down because a static site did is the trade this
       * refuses. The cache timestamp is moved either way, so a website that is
       * down is asked once per interval rather than once per request.
       */
      cachedAt = clock()
      input.log?.warn('serving Atlas pages without the site chrome', {
        event: 'atlas.chrome.unavailable',
        reason: error instanceof Error ? error.message : String(error),
      })
    }

    return cached
  }
}
