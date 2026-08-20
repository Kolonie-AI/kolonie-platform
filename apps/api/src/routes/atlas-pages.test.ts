import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.js'
import { fakeColony, type FakeColony } from '../__fixtures__/colony/index.js'
import {
  AccountCapabilitySchema,
  AccountKindSchema,
  ATLAS_ANY_PROVED_PHRASE,
  ATLAS_PATH,
  ATLAS_SEEDED_CATEGORIES,
  noFigures,
  PROVIDER_DESCRIPTION_MAX_LENGTH,
  type PublishedWall,
} from '@kolonie-ai/core'
import type { SiteChrome } from '../atlas/site-chrome.js'
import type { AtlasPlaybookReader } from '../atlas/playbook-links.js'
import { ATLAS_META_DESCRIPTION_MAX_LENGTH } from '../atlas/html.js'
import { atlasRuntimeLine } from '../atlas/runtimes.js'
import { ATLAS_STYLE } from '../atlas/style.js'
import { CHROME_STYLE } from '../console/theme.js'

const SITE = 'https://site.test'
const SITE_HOST = 'site.test'

/**
 * The `style-src` sources of a policy, or `default-src`'s where it has none
 * (`#786`).
 *
 * The fallback is the part worth having: a policy that dropped `style-src`
 * entirely would inherit `default-src 'none'` and refuse every stylesheet, and a
 * check that only looked for a `style-src` directive would find nothing to
 * object to.
 */
function styleSrcOf(csp: string): readonly string[] {
  const directives = csp.split(';').map((directive) => directive.trim().split(/\s+/))
  const named = (name: string) => directives.find((parts) => parts[0] === name)?.slice(1)

  return named('style-src') ?? named('default-src') ?? []
}

/**
 * Whether a policy's source list permits fetching one URL from one page.
 *
 * **Only the forms these responses actually emit** — the keywords and a bare
 * origin. This is not a CSP implementation and must not grow into one: its job
 * is to answer the single question the browser answered differently from us,
 * which is whether `'self'` is in the list when the file is same-origin.
 */
function permits(sources: readonly string[], url: URL, pageOrigin: string): boolean {
  return sources.some((source) => {
    if (source === '*') return true
    if (source === "'self'") return url.origin === new URL(pageOrigin).origin
    if (source.startsWith("'")) return false

    return url.origin === source || url.href.startsWith(source)
  })
}

/**
 * The Atlas, served by the API on the website's host (`#546`).
 *
 * **The tests are grouped by the four things the issue is actually about**: that
 * it answers at all, that it answers only where it should, that a crawler can
 * find every page, and that a public route stays public — the last being the one
 * new risk the issue names.
 */
describe('the Atlas on the website host', () => {
  let app: FastifyInstance
  let colony: FakeColony

  const build = (websiteUrl: string = SITE, atlasPlaybooks?: AtlasPlaybookReader) => {
    colony = fakeColony()
    colony.recipes.write({
      kind: 'github',
      provider: 'github',
      title: 'GitHub',
      steps: [
        { actor: 'agent', instruction: 'Open the signup form.' },
        {
          actor: 'operator',
          instruction: 'A human has to pass the challenge.',
          ask: 'Please open this URL and complete the challenge you find there.',
        },
      ],
      proves: 'rung',
    })
    colony.recipes.write({
      kind: 'social',
      provider: 'bluesky',
      title: 'Bluesky',
      status: 'refused',
      category: 'social-publishing',
      refusal: 'No honest signup route exists for a citizen without a phone number.',
    })
    /** `#604`'s three, one row each, so every public surface can be checked against them. */
    colony.recipes.write({
      kind: 'mailbox',
      provider: 'withdrawn.example',
      title: 'Withdrawn',
      status: 'retired',
      retiredReason: 'The provider began demanding a phone number in June.',
      steps: [{ actor: 'agent', instruction: 'Open the signup form.' }],
    })
    colony.recipes.write({
      kind: 'mailbox',
      provider: 'walked.example',
      title: 'Walked',
      status: 'measured',
    })
    colony.recipes.write({
      kind: 'mailbox',
      provider: 'unwritten.example',
      title: 'Unwritten',
      status: 'unwritten',
    })

    return buildApp({
      ...colony,
      websiteUrl,
      siteChrome,
      ...(atlasPlaybooks === undefined ? {} : { atlasPlaybooks }),
    })
  }

  /**
   * The site's chrome, supplied rather than fetched (`kolonie-website#99`).
   *
   * The real source fetches `kolonie.ai/site-chrome/`; injecting it here is
   * what lets these tests assert *the pages wear it* without standing up a
   * website. `src/atlas/site-chrome.test.ts` is where the fetching, the cache
   * and the failure behaviour are asserted, against the shape the website
   * actually builds.
   */
  let chrome: SiteChrome | undefined = {
    head: '<link rel="stylesheet" href="/_astro/theme.css">',
    header:
      '<header class="site-header"><a href="/" class="site-header__mark">Kolonie AI</a></header>',
    footer:
      '<footer class="site-footer"><a href="/privacy/">Privacy</a>' +
      '<a href="/terms/">Terms</a><a href="/imprint/">Imprint</a>' +
      '<a href="/citizen-terms/">Citizen terms</a></footer>',
  }

  const siteChrome = async (): Promise<SiteChrome | undefined> => chrome

  const get = (url: string, host: string = SITE_HOST) =>
    app.inject({ method: 'GET', url, headers: { host, accept: 'text/html' } })

  beforeEach(async () => {
    app = build()
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
  })

  describe('the pages', () => {
    it('serves the index as real HTML in the first response', async () => {
      const response = await get('/atlas')

      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toContain('text/html')
      // The whole of `#546`'s search argument: what a crawler receives is the
      // content, not a shell it would have to run script to fill.
      expect(response.body).toContain('GitHub')
      /**
       * **The other half is one link away rather than gone** (`#1103`). The
       * refusal left the default view when the default became what worked, and
       * asserting it here on the same page it is no longer on would be asserting
       * the old default rather than the argument this test is about — so it is
       * asserted where it now lives, in the same first response and with the
       * same content-in-the-HTML property.
       */
      expect((await get('/atlas?worked=false')).body).toContain('Bluesky')
    })

    /**
     * **The shape of the path and not the path** (`#1100`). This asserted the
     * step text until the steps became what citizenship buys; what a stranger
     * gets in their place is how long the path is and who has to be there for
     * it, and `public-projection.test.ts` is what holds the line itself.
     */
    it('serves one page per provider at a readable path', async () => {
      const response = await get('/atlas/github')

      expect(response.statusCode).toBe(200)
      expect(response.body).toContain('class="k-atlas-shape"')
      expect(response.body).not.toContain('Open the signup form.')
    })

    /**
     * **A refusal is a page and not an omission** (`#482`). A map that hides
     * closed roads is worse than no map — an agent that cannot find the entry
     * concludes nobody has looked, and spends the day finding out.
     */
    it('gives a refused provider a full page saying why', async () => {
      const response = await get('/atlas/bluesky')

      expect(response.statusCode).toBe(200)
      expect(response.body).toContain('without a phone number')
    })

    /**
     * **A withdrawal is a page too** (`#604`), on the same rule as the refusal
     * above: `growth/README.md` says a refusal is a page and not an omission,
     * and a withdrawal is the same class of fact. Deleting the row would answer
     * a reader arriving from an old link with a 404 that teaches them nothing —
     * and would destroy the record of why the Colony ever recommended it.
     */
    it('gives a withdrawn provider a page that says what happened and keeps the row', async () => {
      const response = await get('/atlas/withdrawn.example')

      expect(response.statusCode).toBe(200)
      expect(response.body).toContain('demanding a phone number in June')
      expect(response.body).toContain('Withdrawn')
      /**
       * The record that there *was* a path, which is the argument for keeping
       * the row. The path itself is a citizen's since `#1100`, on a withdrawn
       * entry as on a joinable one.
       */
      expect(response.body).toContain('class="k-atlas-shape"')
    })

    /**
     * **There is no state a stranger may not see** (`#604`, inverted by
     * `#1032`).
     *
     * These four asserted the opposite until `#1032`: a `draft` was a path no
     * steward had stood behind and a `proposed` entry was somebody's suggestion
     * nobody had read, and both were withheld. Neither state exists now. A
     * closed walk leaves a public `measured` row the same request it closes in,
     * and an `unwritten` row is the Colony saying out loud that nobody has been
     * here — which is worth more to a reader than an absence, and is what makes
     * the entry findable by the citizen who might walk it.
     *
     * Asserted against the served bytes rather than against the filter, for the
     * reason it always was: the filter agreeing while a page disagrees is
     * exactly the failure that matters, and it now fails the other way round.
     */
    it('shows a walked entry and an unwritten one on the index', async () => {
      /**
       * **The index has two halves since `#1103`, and none of these three is on
       * the first one** — nobody has got through at any of them, which is the
       * whole of what decision 2 asks. That is not the withholding `#1032`
       * reversed: the rows are on the index, at a URL a link on the default view
       * reaches, and `#1103`'s own tests below assert that the two halves are
       * the whole catalogue with nothing in neither. What this test still says
       * is what it always said — no *state* takes an entry off the index.
       */
      const response = await get('/atlas?worked=false')

      expect(response.body).toContain('walked.example')
      expect(response.body).toContain('unwritten.example')
      /** And the withdrawal, which is the state that was public before either. */
      expect(response.body).toContain('withdrawn.example')
    })

    it('gives each of them a page of its own', async () => {
      expect((await get('/atlas/walked.example')).statusCode).toBe(200)
      expect((await get('/atlas/unwritten.example')).statusCode).toBe(200)
    })

    it('carries both in catalogue.json', async () => {
      const response = await get('/atlas/catalogue.json')
      const document = JSON.parse(response.body) as {
        entries: readonly { provider: string }[]
      }
      const providers = document.entries.map((entry) => entry.provider)

      expect(providers).toContain('walked.example')
      expect(providers).toContain('unwritten.example')
      expect(providers).toContain('withdrawn.example')
    })

    /**
     * **The sitemap is the one surface that still tells the two apart, and it is
     * not a visibility rule** (`#790`). Every state above is served, linked and
     * in the catalogue; what the sitemap decides is what to hand a crawler by
     * name, and ninety-three near-identical *nobody has looked at this yet*
     * pages are the doorway pattern `growth/README.md` forbids.
     *
     * **A walked entry belongs in it since `#1032`.** `measured` is what a
     * closed walk writes, so `atlasIsWalked` counts it — excluding it would have
     * left the sitemap holding only the states nobody walks and dropped the
     * findings, which is the inverse of what `#790` was for.
     */
    it('submits the walked entry to a crawler and not the unwritten one', async () => {
      const response = await get('/atlas/sitemap.xml')

      expect(response.body).toContain('walked.example')
      expect(response.body).toContain('withdrawn.example')
      expect(response.body).not.toContain('unwritten.example')
    })

    /**
     * **A page on `kolonie.ai` looks like a page on `kolonie.ai`, whichever
     * process rendered it** (`kolonie-website#99`).
     *
     * Measured on 2026-08-08, `/atlas` had no `<header>`, no `<footer>`, no
     * `.site-footer` and one link in a `nav`. A visitor arriving from a search
     * result saw a page with no navigation, no way back to the site, and no
     * link to the privacy policy, the terms or the imprint.
     */
    it('wears the site’s own header and footer on the index and on an entry', async () => {
      for (const url of ['/atlas', '/atlas/github']) {
        const body = (await get(url)).body

        expect(body, `${url} has no site header`).toContain('<header class="site-header"')
        expect(body, `${url} has no site footer`).toContain('<footer class="site-footer"')
        expect(body, `${url} cannot get back to the site`).toContain(
          'href="/" class="site-header__mark',
        )
      }
    })

    /**
     * `#42` and `#44` require all four on every page, and the Atlas pages were
     * the ones that had none of them.
     */
    it('reaches all four legal pages from an Atlas page', async () => {
      const body = (await get('/atlas/github')).body

      for (const legal of ['/privacy/', '/terms/', '/imprint/', '/citizen-terms/']) {
        expect(body, `${legal} is not reachable from an Atlas page`).toContain(`href="${legal}"`)
      }
    })

    it('loads the site’s stylesheet so the chrome is not unstyled links', async () => {
      expect((await get('/atlas')).body).toContain('rel="stylesheet" href="/_astro/theme.css"')
    })

    /**
     * **The assertion that was missing, and its absence is the whole of `#786`.**
     *
     * Two tests already guard this fragment and both were green while every one
     * of its stylesheets was being refused by the browser: one asserts the
     * `<link>` string reaches the body, the other — in `kolonie-website` — that
     * the classes it uses have rules. Neither asks the third question, which is
     * whether the response *permits* the file it is asking for. `style-src`
     * carried `'unsafe-inline'` and no `'self'`, so the markup arrived, the
     * rules never did, and the header's mark rendered at 1248 px.
     *
     * So this reads the policy off the same response as the markup, and asks it
     * about every href that response actually contains. A one-word regression in
     * `ATLAS_HEADERS` fails it.
     */
    it('permits every stylesheet the chrome contributes, on the same response', async () => {
      for (const url of ['/atlas', '/atlas/github']) {
        const response = await get(url)
        const csp = response.headers['content-security-policy']
        expect(typeof csp, `${url} sends no content-security-policy`).toBe('string')

        const hrefs = [...response.body.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/g)]
          .map((link) => /href="([^"]*)"/.exec(link[0])?.[1])
          .filter((href): href is string => href !== undefined)

        expect(hrefs.length, `${url} contributes no stylesheet to check`).toBeGreaterThan(0)

        for (const href of hrefs) {
          expect(
            permits(styleSrcOf(String(csp)), new URL(href, SITE), SITE),
            `${url} asks for ${href} and its own policy refuses it`,
          ).toBe(true)
        }
      }
    })

    /**
     * The other half of the same directive, kept as its own assertion because it
     * is granted for a different reason: `atlasPage()` writes a `<style>` block.
     * Widening `style-src` for the fragment must not narrow it for that.
     */
    it('permits the style block it writes itself', async () => {
      const csp = String((await get('/atlas')).headers['content-security-policy'])

      expect((await get('/atlas')).body).toContain('<style>')
      expect(styleSrcOf(csp)).toContain("'unsafe-inline'")
    })

    /** D-062: no script runs on an Atlas page, and nothing here relaxes that. */
    it('grants no script source at all', async () => {
      const csp = String((await get('/atlas')).headers['content-security-policy'])

      expect(csp).not.toContain('script-src')
      expect(csp).toContain("default-src 'none'")
    })

    /**
     * **One identity at the top of the page, never two.** The mast this page
     * carried before `#99` is the fallback and not an addition — `#50` is named
     * for the state where a site has two headers that disagree.
     */
    it('drops its own mast when it is wearing the site’s header', async () => {
      const body = (await get('/atlas')).body

      expect(body.match(/<header\b/g)).toHaveLength(1)
      expect(body).not.toContain('class="console-header"')
    })

    /**
     * **The degradation, and it is the reason this is a fetch and not a
     * requirement.** A static website being down must not take the catalogue
     * with it: the pages render exactly as they did before `#99`.
     */
    it('serves the pages without chrome when the website cannot be reached', async () => {
      chrome = undefined
      try {
        const response = await get('/atlas/github')

        expect(response.statusCode).toBe(200)
        expect(response.body).not.toContain('site-header')
        /** Its own mast comes back, so the page is still navigable. */
        expect(response.body).toContain('class="console-header"')
        expect(response.body).toContain('class="k-atlas-shape"')
      } finally {
        chrome = {
          head: '<link rel="stylesheet" href="/_astro/theme.css">',
          header:
            '<header class="site-header"><a href="/" class="site-header__mark">Kolonie AI</a></header>',
          footer:
            '<footer class="site-footer"><a href="/privacy/">Privacy</a>' +
            '<a href="/terms/">Terms</a><a href="/imprint/">Imprint</a>' +
            '<a href="/citizen-terms/">Citizen terms</a></footer>',
        }
      }
    })

    /**
     * **The page box belongs to the content when the chrome is around it**
     * (`#1211`). `CONSOLE_STYLE` boxes `<body>`, which insets a band built to run
     * edge to edge and drops it below the top of the viewport with page
     * background above it. The block that undoes it is emitted here and only
     * here.
     */
    it('moves the page box off the body when it is wearing the site’s chrome', async () => {
      const body = (await get('/atlas')).body

      expect(body).toContain(CHROME_STYLE)
      /** The band is unboxed and the content column keeps the box it had. */
      expect(body).toContain('max-width: none')
      expect(body).toContain('max-width: var(--k-container)')
    })

    /**
     * **Last, so it wins.** Both blocks above it say something about `body`, and
     * the cascade decides this on order alone: same specificity, later rule. A
     * refactor that composed the three in a different order would leave the band
     * boxed with every one of these rules still present in the document.
     */
    it('writes the chrome’s block after the two it has to override', async () => {
      const body = (await get('/atlas')).body

      expect(body.indexOf(CHROME_STYLE)).toBeGreaterThan(body.indexOf(ATLAS_STYLE))
    })

    /**
     * **The two roots and nothing wider.** The header's `Sign in` and the
     * footer's links are the website's own text and are set in the website's
     * face; the monospace face stays the identity on everything the page renders
     * itself, which is why `ATLAS_STYLE` scopes prose to `main p, main li`.
     */
    it('sets the prose face on the chrome and not on the body', async () => {
      const body = (await get('/atlas')).body

      expect(body).toContain('header.site-header')
      expect(body).toContain('footer.site-footer')
      expect(body).not.toContain('body {\n    font-family: var(--k-font-prose')
    })

    /**
     * The other branch, and the criterion `#1211` is careful about: a page that
     * fell back to its own mast renders what it rendered before. The block is
     * absent from the document rather than present and inert, so there is no
     * selector to get wrong and nothing to test for at the browser.
     */
    it('leaves a page without chrome exactly as it was', async () => {
      chrome = undefined
      try {
        const body = (await get('/atlas')).body

        expect(body).not.toContain(CHROME_STYLE)
        expect(body).not.toContain('max-width: none')
        /** The console's body box is still the box, which is right without chrome. */
        expect(body).toContain('padding: var(--k-space-6) var(--k-space-4) var(--k-space-7)')
      } finally {
        chrome = {
          head: '<link rel="stylesheet" href="/_astro/theme.css">',
          header:
            '<header class="site-header"><a href="/" class="site-header__mark">Kolonie AI</a></header>',
          footer:
            '<footer class="site-footer"><a href="/privacy/">Privacy</a>' +
            '<a href="/terms/">Terms</a><a href="/imprint/">Imprint</a>' +
            '<a href="/citizen-terms/">Citizen terms</a></footer>',
        }
      }
    })

    /**
     * The box has somewhere to go on every one of these pages. It is asserted
     * rather than assumed: the rule is scoped to `main`, so a shell that rendered
     * its content loose in the body would lose the column silently — the page
     * would still be full-bleed and the prose would run the width of the screen.
     */
    it.each(['/atlas', '/atlas/github', '/atlas/c/mailbox'])(
      'wraps %s in the element the box moved to',
      async (url) => {
        expect((await get(url)).body).toContain('<main')
      },
    )

    /**
     * **The catalogue is still live, which is `#99`'s criterion and the whole
     * reason option 2 was refused.** Nothing about the chrome is baked: an
     * entry curated now is on the page now.
     */
    it('serves a curated entry without a deploy, chrome and all', async () => {
      colony.recipes.write({
        kind: 'mailbox',
        provider: 'curated-just-now.example',
        title: 'Curated just now',
        status: 'unwritten',
      })

      /**
       * On the half a never-walked entry belongs to (`#1103`) — the liveness
       * this is about is *no deploy stands between the row and the page*, and
       * which of the two views carries it says nothing about that.
       */
      const body = (await get('/atlas?worked=false')).body

      expect(body).toContain('curated-just-now.example')
      expect(body).toContain('<header class="site-header"')
    })

    /**
     * **The index is a map and not a list** (`kolonie-website#97`).
     *
     * It groups by category with a count per group, and the count is derived on
     * every render — `#97` is explicit that *ninety-six providers* ages on the
     * next curation, and so does a number typed one shelf down.
     */
    it('groups the index by category, with a count per shelf', async () => {
      const body = (await get('/atlas')).body

      expect(body).toContain('code-hosting')
      expect(body).toContain('social-publishing')
      /**
       * One social-publishing row — the refusal. Asserted on that shelf rather
       * than on `mailbox`, which other cases in this file write to: the count
       * is the assertion, and a count that another test can move is one that
       * fails for a reason nobody reads.
       */
      expect(body).toMatch(/Social and publishing<\/a> <span class="k-atlas-count">1<\/span>/)
    })

    /**
     * **A shelf is a page and never a widget** — `#1107` decision 3, D-062, and
     * the same decision the console's browser took in `#591`. There is no script
     * on this page to fail.
     */
    it('serves one shelf as a page of its own, with no JavaScript anywhere', async () => {
      const response = await get('/atlas/c/social-publishing')

      expect(response.statusCode).toBe(200)
      expect(response.body).toContain('Bluesky')
      expect(response.body).not.toContain('>GitHub<')
      /**
       * **No executable script, which is the promise** (`#97`, D-062): the shelf
       * is a link and the page works with JavaScript off. The `ld+json` block
       * `#789` added is data — the browser never executes it — so the assertion
       * is about a script that *runs* rather than about the string.
       */
      expect(response.body).not.toContain('<script>')
      expect(response.body).not.toContain('text/javascript')
      /** And a way back out to the whole catalogue. */
      expect(response.body).toContain('Every category')
    })

    /**
     * A category nobody defined is the unfiltered index rather than a 404: it
     * is what a reader following a stale or mistyped link most wants, and
     * `#591` took the same decision one surface over.
     */
    it('answers a category nobody defined with the whole index', async () => {
      const response = await get('/atlas?category=nonsense')

      expect(response.statusCode).toBe(200)
      expect(response.body).toContain('GitHub')
      /**
       * *The whole index* means the unfiltered one and not both of its halves
       * (`#1103`): the fallback is what a nonsense category loses, not the
       * second view. So the refusal is asserted on the same unfiltered request
       * with the other half asked for, which is what a reader following that
       * stale link is one link from.
       */
      expect((await get('/atlas?category=nonsense&worked=false')).body).toContain('Bluesky')
    })

    /**
     * **Internal linking runs in both directions** (`kolonie-website#97`),
     * which is what makes a map out of a list. Entry to category was the
     * missing half: the category on an entry page linked to the whole index.
     */
    it('links an entry to its own shelf, and the shelf back to the entry', async () => {
      expect((await get('/atlas/github')).body).toContain('/atlas/c/code-hosting')
      expect((await get('/atlas/c/code-hosting')).body).toContain('/atlas/github')
    })

    /**
     * **The reader has to be able to tell the page is about what they run**
     * (`kolonie-website#110`). Measured on 2026-08-17, `/atlas`, a shelf and a
     * provider page each contained `Hermes` and `OpenClaw` zero times, on a
     * catalogue whose own headings ask *which telephony can an AI agent sign up
     * for*. Asserted on all three surfaces, because the line regressing to
     * nothing on one of them is exactly the state that was measured.
     */
    it('names the runtimes that walk it, on the index, a shelf and an entry', async () => {
      for (const url of ['/atlas', '/atlas/c/code-hosting', '/atlas/github']) {
        const body = (await get(url)).body

        expect(body).toContain(atlasRuntimeLine())
        expect(body).toContain('OpenClaw')
        expect(body).toContain('Hermes')
      }
    })

    /**
     * **The order is the issue.** `#97` lists what a reader must be able to
     * answer without scrolling, and asserting the sections exist would pass on
     * a page that answered them in any order — which is the page it already
     * was.
     */
    it('answers #97’s questions in #97’s order on an entry page', async () => {
      const page = (await get('/atlas/github')).body
      /**
       * **The `<main>` and not the document.** The site's chrome brings a
       * `<style>` block naming every class on this page, so an index into the
       * whole response finds `k-atlas-facts` in a stylesheet before it finds
       * the element (`kolonie-website#99`).
       */
      const body = page.slice(page.indexOf('<main>'))
      const at = (needle: string) => body.indexOf(needle)

      /**
       * 1 what it is · 2 can it do this alone · 3 the recipe · 5 last confirmed
       *
       * Question 3 is answered by the shape of the path since `#1100` rather
       * than by the path — the *order* is what this test is about, and the
       * section still sits where `#97` put it.
       */
      expect(at('<h1>')).toBeLessThan(at('k-atlas-facts'))
      expect(at('k-atlas-facts')).toBeLessThan(at('k-atlas-shape'))
      expect(at('k-atlas-shape')).toBeLessThan(at('k-atlas-confirmed'))
      expect(at('k-atlas-confirmed')).toBeGreaterThan(-1)
    })

    /**
     * The fifth question, which the page could not answer before: *"A recipe
     * nobody has walked in six months is a guess with a date on it."* The page
     * spoke up when the answer was *too long ago* and said nothing when it was
     * *recently* — leaving a reader unable to tell a checked entry from an
     * unbuilt feature.
     */
    it('says when an entry was last confirmed, or that nobody has', async () => {
      /** The fixture writes a confirmation, so this is the dated branch. */
      expect((await get('/atlas/github')).body).toMatch(
        /Last confirmed by a citizen who walked it on \d{4}-\d{2}-\d{2}/,
      )

      /**
       * And the other one, which is the branch that matters: a page that only
       * spoke up when something was stale left a reader unable to tell an
       * unwalked entry from an unbuilt feature.
       */
      colony.recipes.write({
        kind: 'mailbox',
        provider: 'unwalked.example',
        title: 'Unwalked',
        status: 'unwritten',
        lastConfirmedAt: null,
      })

      expect((await get('/atlas/unwalked.example')).body).toContain(
        'Nobody has confirmed this entry',
      )
    })

    /**
     * **Both readers, and the second is why this is asserted at all**
     * (`#97`): an operator deciding whether the Colony is worth their agents'
     * time, and an agent that fetched the page instead of the tool. With every
     * tag stripped, the page still has to be the page.
     */
    it('reads as clean text with every style and tag stripped', async () => {
      const text = (await get('/atlas/bluesky')).body
        .replace(/<style\b[\s\S]*?<\/style>/g, ' ')
        /** `ld+json` is data and not prose, stripped for the reason `<style>` is (`#789`). */
        .replace(/<script\b[\s\S]*?<\/script>/g, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')

      /** The domain and not the row's title, since `kolonie-website#112`. */
      expect(text).toContain('bluesky')
      expect(text).toContain('without a phone number')
      /** The refusal reads as a finding rather than as an error page. */
      expect(text).not.toMatch(/\berror\b/i)
      expect(text).not.toContain('{')
    })

    /**
     * `application/ld+json` appeared 0 times anywhere on kolonie.ai until `#789`.
     * What is left of it is the page's own structure — where this entry sits in
     * the map, and what the index listed.
     *
     * **The `HowTo` went with the steps** (`#1100`). It was a list of step names
     * and step text, and a `HowTo` beside a page that no longer prints the steps
     * would have been the leak. Asserted as an absence on every state, so a
     * later restoration has to argue with this line rather than pass it.
     */
    it('carries the machine-readable copy of what it says', async () => {
      const entryPage = (await get('/atlas/github')).body
      const index = (await get('/atlas')).body

      expect(entryPage).toContain('<script type="application/ld+json">')
      expect(entryPage).toContain('"@type":"BreadcrumbList"')
      expect(entryPage).not.toContain('"@type":"HowTo"')
      expect(index).toContain('"@type":"ItemList"')
      /** A refusal is still a place in the map, and still not a set of steps. */
      expect((await get('/atlas/bluesky')).body).toContain('"@type":"BreadcrumbList"')
      expect((await get('/atlas/bluesky')).body).not.toContain('"@type":"HowTo"')
    })

    it('carries a title, a description and a canonical on every page', async () => {
      const response = await get('/atlas/github')

      /** The title is the searcher's sentence since `#788`, not the curator's. */
      expect(response.body).toContain('<title>github for an AI agent: sign up, prove it — Kolonie')
      expect(response.body).toContain('<meta name="description"')
      expect(response.body).toContain(`<link rel="canonical" href="${SITE}/atlas/github">`)
    })

    /**
     * The console is `noindex` because it is an authenticated surface. This is
     * the opposite surface, and inheriting that tag from the shared shell is
     * exactly the mistake two shells exist to prevent.
     */
    it('does not tell crawlers to stay away', async () => {
      expect((await get('/atlas')).body).not.toContain('noindex')
    })

    it('answers 404 for a provider with no entry', async () => {
      expect((await get('/atlas/nobody-has-written-this')).statusCode).toBe(404)
    })
  })

  /**
   * What separates the Atlas from a link collection (`#545`): anyone can curate
   * a list, and only the Colony knows how many agents actually got through.
   */
  describe('the measured figures', () => {
    const withFigures = async (figures: Parameters<typeof colony.recipes.measure>[0]) => {
      await app.close()
      app = build()
      colony.recipes.measure(figures)
      await app.ready()
    }

    it('prints how many got through, and out of how many', async () => {
      await withFigures({
        ...noFigures('github', 'github'),
        attempted: 50,
        proved: 20,
        medianHoursToProof: 3,
      })

      const body = (await get('/atlas/github')).body

      expect(body).toContain('40% of 50 agents got through')
      expect(body).toContain('within 3 hours')
    })

    it('prints the thirty-day figure, which is the one that makes the rest trustworthy', async () => {
      await withFigures({
        ...noFigures('github', 'github'),
        attempted: 40,
        proved: 30,
        stillHeld: 24,
        heldLongEnoughToAsk: 30,
      })

      expect((await get('/atlas/github')).body).toContain('24 of 30 still held the account')
    })

    /**
     * The moment a bad result can be suppressed by a paying provider, every
     * number becomes worthless. There is no branch that hides a low one.
     */
    it('prints a poor result exactly as it prints a good one', async () => {
      await withFigures({ ...noFigures('github', 'github'), attempted: 60, proved: 0, refused: 55 })

      const body = (await get('/atlas/github')).body

      expect(body).toContain('0% of 60 agents got through')
      expect(body).toContain('55 were refused outright')
    })

    /** A suppressed row and an untried one look identical unless the page says which. */
    it('says why it is showing nothing, rather than showing zeroes', async () => {
      await withFigures({ ...noFigures('github', 'github'), suppressed: true })

      expect((await get('/atlas/github')).body).toContain('without describing individuals')
    })

    /**
     * What a walk or two buys a reader (`#792`).
     *
     * **The apology was nearly the whole catalogue.** The floor takes every
     * count, every line in this section was a count, so almost every entry
     * printed *too few agents have tried this* and nothing else. A band and a
     * stop are neither a count nor reducible to one, so they are published.
     */
    it('tells a small sample what it can, instead of only apologising', async () => {
      await withFigures({
        ...noFigures('github', 'github'),
        suppressed: true,
        band: 'few-got-through',
        commonestStop: 'signup-refused',
      })

      const body = (await get('/atlas/github')).body

      expect(body).toContain('Few of the agents who tried this got through')
      expect(body).toContain('signup was refused')
      expect(body).not.toContain('The recipe above is what is known')
    })

    /** And the counts behind them stay behind the floor, which is the whole bargain. */
    it('publishes no count or percentage below the floor', async () => {
      await withFigures({
        ...noFigures('github', 'github'),
        suppressed: true,
        band: 'about-half',
        commonestStop: 'abandoned',
      })

      const body = (await get('/atlas/github')).body

      expect(body).toContain('the numbers behind these are withheld')
      expect(body).not.toMatch(/\d+% of \d+ agents got through/)
      expect(body).not.toContain('agents got through')
    })

    /**
     * **The row `#1167` found**, and the correction to the two tests above it.
     *
     * The band and the stop clear the floor and the count that would balance them
     * does not, so a provider one citizen abandoned and later got into printed
     * pure abandonment — for good, since a walk cannot honestly be restated after
     * it closes (`#1062`). `anyProved` is the later fact standing beside the
     * stop, and it is a boolean for the same reason the counts are floored.
     */
    it('says a citizen got in, beside the stop where somebody gave up', async () => {
      await withFigures({
        ...noFigures('github', 'github'),
        suppressed: true,
        band: 'few-got-through',
        commonestStop: 'abandoned',
        anyProved: true,
      })

      const body = (await get('/atlas/github')).body

      expect(body).toContain(ATLAS_ANY_PROVED_PHRASE)
      /** And it stands beside the stop rather than replacing it. */
      expect(body).toContain('they gave up before it was settled')
      expect(body).not.toMatch(/\d+% of \d+ agents got through/)
    })

    it('claims no arrival on a row where nobody has arrived', async () => {
      await withFigures({
        ...noFigures('github', 'github'),
        suppressed: true,
        band: 'few-got-through',
        commonestStop: 'abandoned',
      })

      expect((await get('/atlas/github')).body).not.toContain(ATLAS_ANY_PROVED_PHRASE)
    })

    /**
     * The step number and not the step's words: a reader who has just read the
     * recipe can look up, and printing the instruction again would be the page
     * saying the same thing twice.
     */
    it('points a stop at the step of the recipe above it', async () => {
      await withFigures({
        ...noFigures('github', 'github'),
        suppressed: true,
        commonestStop: 'never-provisioned',
      })

      expect((await get('/atlas/github')).body).toContain('step 2 above')
    })

    /** A row whose counts are suppressed and which has nothing else to say still says so. */
    it('keeps the apology for the row with nothing publishable on it', async () => {
      await withFigures({ ...noFigures('github', 'github'), suppressed: true })

      expect((await get('/atlas/github')).body).toContain('The recipe above is what is known')
    })

    it('says on the index that the order is not for sale', async () => {
      expect((await get('/atlas')).body).toContain('never by payment')
    })

    /**
     * `#543` rule 2 refuses to sell ordering. This is the property that makes
     * that refusal structural: the order is recomputed from the measurements, so
     * there is no position anybody could be moved to.
     */
    it('orders the index by measured outcome and not by the catalogue', async () => {
      await app.close()
      app = build()
      colony.recipes.write({ kind: 'mailbox', provider: 'aaa-first-alphabetically', title: 'AAA' })
      colony.recipes.measure({
        ...noFigures('mailbox', 'aaa-first-alphabetically'),
        attempted: 10,
        proved: 1,
      })
      colony.recipes.measure({ ...noFigures('github', 'github'), attempted: 10, proved: 9 })
      await app.ready()

      const body = (await get('/atlas')).body

      expect(body.indexOf('/atlas/github')).toBeLessThan(
        body.indexOf('/atlas/aaa-first-alphabetically'),
      )
    })

    /**
     * **The walk a reader could not find** (`#1096`). `bounty-platform` is a
     * kind citizens proved accounts under and no shelf is paired with, so the
     * catalogue dropped the pair on the way to the page and the briefing behind
     * it was readable nowhere on the website.
     *
     * Asserted on the page and on the index both, because they are two reads of
     * the same catalogue and only one of them was ever the complaint.
     */
    it('serves a page for a provider whose kind is paired with no shelf', async () => {
      await withFigures({
        ...noFigures('bounty-platform', 'gib.work'),
        attempted: 4,
        proved: 2,
        evidenced: true,
      })

      const page = await get('/atlas/gib.work')

      expect(page.statusCode).toBe(200)
      expect(page.body).toContain('gib.work')
      expect((await get('/atlas')).body).toContain('/atlas/gib.work')
    })

    /**
     * The guard in front of the fallback, through the surface a reader uses: a
     * pair nobody has demonstrably reached is not an entry, and being of a kind
     * nobody classified does not make it one.
     */
    it('serves no page for a shelf-less kind a citizen only declared', async () => {
      await withFigures({
        ...noFigures('bounty-platform', 'laborx.com'),
        attempted: 1,
        proved: 0,
        evidenced: false,
      })

      expect((await get('/atlas/laborx.com')).statusCode).toBe(404)
    })
  })

  /**
   * What a refusal carries under it (`#1094`).
   *
   * **A refusal is what the walkers found, not the absence of walkers.** Before
   * `#1032` a refused entry was a sentence somebody wrote with nothing measured
   * behind it, and `recipeSection` returned early on that premise. Under `#1032`
   * eight of the fourteen written briefings sat on refused entries — one of them
   * on ten claims — and the page printed *nobody has walked this* over the top of
   * them, while the same briefing went out over MCP with no status gate at all.
   *
   * `telephony/telnyx.com` is the shape these are modelled on.
   */
  describe('a refused entry and what was measured behind it', () => {
    const refused = (write: (colony: FakeColony) => void) => async () => {
      await app.close()
      app = build()
      colony.recipes.write({
        kind: 'telephony',
        provider: 'refused.example',
        title: 'Refused',
        status: 'refused',
        refusal: 'Signup demands a document no citizen holds.',
        /**
         * **Explicitly nobody-confirmed**, or the sentence `#1094` is about would
         * be answered by `lastConfirmedAt` before `confirmedLine` ever reached
         * the branch under test — and both of the tests below would pass over an
         * unchanged page.
         */
        lastConfirmedAt: null,
      })
      write(colony)
      await app.ready()
    }

    /** Ten claims and a wall the walkers actually met, on a page that hid both. */
    const briefing = {
      kind: AccountKindSchema.parse('telephony'),
      provider: 'refused.example',
      claims: [
        {
          section: 'wall' as const,
          text: 'Signup asks for a government document before the account exists.',
          walks: 4,
          platforms: { openclaw: 4 },
          lastSupportedAt: '2026-08-15T00:00:00.000Z',
          sources: [],
          current: true,
        },
      ],
      model: 'a-model',
      writtenAt: '2026-08-15T00:00:00.000Z',
    }

    const walkedFigures = {
      ...noFigures('telephony', 'refused.example'),
      attempted: 12,
      proved: 0,
      refused: 11,
      evidenced: true,
      walked: {
        citizens: 9,
        gotThrough: 0,
        band: 'few-got-through' as const,
        platforms: { openclaw: 9 },
        walls: [{ kind: 'identity-document' as const, citizens: 9 }],
        homepage: null,
        anySighted: false,
        anyAbandoned: false,
      },
    }

    it('renders the briefing and the figures the page used to hide', async () => {
      await refused((one) => {
        one.recipes.measure(walkedFigures)
        one.recipes.brief(briefing)
      })()

      const body = (await get('/atlas/refused.example')).body

      expect(body).toContain('Signup asks for a government document before the account exists.')
      expect(body).toContain('0% of 12 agents got through')
      expect(body).toContain('11 were refused outright')
    })

    const criteriaBoxOf = (body: string) =>
      /<dl class="k-atlas-criteria">(.*?)<\/dl>/s.exec(body)?.[1] ?? ''

    /**
     * **An empty FAQ row is dropped once the briefing has something to say**
     * (`#1326` decision 3).
     *
     * The rows are all true and the box is right to print them on a page that has
     * nothing else — `#1105` decision 2 is emphatic that *not known* must never
     * be read as *no*. What changed is what sits beside them: measured
     * 2026-08-19 on `clawlancer.ai`, a strong *What citizens measured* section
     * with seven consecutive rows under it saying nothing at all.
     */
    it('drops the criteria rows that answer nothing, once a briefing is on the page', async () => {
      await refused((one) => {
        one.recipes.measure(walkedFigures)
        one.recipes.brief(briefing)
      })()

      const box = criteriaBoxOf((await get('/atlas/refused.example')).body)

      expect(box).not.toContain('Not known.')
      expect(box).not.toContain('Not reported by anybody who walked it.')
    })

    /**
     * **And keeps every one of them where the box is all the page has**, which is
     * what stops the suppression taking the last thing off a page. Same entry,
     * same criteria, no briefing — so what is asserted is the briefing's presence
     * deciding it and not a property of this provider.
     */
    it('keeps the unanswered rows on the same page with no briefing', async () => {
      await refused((one) => {
        one.recipes.measure(walkedFigures)
      })()

      const box = criteriaBoxOf((await get('/atlas/refused.example')).body)

      expect(box).toContain('Not known.')
    })

    /**
     * **The refusal first, then the figures** (`#1094`). `#1298` may hoist the
     * moderated write-up into a labelled lead above the FAQ — that lead is not a
     * signup invitation — but inside the recipe section the closed road still
     * comes before the counts.
     */
    it('puts the refusal above the figures and the briefing', async () => {
      await refused((one) => {
        one.recipes.measure(walkedFigures)
        one.recipes.brief(briefing)
      })()

      const body = (await get('/atlas/refused.example')).body
      const refusal = body.indexOf('Signup demands a document no citizen holds.')
      const figures = body.indexOf('0% of 12 agents got through')
      const written = body.indexOf('Signup asks for a government document')
      const lead = body.indexOf('Citizen-attributed findings')

      expect(refusal).toBeGreaterThan(-1)
      expect(refusal).toBeLessThan(figures)
      expect(written).toBeGreaterThan(-1)
      expect(lead).toBeGreaterThan(-1)
      expect(lead).toBeLessThan(refusal)
    })

    /**
     * `briefingSection` already answers `undefined` with the empty string, and
     * `#1094` invented no wording for the case: a refused entry nobody wrote up
     * renders no heading and no placeholder sentence.
     */
    it('renders no briefing heading where nothing was written', async () => {
      await refused((one) => one.recipes.measure(walkedFigures))()

      const body = (await get('/atlas/refused.example')).body

      expect(body).toContain('Signup demands a document no citizen holds.')
      expect(body).not.toContain('What goes wrong here')
      expect(body).not.toContain('What nobody has solved')
    })

    /**
     * **The floor is untouched by this** (`#1094` decision 4). Which pages print
     * figures changed; which figures may be printed did not.
     */
    it('keeps a refused entry below the floor behind it', async () => {
      await refused((one) => {
        one.recipes.measure({
          ...noFigures('telephony', 'refused.example'),
          suppressed: true,
          band: 'few-got-through',
          commonestStop: 'signup-refused',
          evidenced: true,
          walked: {
            citizens: 0,
            gotThrough: 0,
            band: 'few-got-through' as const,
            platforms: {},
            walls: [],
            homepage: null,
            anySighted: false,
            anyAbandoned: false,
          },
        })
        one.recipes.brief(briefing)
      })()

      const body = (await get('/atlas/refused.example')).body

      expect(body).toContain('the numbers behind these are withheld')
      expect(body).toContain('Few of the agents who tried this got through')
      expect(body).not.toMatch(/\d+% of \d+ agents got through/)
    })

    /**
     * **The rejection case that stops this being widened by accident.** There is
     * genuinely nothing measured about a provider nobody attempted, so an
     * `unwritten` row prints neither a briefing nor figures even when a briefing
     * row exists for the pair.
     */
    it('still hides both on an unwritten entry that has a briefing anyway', async () => {
      await app.close()
      app = build()
      colony.recipes.brief({
        ...briefing,
        kind: AccountKindSchema.parse('mailbox'),
        provider: 'unwritten.example',
        claims: [{ ...briefing.claims[0]!, text: 'A wall nobody should be reading here.' }],
      })
      colony.recipes.measure({
        ...noFigures('mailbox', 'unwritten.example'),
        attempted: 12,
        proved: 3,
      })
      await app.ready()

      const body = (await get('/atlas/unwritten.example')).body

      expect(body).not.toContain('A wall nobody should be reading here.')
      expect(body).not.toContain('What goes wrong here')
      expect(body).not.toContain('agents got through')
    })

    /**
     * The sentence the goal of `#1094` is named after: no page asserts that
     * nobody has walked a provider that several citizens have walked.
     */
    it('no longer says nobody has walked an entry nine citizens walked', async () => {
      await refused((one) => one.recipes.measure(walkedFigures))()

      expect((await get('/atlas/refused.example')).body).not.toContain(
        'Nobody has confirmed this entry by walking it',
      )
    })

    /**
     * And it still says it where that is true, which is what makes it worth
     * printing. **Read off the band and not off a count**: the figures here are
     * measured and evidenced, and no walk closed behind them.
     */
    it('still says it where nobody has walked the entry', async () => {
      await refused((one) =>
        one.recipes.measure({
          ...noFigures('telephony', 'refused.example'),
          attempted: 12,
          proved: 0,
          refused: 11,
          evidenced: true,
        }),
      )()

      expect((await get('/atlas/refused.example')).body).toContain(
        'Nobody has confirmed this entry by walking it',
      )
    })
  })

  /**
   * A refusal somebody got through anyway (`#1163`).
   *
   * **The page said both things and put the wrong one first.** Measured on
   * 2026-08-17 on live `kolonie.ai/atlas/agentphone.ai`: the `<title>` said *why
   * an agent cannot join it*, the lead said *This cannot be joined honestly, so do
   * not try*, and four sections under them carried browser signup, REST signup, an
   * API key and inbound SMS polling with the walk counts behind each. The shelf
   * meanwhile listed it under *what worked*, because {@link atlasEntryWorked} read
   * the figures while the page read `status`.
   *
   * The fixture is that shape with nothing else in it: one refused row, one
   * evidenced walk that got through, and one wall carrying the capability it
   * closed on.
   */
  describe('a refusal with successful walks under it', () => {
    /** Carrier approval before sending, over an account signup reached (`#1036`). */
    const wall: PublishedWall = {
      kind: 'approval-required',
      direction: 'outbound',
      reportedBy: 3,
      lastReportedAt: '2026-08-16T00:00:00.000Z',
    }

    const partly = async (walls: readonly (typeof wall)[] = [wall]) => {
      await app.close()
      app = build()
      colony.recipes.write({
        kind: 'telephony',
        provider: 'partly.example',
        title: 'A number an agent can be texted at',
        status: 'refused',
        category: 'telephony',
        refusal: 'The carrier refuses outbound messaging to an account this young.',
        walls: [...walls],
      })
      colony.recipes.measure({
        ...noFigures('telephony', 'partly.example'),
        attempted: 9,
        proved: 4,
        evidenced: true,
      })
      await app.ready()
    }

    /**
     * **The criterion `#1163` is written against.** Four agents got in, so *do not
     * try* is a false sentence about the walk however true it is about the route,
     * and no reader should have to reach the figures to find that out.
     */
    it('never puts do-not-try above walks that got through', async () => {
      await partly()

      const body = (await get('/atlas/partly.example')).body

      expect(body).not.toContain('This cannot be joined honestly, so do not try.')
      expect(body).toContain('Somebody got through here, and the route as a whole is still refused')
      /** And the refusal is still on the page, in its own words. */
      expect(body).toContain('The carrier refuses outbound messaging')
      expect(body).toContain('44% of 9 agents got through')
    })

    /** The half that closed, named from the wall and never from `reaches`. */
    it('names the capability the wall was on', async () => {
      await partly()

      expect((await get('/atlas/partly.example')).body).toContain('The wall is on sending.')
    })

    /**
     * **The rejection case, and the one that keeps the sentence honest.** A wall
     * nobody scoped says nothing about which half closed, so the page stops rather
     * than guessing — the lead still appears, and the second sentence does not.
     */
    it('says nothing about a half no wall scoped', async () => {
      await partly([{ ...wall, direction: null as unknown as 'outbound' }])

      const body = (await get('/atlas/partly.example')).body

      expect(body).toContain('Somebody got through here, and the route as a whole is still refused')
      expect(body).not.toContain('The wall is on')
    })

    /** The `<title>` and the description, which are what a search result shows. */
    it('titles the page as both findings rather than as a closed door', async () => {
      await partly()

      const body = (await get('/atlas/partly.example')).body

      expect(body).toContain('<title>partly.example for an AI agent: what got through, and what')
      expect(body).not.toContain('why an AI agent cannot join it')
      expect(body).toContain('the route as a whole is refused')
    })

    /**
     * **The shelf and the page now read one model** (`#1163`). The row was marked
     * *cannot be joined* on a shelf whose default view is what worked, which is
     * the disagreement in its shortest possible form.
     */
    it('marks the row partly on the shelf that lists it', async () => {
      await partly()

      const body = (await get(`${ATLAS_PATH}/c/telephony`)).body

      expect(body).toContain('partly — some walks got in')
      expect(body).not.toContain('cannot be joined')
    })

    /**
     * And a refusal with nothing behind it is untouched, which is what makes the
     * distinction worth drawing at all: `bluesky` carries no figures.
     */
    it('leaves a refusal nobody got through saying do not try', async () => {
      const body = (await get('/atlas/bluesky')).body

      expect(body).toContain('This cannot be joined honestly, so do not try.')
      expect(body).not.toContain('some walks got in')
    })
  })

  /**
   * The other half of the same sentence (`#1141`).
   *
   * `#1094` stopped the *confirmed by walking* line contradicting the figures on
   * a provider page. The index row and the `<title>` kept doing it: `unknown`
   * printed *nobody has walked this* whether or not anybody had, and `measured`
   * — which since `#1032` means a walk closed and nobody wrote the route — took
   * the `nobody has mapped this yet` title meant for `unwritten`.
   *
   * **`mailbox/walked.example` and `mailbox/unwritten.example` are the pair**,
   * written by `build` above with no steps, so both roll up to `unknown` and the
   * only thing that differs between them is the walk.
   */
  describe('a walked entry and an unwalked one, on the row and in the title', () => {
    /**
     * One index row, because the two providers under test share a page.
     *
     * **It throws rather than returning nothing.** A helper that answered the
     * empty string would pass every `not.toContain` below it, which is the half
     * of these tests that is doing the work.
     */
    const rowFor = (body: string, provider: string) => {
      const row = [...body.matchAll(/<li>.*?<\/li>/gs)]
        .map((match) => match[0])
        .find((one) => one.includes(`/atlas/${provider}"`))

      if (row === undefined) throw new Error(`no index row for ${provider}`)

      return row
    }

    const titleOf = (body: string) => /<title>([^<]*)<\/title>/.exec(body)?.[1] ?? ''

    it('says the walk did not settle who is needed, rather than that nobody walked', async () => {
      const row = rowFor((await get('/atlas?worked=false')).body, 'walked.example')

      expect(row).toContain('walked, but who is needed is not known')
      expect(row).not.toContain('nobody has walked this')
    })

    /**
     * **The rejection case, and the reason the string was worth keeping.** An
     * entry nobody has been to still says so, verbatim — a fix that replaced the
     * sentence everywhere would have lost the one place it is true.
     */
    it('still says nobody has walked an entry nobody has walked', async () => {
      const row = rowFor((await get('/atlas?worked=false')).body, 'unwritten.example')

      expect(row).toContain('nobody has walked this, so who is needed is not known')
    })

    /** The same sentence on the entry's own facts line, not only on the row. */
    it('carries it onto the provider page', async () => {
      expect((await get('/atlas/walked.example')).body).toContain(
        'walked, but who is needed is not known',
      )
      expect((await get('/atlas/unwritten.example')).body).toContain(
        'nobody has walked this, so who is needed is not known',
      )
    })

    /**
     * The copy itself is `title.test.ts`'s, against the helper. What is asserted
     * here is that the served page carries it — the two used to be one test, and
     * a rendered `<title>` regexed back out of three kilobytes of page is the
     * reason the phrase `#1327` banned went unwatched for as long as it did.
     */
    it('titles a measured entry as measured, with no Colony route yet', async () => {
      const title = titleOf((await get('/atlas/walked.example')).body)

      expect(title).toContain('measured — no Colony route yet')
      expect(title).not.toContain('no recipe written yet')
      expect(title).not.toContain('nobody has mapped this yet')
    })

    it('leaves the unmapped title on the status it is true of', async () => {
      expect(titleOf((await get('/atlas/unwritten.example')).body)).toContain(
        'nobody has mapped this yet',
      )
    })

    /**
     * **The guess suffix rides on a known need and never on `unknown`**, which is
     * a property of the data rather than of the wording: `recipeOperatorNeed`
     * returns `isGuess: false` alongside `unknown`, and `atlasEntryOperatorNeed`
     * only calls a rolled-up need a guess where every row that decided it was
     * one. So the two sentences above can never take the suffix, and this is the
     * regression guard that splitting the map did not drop it from the two that
     * can.
     */
    it('still marks a guessed need as a guess', async () => {
      await app.close()
      app = build()
      colony.recipes.write({
        kind: 'mailbox',
        provider: 'guessed.example',
        title: 'Guessed',
        status: 'measured',
        operatorGuess: 'operator-needed',
      })
      await app.ready()

      const row = rowFor((await get('/atlas?worked=false')).body, 'guessed.example')

      expect(row).toContain('needs a person at one step (a guess, not a walk)')
      expect(row).not.toContain('who is needed is not known')
    })

    /**
     * **The homepage of a provider that has no catalogue row at all** (`#1330`).
     *
     * The whole chain in one assertion, because each link of it was already
     * correct and the page still showed nothing: a walk files a homepage, the
     * figures carry it unfloored, `measuredOnlyRecipes` synthesises the row
     * because no shelf maps this kind, and `aboutSection` renders it. That is the
     * shape of every scouted earn provider — `clawlancer.ai` on 2026-08-19 had a
     * homepage filed and rendered none.
     */
    it('shows the homepage of a provider whose only row is synthesised', async () => {
      await app.close()
      app = build()
      colony.recipes.measure({
        ...noFigures('bounty-board', 'scouted.example'),
        attempted: 2,
        evidenced: true,
        walked: {
          citizens: 1,
          gotThrough: 0,
          band: null,
          platforms: {},
          walls: [],
          homepage: 'https://scouted.example',
          anySighted: false,
          anyAbandoned: false,
        },
      })
      await app.ready()

      const body = (await get('/atlas/scouted.example')).body

      expect(body).toContain('k-homepage')
      expect(body).toContain('https://scouted.example')
    })

    /**
     * **A scout filing is not a failed signup** (`#1333`), on the page and in the
     * snippet a search result shows. The meta description fell through to
     * *nobody has walked this yet*, which is false of every measured entry by
     * construction — the status exists because somebody did.
     */
    it('reads a scout filing as scouted, in the body and in the head', async () => {
      await app.close()
      app = build()
      colony.recipes.measure({
        ...noFigures('bounty-board', 'onlyscouted.example'),
        attempted: 1,
        evidenced: true,
        walked: {
          citizens: 1,
          gotThrough: 0,
          band: null,
          platforms: {},
          walls: [],
          homepage: 'https://onlyscouted.example',
          anySighted: true,
          anyAbandoned: false,
        },
      })
      await app.ready()

      const body = (await get('/atlas/onlyscouted.example')).body

      expect(body).toContain('Scouted (identity measured; signup not attempted).')
      expect(body).not.toContain('stopped before an account')
      expect(body).not.toContain('Nobody has walked onlyscouted.example yet')
    })

    it('reads a stopped signup as an attempt, and not as a scout filing', async () => {
      await app.close()
      app = build()
      colony.recipes.measure({
        ...noFigures('bounty-board', 'gaveup.example'),
        attempted: 1,
        evidenced: true,
        walked: {
          citizens: 1,
          gotThrough: 0,
          band: null,
          platforms: {},
          walls: [],
          homepage: null,
          anySighted: false,
          anyAbandoned: true,
        },
      })
      await app.ready()

      const body = (await get('/atlas/gaveup.example')).body

      expect(body).toContain('Attempted; stopped before an account.')
      expect(body).not.toContain('signup not attempted')
    })

    /**
     * **A bounty board does not lead with Data and APIs** (`#1329`).
     *
     * `#1096` shelves an unshelvable kind by default rather than dropping it, and
     * that is right — but no renderer read `categoryIsFallback`, so the header of
     * `execution.market` and `clawlancer.ai` led with the one clause on the line
     * that classified nothing, above two that did. The kind and the earn facet
     * `#1331` reads off it are what a reader can act on.
     */
    it('leads a fallback-shelved provider with its kind and how it pays', async () => {
      await app.close()
      app = build()
      colony.recipes.measure({
        ...noFigures('bounty-board', 'boards.example'),
        attempted: 3,
        evidenced: true,
        walked: {
          citizens: 2,
          gotThrough: 0,
          band: null,
          platforms: {},
          walls: [],
          homepage: 'https://boards.example',
          anySighted: true,
          anyAbandoned: false,
        },
      })
      await app.ready()

      const facts = /<p class="k-atlas-facts">(.*?)<\/p>/s.exec(
        (await get('/atlas/boards.example')).body,
      )?.[1]

      expect(facts).toBeDefined()
      expect(facts).toContain('pays for finished tasks')
      /** The fallback slug is not a claim, so it is neither printed nor linked. */
      expect(facts).not.toContain('data-apis')
      expect(facts).not.toContain('/atlas/c/data-apis')
      /**
       * **And it is not a utility claim either** (`#1388`). The dual-use chip
       * read the fallback shelf as the utility axis, so this same header said
       * *worth holding, and pays* about a shelf nobody chose — the one clause
       * `#1329` had just demoted, restored in stronger words.
       */
      expect(facts).not.toContain('worth holding, and pays')
    })

    /**
     * **The Colony's own pitch goes quiet on a measured page that already says
     * something** (`#1326` decision 3).
     *
     * `#1163` argued the other way and its argument still holds where it was
     * made — a reader who has just read that somebody got in is the reader most
     * worth telling what an account is for. Both conditions have to be true here,
     * so neither argument loses: a measured page with nothing on it keeps the
     * block, because there walking it is the ask and the block names the call.
     */
    it('drops the Colony boilerplate from a measured page with a briefing', async () => {
      await app.close()
      app = build()
      colony.recipes.measure({
        ...noFigures('bounty-board', 'briefed.example'),
        attempted: 2,
        evidenced: true,
        walked: {
          citizens: 1,
          gotThrough: 0,
          band: null,
          platforms: {},
          walls: [],
          homepage: 'https://briefed.example',
          anySighted: true,
          anyAbandoned: false,
        },
      })
      colony.recipes.brief({
        kind: AccountKindSchema.parse('bounty-board'),
        provider: 'briefed.example',
        claims: [
          {
            section: 'wall' as const,
            text: 'The board pays out only after a task is accepted by its poster.',
            walks: 2,
            platforms: { claude: 2 },
            lastSupportedAt: '2026-08-18T00:00:00.000Z',
            sources: [],
            current: true,
          },
        ],
        model: 'a-model',
        writtenAt: '2026-08-18T00:00:00.000Z',
      })
      await app.ready()

      const body = (await get('/atlas/briefed.example')).body

      expect(body).toContain('The board pays out only after a task is accepted')
      expect(body).not.toContain('What an account here is for')
    })

    /** And a measured page with nothing on it keeps it, because there it is the ask. */
    it('keeps the Colony block on a measured page with no briefing', async () => {
      await app.close()
      app = build()
      colony.recipes.measure({
        ...noFigures('bounty-board', 'bare.example'),
        attempted: 2,
        evidenced: true,
      })
      await app.ready()

      expect((await get('/atlas/bare.example')).body).toContain('What an account here is for')
    })

    /**
     * **What citizens learned once they were in** (`#1334`). `#1299` gave the
     * tips a store and an MCP route and stopped there, so a stranger reading the
     * page had no way to know they existed.
     */
    it('publishes the operate notes under a heading of their own', async () => {
      await app.close()
      app = build()
      colony.recipes.operateNote('mailbox', 'walked.example', {
        id: '00000000-0000-4000-8000-000000000001',
        tag: 'quota',
        note: 'The send quota resets at midnight UTC, not on a rolling window.',
        by: 'ada',
      })
      await app.ready()

      const body = (await get('/atlas/walked.example')).body

      expect(body).toContain('After you hold an account')
      expect(body).toContain('The send quota resets at midnight UTC')
      expect(body).toContain('quota')
      /** The author travels where the tip carries one (`#1035`'s rule). */
      expect(body).toContain('ada')
      /** Never a way-in step: the page says so where the tips are. */
      expect(body).toContain('never steps for getting one')
    })

    /**
     * **Omitted entirely when there are none.** A section saying *nobody has
     * written one of these* reports on the Colony's coverage rather than on the
     * provider, and every entry in the catalogue would carry it.
     */
    it('omits the section on a provider nobody has filed a tip for', async () => {
      const body = (await get('/atlas/unwritten.example')).body

      expect(body).not.toContain('After you hold an account')
    })

    /**
     * **The chips and their marks, on a measured earn fixture** (`#1332`). One
     * assertion over the header rather than one per chip: what the freeze asks
     * for is that status, earn and homepage are all *scannable at once*, and
     * three separate tests would each pass on a page that showed only its own.
     */
    it('marks status, earn and homepage on a provider page, with no script', async () => {
      await app.close()
      app = build()
      colony.recipes.measure({
        ...noFigures('bounty-board', 'chipped.example'),
        attempted: 3,
        evidenced: true,
        walked: {
          citizens: 2,
          gotThrough: 0,
          band: null,
          platforms: {},
          walls: [],
          homepage: 'https://chipped.example',
          anySighted: true,
          anyAbandoned: false,
        },
      })
      await app.ready()

      const body = (await get('/atlas/chipped.example')).body

      expect(body).toContain('class="k-atlas-earn"')
      expect(body).toContain('k-icon')
      expect(body).toContain('k-homepage')
      /** Never icon-only: the word is still there beside every mark. */
      expect(body).toContain('pays for finished tasks')

      /**
       * **Atlas pages run no script, and a mark must not be how one arrives.**
       * The `<script type="application/ld+json">` blocks are the exception and
       * are not one: `asJsonLdBlock` says so in as many words — CSP treats a
       * data block as data, and nothing in it executes. So the assertion is over
       * scripts that are not that, plus the inline handlers a CSP with
       * `unsafe-inline` on styles would still refuse.
       */
      const scripts = [...body.matchAll(/<script([^>]*)>/g)].map((one) => one[1] ?? '')
      expect(scripts.length).toBeGreaterThan(0)
      for (const attributes of scripts) {
        expect(attributes).toContain('type="application/ld+json"')
      }
      expect(body).not.toMatch(/\son(click|load|error)=/i)
    })

    /** A shelf somebody chose still leads, and still links to itself. */
    it('keeps the shelf on a provider that was genuinely classified', async () => {
      const facts = /<p class="k-atlas-facts">(.*?)<\/p>/s.exec(
        (await get('/atlas/walked.example')).body,
      )?.[1]

      expect(facts).toContain('/atlas/c/code-hosting')
    })
  })

  /**
   * The four absences, and which of them prints a path (`#1169`).
   *
   * A `measured` row is an entry citizens walked and nobody wrote up, and it
   * cannot carry steps: `recipeStatusAllowsSteps` refuses them in TypeScript and
   * `provider_recipes_unjoinable_is_empty` refuses them in SQL. It fell through
   * to the joinable layout all the same, so the page printed **Colony route**
   * over *0 steps, none of them an operator’s* — the reading `#588` closed on the
   * MCP side and left open on the surface a stranger meets.
   *
   * **The fixture is the four states side by side**: `walked.example` measured,
   * `unwritten.example` unattempted, `bluesky` refused, `github` joinable with
   * two steps. What is asserted is that each says its own thing and none of them
   * says another's — the empty-state half of the issue — and that only the fourth
   * renders a path.
   */
  describe('an entry with no steps, and the one with them', () => {
    /**
     * The page below `<main>`, for the reason `criteria.test.ts` gives: every
     * class the body emits also appears in the stylesheet the page inlines, so a
     * bare `toContain('k-atlas-shape')` is answered by the rule rather than by
     * the list. The assertions below match on `class="…"` for the same reason.
     */
    const main = (body: string) => body.slice(body.indexOf('<main>'))

    it('says a walked entry was walked and prints no path', async () => {
      const body = main((await get('/atlas/walked.example')).body)

      expect(body).toContain('class="k-unwritten"')
      expect(body).toContain('Citizens have walked this one, and nobody has written the route.')
      expect(body).toContain('a steward writes the route up from the walks')
      expect(body).not.toContain('Colony route')
      expect(body).not.toContain('class="k-atlas-shape"')
      expect(body).not.toContain('0 steps')
    })

    /**
     * The other side of the same fix: the layout the branch was carved out of
     * still renders for the status it was written for.
     */
    it('still prints the path on an entry that has one', async () => {
      const body = main((await get('/atlas/github')).body)

      expect(body).toContain('Colony route')
      expect(body).toContain('class="k-atlas-shape"')
      expect(body).toContain('2 steps')
      expect(body).not.toContain('nobody has written the route')
    })

    it('reads differently in each of the four states', async () => {
      const walked = main((await get('/atlas/walked.example')).body)
      const unwritten = main((await get('/atlas/unwritten.example')).body)
      const refused = main((await get('/atlas/bluesky')).body)

      expect(walked).toContain('nobody has written the route')
      expect(walked).not.toContain('Nobody has written this one up yet')
      expect(walked).not.toContain('do not try')

      expect(unwritten).toContain('Nobody has written this one up yet')
      expect(unwritten).not.toContain('nobody has written the route')
      expect(unwritten).not.toContain('do not try')

      expect(refused).toContain('This cannot be joined honestly, so do not try.')
      expect(refused).not.toContain('nobody has written the route')
    })

    /**
     * **The line that promised what the page had not got.** `citizenLine` offered
     * *the ordered steps of the path* to anybody asking `kolonie.accounts.recipes`
     * whenever an entry carried steps **or** walls, and a walled `measured` entry
     * carries the second without the first. It now names what is actually there.
     */
    it('offers the remedy and not the steps where there are no steps', async () => {
      await app.close()
      app = build()
      colony.recipes.write({
        kind: 'mailbox',
        provider: 'walled.example',
        title: 'Walled',
        status: 'measured',
        walls: [
          {
            kind: 'phone-verification',
            direction: 'inbound',
            reportedBy: 4,
            lastReportedAt: '2026-08-16T00:00:00.000Z',
          },
        ],
      })
      await app.ready()

      const body = main((await get('/atlas/walled.example')).body)

      expect(body).toContain('class="k-atlas-citizen"')
      expect(body).toContain('the remedy that got past each wall')
      expect(body).not.toContain('the ordered steps of the path')
      expect(main((await get('/atlas/github')).body)).toContain('the ordered steps of the path')
    })

    /**
     * **`#600`'s line, kept while the copy was fixed.** A walked entry may carry
     * the last walker's own account of the way through; it reaches a citizen
     * through `kolonie.accounts.recipes`, under their handle, and it is not
     * published on a public page as the Colony's.
     */
    it('publishes no walker prose on the page', async () => {
      await app.close()
      app = build()
      colony.recipes.route('mailbox', 'walked.example', {
        walkId: '00000000-0000-4000-8000-000000000001',
        route: 'I opened the signup form and it let me straight in.',
        by: 'walker',
      })
      await app.ready()

      const body = (await get('/atlas/walked.example')).body

      expect(body).not.toContain('it let me straight in')
      expect(body).not.toContain('@walker')
    })
  })

  /**
   * The index is a contents page and stopped reading like one (`#1142`).
   *
   * 166 rows over 15 shelves is 90 kB of index, and the shelf a reader wants is
   * below however many rows the shelves above it happen to hold. Two changes,
   * asserted here: **six rows per shelf on the index**, with the rest one link
   * away, and **shelves ordered by evidence and then by size** rather than by
   * whatever order the catalogue was written in.
   *
   * **The order is derived once and handed to both** the navigation and the
   * body, which is why the last test can compare them at all. They are computed
   * over different sets — `#1103` counts both halves in the navigation and the
   * body renders one — so the property is that the body's shelves are a
   * subsequence of the navigation's, not that the two lists are equal.
   */
  describe('six per shelf, and the shelves ordered by evidence', () => {
    /**
     * One shelf of the index, from its heading to the end of its list.
     *
     * **It throws rather than returning nothing**, for `rowFor`'s reason above:
     * a helper that answered the empty string would pass every count below it.
     */
    const shelfOf = (body: string, category: string) => {
      const at = body.indexOf(`<h2 id="${category}"`)
      if (at === -1) throw new Error(`no shelf for ${category}`)

      const end = body.indexOf('</ul>', at)
      if (end === -1) throw new Error(`unterminated shelf for ${category}`)

      return body.slice(at, end)
    }

    /** Entry rows only: the `All N →` card carries a class, so it is not one. */
    const rowsIn = (shelf: string) => (shelf.match(/<li>/g) ?? []).length

    const headingCount = (shelf: string) =>
      /<span class="k-atlas-count">(\d+)<\/span>/.exec(shelf)?.[1]

    /**
     * The category navigation alone.
     *
     * **Sliced rather than matched across the whole page**, because the shelf
     * headings in the body link to the same addresses — so a search over the
     * document would read the navigation's order and the body's as one list.
     */
    const navOf = (body: string) => {
      const at = body.indexOf('<nav class="k-atlas-shelves"')
      if (at === -1) throw new Error('no category navigation')

      const end = body.indexOf('</nav>', at)
      if (end === -1) throw new Error('unterminated category navigation')

      return body.slice(at, end)
    }

    /** The shelves in the order a list emits them. */
    const orderIn = (markup: string, pattern: RegExp) =>
      [...markup.matchAll(pattern)].map((match) => match[1])

    const stock = (
      one: FakeColony,
      category: string,
      count: number,
      status?: 'unwritten',
    ): void => {
      for (let n = 1; n <= count; n += 1)
        one.recipes.write({
          kind: 'mailbox',
          provider: `${category}-${n}.example`,
          title: `${category} ${n}`,
          category,
          ...(status === undefined ? {} : { status }),
        })
    }

    const rebuild = (write: (colony: FakeColony) => void) => async () => {
      await app.close()
      app = build()
      write(colony)
      await app.ready()
    }

    it('cuts a shelf of seven to six and links to the rest', async () => {
      await rebuild((one) => stock(one, 'storage', 7))()

      const shelf = shelfOf((await get('/atlas')).body, 'storage')

      expect(rowsIn(shelf)).toBe(6)
      expect(shelf).toContain('All 7 →')
      expect([...shelf.matchAll(/class="k-atlas-all"/g)]).toHaveLength(1)
    })

    /**
     * **The boundary, and the reason the link is conditional.** Six is the last
     * size that fits, so a shelf of exactly six is a shelf nothing was cut from
     * — and an `All 6 →` under it would send a reader to a page holding what
     * they are already looking at.
     */
    it('leaves a shelf of exactly six alone', async () => {
      await rebuild((one) => stock(one, 'storage', 6))()

      const shelf = shelfOf((await get('/atlas')).body, 'storage')

      expect(rowsIn(shelf)).toBe(6)
      expect(shelf).not.toContain('class="k-atlas-all"')
    })

    /** The count is the shelf's, not the slice's — otherwise the cut is invisible. */
    it('counts the whole shelf in the heading of a cut one', async () => {
      await rebuild((one) => stock(one, 'storage', 9))()

      expect(headingCount(shelfOf((await get('/atlas')).body, 'storage'))).toBe('9')
    })

    /**
     * **The page the link goes to has to be the uncut one**, or the cap has
     * merely moved. A shelf's own page is a shelf rather than a contents page,
     * so nothing is held back on it.
     */
    it('renders a shelf’s own page uncapped', async () => {
      await rebuild((one) => stock(one, 'storage', 9))()

      const body = (await get('/atlas/c/storage')).body

      /** Deduplicated: an entry is linked from its row and again from the JSON-LD. */
      const linked = new Set(
        [...body.matchAll(/\/atlas\/(storage-\d+\.example)"/g)].map((m) => m[1]),
      )

      expect(linked.size).toBe(9)
      expect(body).not.toContain('class="k-atlas-all"')
    })

    /**
     * **Evidence before size, whatever the sizes are** (`#905`'s measurement in
     * one shelf): nine entries nobody has been to are nine pages saying nobody
     * has been to them, and a shelf of two that somebody walked is worth more of
     * the reader's first screen than that.
     */
    it('sorts a shelf with no evidence after every shelf with evidence', async () => {
      await rebuild((one) => {
        stock(one, 'knowledge-docs', 9, 'unwritten')
        stock(one, 'design-media', 2)
      })()

      const nav = navOf((await get('/atlas')).body)

      expect(nav.indexOf('/atlas/c/design-media')).toBeGreaterThan(-1)
      expect(nav.indexOf('/atlas/c/design-media')).toBeLessThan(
        nav.indexOf('/atlas/c/knowledge-docs'),
      )
    })

    /**
     * The navigation counts both halves and the body renders one, so the body's
     * shelves are a subsequence of the navigation's rather than the same list.
     * A reader scanning the navigation and then scrolling must not meet the
     * shelves in a different order from the one they were just offered.
     */
    it('emits the navigation and the body in one order', async () => {
      await rebuild((one) => {
        stock(one, 'storage', 7)
        stock(one, 'design-media', 2)
        stock(one, 'knowledge-docs', 4, 'unwritten')
      })()

      const body = (await get('/atlas')).body
      const nav = orderIn(navOf(body), /<a href="\/atlas\/c\/([a-z-]+)"/g)
      const shelves = orderIn(body, /<h2 id="([a-z-]+)"/g)

      expect(shelves.length).toBeGreaterThan(1)
      expect(nav.filter((category) => shelves.includes(category))).toEqual(shelves)
    })
  })

  /**
   * A shelf longer than a page (`#1143`).
   *
   * **The counts here are the constant and not a sample of it.** Fifty is the
   * page size, so an exact multiple, one over and one well under are the three
   * shapes a slice can take — a test written against ten would pass on any page
   * size at all and would say nothing about the one shipped.
   */
  describe('a shelf that does not fit on one page', () => {
    const stock = (one: FakeColony, count: number): void => {
      for (let n = 1; n <= count; n += 1)
        one.recipes.write({
          kind: 'mailbox',
          /** Padded, so that a shelf's own order is not what this test measures. */
          provider: `box-${String(n).padStart(3, '0')}.example`,
          title: `Box ${n}`,
          category: 'mailbox',
        })
    }

    const rebuild = (count: number) => async () => {
      await app.close()
      app = build()
      stock(colony, count)
      await app.ready()
    }

    /** Entry rows: a provider link, and never a shelf or a navigation one. */
    const rowsIn = (body: string) =>
      [...body.matchAll(/<li><a href="\/atlas\/(?!c\/)([^"]+)">/g)].map((one) => one[1] ?? '')

    const shelf = (query = '') => get(`${ATLAS_PATH}/c/mailbox${query}`)

    /**
     * **The boundary that has no next page and is still full.** A hundred rows is
     * two pages exactly; an off-by-one in the count would show up here as a
     * third, empty page being linked to.
     */
    it('cuts an exact multiple of fifty into full pages and no more', async () => {
      await rebuild(100)()

      const first = await shelf()
      const second = await shelf('?page=2')

      expect(rowsIn(first.body)).toHaveLength(50)
      expect(rowsIn(second.body)).toHaveLength(50)
      expect(first.body).toContain('<span>Page 1 of 2</span>')
      expect(second.body).toContain('<span>Page 2 of 2</span>')
      /** The last page offers nothing after it, in the body or in the head. */
      expect(second.body).not.toContain('rel="next"')
      expect((await shelf('?page=3')).statusCode).toBe(404)
    })

    /** The ordinary shape: a last page holding what was left over. */
    it('leaves the remainder on a partial last page', async () => {
      await rebuild(55)()

      expect(rowsIn((await shelf()).body)).toHaveLength(50)
      expect(rowsIn((await shelf('?page=2')).body)).toHaveLength(5)
      expect((await shelf('?page=2')).body).toContain('<span>Page 2 of 2</span>')
    })

    /**
     * **Most shelves are this one**, and paging controls on a page with nowhere
     * to go are a reader being asked to look for a second page that is not there.
     */
    it('says nothing about pages on a shelf that fits', async () => {
      await rebuild(3)()

      const body = (await shelf()).body

      expect(rowsIn(body)).toHaveLength(3)
      expect(body).not.toContain('k-atlas-pages"')
      expect(body).not.toContain('rel="next"')
      expect(body).not.toContain('rel="prev"')
    })

    /**
     * **Decision 6.** The head is where a crawler is told that page two is a
     * continuation and not a near-duplicate, and the links are absolute like the
     * canonical beside them.
     */
    it('links each page to the one before and after it', async () => {
      await rebuild(120)()

      const second = (await shelf('?page=2')).body

      expect(second).toContain(`<link rel="prev" href="${SITE}${ATLAS_PATH}/c/mailbox">`)
      expect(second).toContain(`<link rel="next" href="${SITE}${ATLAS_PATH}/c/mailbox?page=3">`)
      /** And the first page has a next and no previous. */
      expect((await shelf()).body).not.toContain('rel="prev"')
    })

    /**
     * **Decision 5, and it is four addresses collapsing into one.** A malformed
     * page is a broken link or a crawler's guess at a shelf that does exist, so
     * the shelf is the answer — and the canonical drops the parameter rather
     * than minting `?page=abc` as an address of its own.
     */
    it.each(['?page=0', '?page=-1', '?page=abc', '?page=1.5', '?page=1'])(
      'answers %s with the first page, canonical to the bare shelf',
      async (query) => {
        await rebuild(60)()

        const response = await shelf(query)

        expect(response.statusCode).toBe(200)
        expect(response.body).toContain('<span>Page 1 of 2</span>')
        expect(response.body).toContain(
          `<link rel="canonical" href="${SITE}${ATLAS_PATH}/c/mailbox">`,
        )
      },
    )

    /**
     * **Decision 4, and deliberately unlike an unknown category**, which falls
     * back to the index. A slug is a name and a wrong one is worth answering
     * with the catalogue; a page number past the end is a well-formed request
     * for rows that do not exist.
     */
    it('answers a page past the last with a 404', async () => {
      await rebuild(60)()

      expect((await shelf('?page=2')).statusCode).toBe(200)
      expect((await shelf('?page=3')).statusCode).toBe(404)
    })

    /**
     * **The two filters compose** (`#1103` and this one). A reader who chose
     * *what nobody got through* and turned a page has not asked to be put back on
     * the other half, so the paging links carry the view.
     */
    it('keeps the worked filter across a page turn', async () => {
      await rebuild(0)()
      for (let n = 1; n <= 60; n += 1)
        colony.recipes.write({
          kind: 'mailbox',
          provider: `shut-${String(n).padStart(3, '0')}.example`,
          title: `Shut ${n}`,
          category: 'mailbox',
          status: 'refused',
        })

      const first = (await shelf('?worked=false')).body

      expect(rowsIn(first)).toHaveLength(50)
      expect(first).toContain(`href="${ATLAS_PATH}/c/mailbox?worked=false&amp;page=2"`)
      expect(rowsIn((await shelf('?worked=false&page=2')).body)).toHaveLength(10)
    })

    /**
     * **Decision 7.** A sitemap naming page two says a shelf's rows live at two
     * addresses; page one is the shelf, and the pages behind it are reached by
     * the `rel="next"` chain a crawler follows on its own.
     */
    it('puts no page beyond the first in the sitemap', async () => {
      await rebuild(120)()

      const sitemap = (await get('/atlas/sitemap.xml')).body

      expect(sitemap).toContain(`${SITE}${ATLAS_PATH}/c/mailbox<`)
      expect(sitemap).not.toContain('page=')
    })
  })

  /**
   * What a provider page says (`#547`), and the refusal underneath it: one page
   * per provider, never one per provider × runtime.
   */
  describe('what a provider page carries', () => {
    const rebuild = (write: (colony: FakeColony) => void) => async () => {
      await app.close()
      app = build()
      write(colony)
      await app.ready()
    }

    it('says what the provider is and why an agent would want one', async () => {
      await rebuild((one) =>
        one.recipes.write({
          kind: 'trello',
          provider: 'trello.com',
          title: 'Trello',
          about: 'A board an agent can keep its own work on.',
        }),
      )()

      expect((await get('/atlas/trello.com')).body).toContain(
        'A board an agent can keep its own work on.',
      )
    })

    /**
     * 200 providers × 7 runtimes is 1400 thin doorway pages, which
     * `growth/README.md` forbids. The honest version names the runtimes on the
     * one page and gives their real differences.
     */
    it('names runtime differences on the provider’s own page', async () => {
      await rebuild((one) =>
        one.recipes.write({
          kind: 'github',
          provider: 'github.com',
          runtimes: [{ runtime: 'hermes', note: 'Hermes holds the token in its own vault.' }],
        }),
      )()

      const body = (await get('/atlas/github.com')).body

      expect(body).toContain('Where runtimes differ')
      expect(body).toContain('Hermes holds the token in its own vault.')
    })

    it('renders no runtime section where nothing genuinely differs', async () => {
      expect((await get('/atlas/github')).body).not.toContain('Where runtimes differ')
    })

    /**
     * The structural half of the refusal: there is no route that could serve a
     * combination page, so nothing can generate one.
     */
    it('has no route for a provider-and-runtime combination', async () => {
      expect((await get('/atlas/github/hermes')).statusCode).toBe(404)
    })

    /** An empty page for every conceivable service is the doorway pattern by another route. */
    it('has no page for a provider with no entry', async () => {
      expect((await get('/atlas/notion.so')).statusCode).toBe(404)
    })

    /**
     * `#543` rule 3: the marker is on the page, not in a footnote. A disclosure
     * a reader reaches after deciding is not a disclosure.
     */
    it('states plainly when an entry is paid for, and what that does not buy', async () => {
      await rebuild((one) =>
        one.recipes.write({ kind: 'mailbox', provider: 'sponsored.test', paid: true }),
      )()

      const body = (await get('/atlas/sponsored.test')).body

      expect(body).toContain('This entry is paid for.')
      expect(body).toContain('not its position in the index')
    })

    it('marks a paid entry on the index too', async () => {
      await rebuild((one) =>
        one.recipes.write({ kind: 'mailbox', provider: 'sponsored.test', paid: true }),
      )()

      expect((await get('/atlas')).body).toContain('paid')
    })

    /**
     * Paying buys the entry and nothing else. This is the property that makes
     * that structural: `atlasRank` is not given the field, so no edit can weight
     * it without adding an argument somebody reviews.
     */
    it('does not move a paid entry up the index', async () => {
      await rebuild((one) => {
        one.recipes.write({ kind: 'mailbox', provider: 'sponsored.test', paid: true })
        one.recipes.measure({ ...noFigures('mailbox', 'sponsored.test'), attempted: 20, proved: 1 })
        one.recipes.measure({ ...noFigures('github', 'github'), attempted: 20, proved: 18 })
      })()

      const body = (await get('/atlas')).body

      expect(body.indexOf('/atlas/github')).toBeLessThan(body.indexOf('/atlas/sponsored.test'))
    })

    it('names how to reach whoever runs the service, and what they cannot do', async () => {
      await rebuild((one) =>
        one.recipes.write({
          kind: 'mailbox',
          provider: 'claimed.test',
          contact: 'jo@claimed.test',
        }),
      )()

      const body = (await get('/atlas/claimed.test')).body

      expect(body).toContain('jo@claimed.test')
      expect(body).toContain('propose a correction and cannot apply one')
      expect(body).toContain('not that provider’s to remove')
    })

    /** An affiliate link a reader follows without being told what it is. */
    it('discloses a referral link on the page that uses it', async () => {
      await rebuild((one) =>
        one.recipes.write({
          kind: 'mailbox',
          provider: 'referred.test',
          referral: {
            url: 'https://referred.test/r/kolonie',
            termsNote: 'Terms read 2026-08-08; agent signups are not excluded.',
            checkedBy: 'the maintainer',
            checkedAt: '2026-08-08T00:00:00.000Z',
          },
        }),
      )()

      expect((await get('/atlas/referred.test')).body).toContain('is a referral link')
    })

    /** A recipe describes a path that worked. The provider decides, and can change. */
    it('never claims a provider will accept an agent', async () => {
      expect((await get('/atlas/github')).body).toContain('not a promise')
    })
  })

  /**
   * **What an account at this provider is then good for**
   * (`kolonie-website#116`).
   *
   * Everything else on an entry page is about getting the account and how badly
   * that goes. This module is the only thing on the Atlas that answers the
   * question a reader deciding whether to spend the afternoon actually has, and
   * the two assertions that matter are that it appears where a playbook named
   * the provider and nowhere else.
   */
  describe('what an account here is used for', () => {
    /** The module itself, so an assertion about it cannot pass on the rest of the page. */
    const HEADING = 'Playbooks that use this provider'

    /**
     * A reader over a fixed table, provider-exact — which is the rule the
     * storage query implements and the one the acceptance criteria turn on. A
     * fake that answered the same list for every provider would make the
     * no-spam assertion below unfalsifiable.
     */
    const playbooksNaming = (
      by: Readonly<Record<string, readonly { slug: string; title: string; summary: string }[]>>,
    ): AtlasPlaybookReader => ({
      naming: async ({ provider }) => by[provider] ?? [],
    })

    const withPlaybooks = async (reader: AtlasPlaybookReader) => {
      await app.close()
      app = build(SITE, reader)
      await app.ready()
    }

    it('names the playbooks that need an account here, and links to each one', async () => {
      await withPlaybooks(
        playbooksNaming({
          github: [
            {
              slug: 'github-contribution-loop',
              title: 'A contribution loop on GitHub',
              summary: 'Open a pull request a maintainer merges, once a week.',
            },
          ],
        }),
      )

      const body = (await get('/atlas/github')).body

      expect(body).toContain(HEADING)
      expect(body).toContain('A contribution loop on GitHub')
      expect(body).toContain('href="/playbooks/github-contribution-loop"')
      expect(body).toContain('Open a pull request a maintainer merges, once a week.')
    })

    /**
     * **The acceptance criterion the matching rule exists for.** A playbook
     * needing *a mailbox* names no mailbox provider, so the module must not turn
     * up on all of them — the reader is asked per provider and answers for one.
     */
    it('leaves the module off a provider no playbook named', async () => {
      await withPlaybooks(
        playbooksNaming({
          github: [
            {
              slug: 'github-contribution-loop',
              title: 'A contribution loop on GitHub',
              summary: 'Open a pull request a maintainer merges, once a week.',
            },
          ],
        }),
      )

      const body = (await get('/atlas/bluesky')).body

      expect(body).not.toContain(HEADING)
      expect(body).not.toContain('/playbooks/github-contribution-loop')
    })

    /**
     * Absent rather than empty: a provider nothing has named yet is the ordinary
     * state of most of the catalogue, and a heading over an empty list on four
     * hundred pages would say the Colony had looked and found nothing.
     */
    it('renders no heading for a provider the reader answers empty for', async () => {
      await withPlaybooks(playbooksNaming({}))

      expect((await get('/atlas/github')).body).not.toContain(HEADING)
    })

    /** Optional at every layer: a deployment with no playbooks renders what it did before. */
    it('renders the page it rendered before playbooks existed when none is wired', async () => {
      expect((await get('/atlas/github')).statusCode).toBe(200)
      expect((await get('/atlas/github')).body).not.toContain(HEADING)
    })

    /** No other Atlas surface names a playbook, so none of them pays for the read. */
    it('names no playbook on the index or in the catalogue', async () => {
      await withPlaybooks(
        playbooksNaming({
          github: [
            {
              slug: 'github-contribution-loop',
              title: 'A contribution loop on GitHub',
              summary: 'Open a pull request a maintainer merges, once a week.',
            },
          ],
        }),
      )

      expect((await get('/atlas')).body).not.toContain(HEADING)
      expect((await get('/atlas/catalogue.json')).body).not.toContain('github-contribution-loop')
    })
  })

  /**
   * **Where a reader goes from the bottom of a provider page**
   * (`kolonie-website#113`).
   *
   * The page under test is the one the issue names: a wall list with nothing
   * under it. What the module owes a reader is the shelf, the two or three
   * providers they would look at next, the rung that proves an account like this
   * one, and the index — as links, because D-062 leaves nothing else available.
   */
  describe('where a reader goes from a provider page', () => {
    /** The module itself, so an assertion about it cannot pass on the rest of the page. */
    const nextSteps = (body: string) => {
      const found = /<nav class="k-atlas-next"[\s\S]*?<\/nav>/.exec(body)?.[0]

      if (found === undefined) throw new Error('the page carries no next-steps module')

      return found
    }

    /** The providers it links to, in the order it printed them, shelves excluded. */
    const neighbours = (block: string): readonly string[] =>
      [...block.matchAll(/href="\/atlas\/(?!c\/)([^"]+)"/g)].map((one) => one[1] ?? '')

    /**
     * One shelf with more providers on it than a module carries, so the slice
     * has something to leave out — and the outcomes spread far enough apart that
     * `atlasByOutcome`'s order is the only order these assertions can pass in.
     */
    const shelf = async () => {
      await app.close()
      app = build()
      for (const provider of ['here.example', 'plain.example']) {
        colony.recipes.write({
          kind: 'phone',
          provider,
          title: provider,
          category: 'telephony',
          status: 'measured',
        })
      }
      colony.recipes.write({
        kind: 'phone',
        provider: 'best.example',
        title: 'Best',
        category: 'telephony',
      })
      colony.recipes.measure({
        ...noFigures('phone', 'best.example'),
        attempted: 20,
        proved: 15,
        evidenced: true,
      })
      colony.recipes.write({
        kind: 'phone',
        provider: 'mid.example',
        title: 'Mid',
        category: 'telephony',
      })
      colony.recipes.measure({
        ...noFigures('phone', 'mid.example'),
        attempted: 8,
        proved: 3,
        evidenced: true,
      })
      colony.recipes.write({
        kind: 'phone',
        provider: 'wall.example',
        title: 'Wall',
        category: 'telephony',
        status: 'refused',
        refusal: 'Signup demands a document no citizen holds.',
      })
      await app.ready()
    }

    it('ends a provider page with its shelf and the whole index', async () => {
      await shelf()

      const block = nextSteps((await get('/atlas/here.example')).body)

      expect(block).toContain('<h2>Where to go from here</h2>')
      expect(block).toContain(`href="${ATLAS_PATH}/c/telephony">Every telephony provider`)
      expect(block).toContain(`href="${ATLAS_PATH}">The whole Atlas`)
    })

    /**
     * **The catalogue's own order, sliced and never re-sorted** — rule 2 of
     * `#543` reaching the last block on the page. `best` got three-quarters of
     * its walkers through and `mid` under half; `plain` was walked with nothing
     * measured; `wall` is the row the slice drops.
     */
    it('names the providers next to it in the catalogue’s order', async () => {
      await shelf()

      const block = nextSteps((await get('/atlas/here.example')).body)

      expect(neighbours(block)).toEqual(['best.example', 'mid.example', 'plain.example'])
      /** Never the page's own provider, which is the one row the reader has. */
      expect(neighbours(block)).not.toContain('here.example')
      /** And it says where the three came from, rather than looking curated. */
      expect(block).toContain('measured outcome, never who paid')
    })

    /** A neighbour carries its verdict, so a reader is not sent to a second wall blind. */
    it('marks what a neighbour is before a reader clicks it', async () => {
      await shelf()

      const block = nextSteps((await get('/atlas/mid.example')).body)

      expect(block).toContain('walked, with no route written')
    })

    /** Nothing from another shelf, which would be a second opinion about where a provider lives. */
    it('never reaches across shelves for a neighbour', async () => {
      await shelf()

      expect(neighbours(nextSteps((await get('/atlas/here.example')).body))).not.toContain('github')
    })

    /**
     * **The page the issue was written about.** A refusal keeps the way out —
     * three providers on the same shelf is navigation, not an offer — and `#543`
     * still takes everything that is one, which on this page is every invitation.
     */
    it('lets a reader out of a wall page without offering it to them', async () => {
      await shelf()

      const body = (await get('/atlas/wall.example')).body

      expect(neighbours(nextSteps(body))).toContain('best.example')
      expect(body).not.toContain('class="k-atlas-cta"')
    })

    /**
     * **The register-and-join half of criterion (a), counted rather than
     * assumed.** `#111` put it on every page that is not a refusal, so the module
     * adds none of its own: the failure worth a test is the third copy, one screen
     * under the second.
     */
    it('leaves the one invitation the page already has where it is', async () => {
      await shelf()

      const body = (await get('/atlas/here.example')).body

      expect([...body.matchAll(/class="k-atlas-cta"/g)]).toHaveLength(1)
      expect(body).toContain('kolonie.register')
      expect(body).toContain('href="/skill/">Join the Colony')
      expect(nextSteps(body)).not.toContain('kolonie.register')
    })

    /**
     * **The rung is a link and was three words** (`kolonie-website#113`). Only
     * where a row actually proves one: a provider curated with no task behind it
     * gets no link, because there is nowhere for it to go.
     */
    it('links the Academy rung an entry proves, and only where there is one', async () => {
      await app.close()
      app = build()
      colony.recipes.write({
        kind: 'github',
        provider: 'proves.example',
        title: 'Proves',
        proves: 'rung',
        provesTask: 'github-account',
      })
      await app.ready()

      expect(nextSteps((await get('/atlas/proves.example')).body)).toContain(
        'href="/academy/#github-account"',
      )
      /** `github` in the fixture proves a rung and names no task, so it links none. */
      expect(nextSteps((await get('/atlas/github')).body)).not.toContain('/academy/#')
    })

    /**
     * Criterion (b), which the shelf pages already satisfied before this issue:
     * the index and the neighbouring shelves are on a category page, from
     * `#1102`'s nav and `#546`'s facts line. Asserted rather than rebuilt, so a
     * later edit cannot take it away without a red test.
     */
    it('already links the index and the adjacent shelves from a shelf', async () => {
      const body = (await get(`${ATLAS_PATH}/c/mailbox`)).body

      expect(body).toContain(`<a href="${ATLAS_PATH}">Every category</a>`)
      expect(body).toContain(`href="${ATLAS_PATH}/c/identity-security"`)
    })

    /** Links and lists, exactly as everywhere else under the prefix (D-062). */
    it('needs no JavaScript', async () => {
      await shelf()

      const block = nextSteps((await get('/atlas/here.example')).body)

      expect(block).not.toContain('<script')
      expect(block).not.toContain('onclick')
    })
  })

  describe('caching, because this is the first public traffic the API takes', () => {
    it('lets the edge and the browser cache a page', async () => {
      const cacheControl = (await get('/atlas')).headers['cache-control']

      expect(cacheControl).toContain('public')
      expect(cacheControl).toContain('s-maxage=')
    })

    it('never sends the console’s no-store', async () => {
      expect((await get('/atlas/github')).headers['cache-control']).not.toContain('no-store')
    })
  })

  describe('the sitemap', () => {
    /**
     * The one thing a dynamic surface needs that a static build gets free.
     * Without it a crawler finds only what happens to be linked.
     */
    it('lists every entry with an absolute URL', async () => {
      const response = await get('/atlas/sitemap.xml')

      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toContain('xml')
      expect(response.body).toContain(`<loc>${SITE}/atlas/github</loc>`)
      expect(response.body).toContain(`<loc>${SITE}/atlas/bluesky</loc>`)
    })

    it('is not read as a provider called sitemap.xml', async () => {
      expect((await get('/atlas/sitemap.xml')).body).toContain('<urlset')
    })
  })

  /**
   * The catalogue as data (`#551`). The Atlas is only worth trusting if it can
   * be checked, and one readable only through our own pages cannot be.
   */
  describe('the catalogue as data', () => {
    const document = async () => JSON.parse((await get('/atlas/catalogue.json')).body)

    it('answers a reader with no credential at all', async () => {
      const response = await get('/atlas/catalogue.json')

      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toContain('application/json')
    })

    it('carries the recipes, whether they can be joined, and the figures', async () => {
      await app.close()
      app = build()
      colony.recipes.measure({ ...noFigures('github', 'github'), attempted: 30, proved: 12 })
      await app.ready()

      const body = await document()
      const github = body.entries.find((one: { provider: string }) => one.provider === 'github')
      const bluesky = body.entries.find((one: { provider: string }) => one.provider === 'bluesky')

      expect(github.recipes[0].steps).toHaveLength(2)
      expect(github.recipes[0].figures.attempted).toBe(30)
      expect(bluesky.status).toBe('refused')
      expect(bluesky.recipes[0].refusal).toContain('phone number')
    })

    /**
     * A consumer that stored the body has thrown the header away, and it is
     * exactly the one at risk of serving a year-old catalogue as fact.
     */
    it('dates itself in the body as well as in the header', async () => {
      const body = await document()

      expect(typeof body.generatedAt).toBe('string')
      expect(body.maxAgeSeconds).toBeGreaterThan(0)
    })

    it('is cacheable on the same terms as the pages', async () => {
      expect((await get('/atlas/catalogue.json')).headers['cache-control']).toContain('public')
    })

    it('is not read as a provider called catalogue.json', async () => {
      expect((await document()).entries).toBeDefined()
    })
  })

  describe('a renamed entry', () => {
    it('redirects permanently from the path it used to be at', async () => {
      await colony.renames.rename('twitter', 'x')

      const response = await get('/atlas/twitter')

      expect(response.statusCode).toBe(301)
      expect(response.headers['location']).toBe('/atlas/x')
    })

    /**
     * **A redirect that redirects is two round trips per page.** Renaming twice
     * has to leave the first name pointing at the last, not at the middle one.
     */
    it('points an older name at the current one and not at the middle hop', async () => {
      await colony.renames.rename('twitter', 'x')
      await colony.renames.rename('x', 'xcom')

      expect((await get('/atlas/twitter')).headers['location']).toBe('/atlas/xcom')
    })
  })

  /**
   * **The document outline is prose, not the identifiers it was keyed on**
   * (`#791`). Measured before the fix, `/atlas/trello.com` read `h2 trello`,
   * `h3 And this is how you get a api`, and the index was headed with fifteen
   * enum values — which is what a crawler reads as the structure of the
   * directory.
   */
  describe('the headings a reader and a crawler see', () => {
    const rebuild = (write: (colony: FakeColony) => void) => async () => {
      await app.close()
      app = build()
      write(colony)
      await app.ready()
    }

    /** A kind in the map, and the capability beside it. */
    it('heads a row with a noun phrase and gives the capability its article', async () => {
      await rebuild((one) =>
        one.recipes.write({
          kind: 'mailbox',
          provider: 'post.example',
          title: 'Post',
          steps: [{ actor: 'agent', instruction: 'Open the signup form.' }],
          reaches: {
            capability: AccountCapabilitySchema.parse('api'),
            steps: [{ actor: 'agent', instruction: 'Open the API settings.' }],
          },
        }),
      )()

      const body = (await get('/atlas/post.example')).body

      expect(body).toContain('<h2>A mailbox</h2>')
      /**
       * The capability keeps its article where it is now named — in the line
       * saying how much further it is, which replaced its own section of steps
       * (`#1100`).
       */
      expect(body).toContain('an API key is 1 step further, and optional.')
      expect(body).not.toContain('you get a api')
    })

    /** The kind is the provider, so the row says where rather than what twice. */
    it('heads a provider-named row with the provider', async () => {
      await rebuild((one) =>
        one.recipes.write({ kind: 'trello', provider: 'trello.com', title: 'Trello' }),
      )()

      expect((await get('/atlas/trello.com')).body).toContain('<h2>An account at trello.com</h2>')
    })

    /**
     * **A kind in neither map renders as itself.** `AccountKindSchema` is an
     * open vocabulary, so a curator can file a kind this map has never heard
     * of; the page that results has to be plain rather than absent.
     */
    it('renders an unmapped kind as its own slug and throws nothing', async () => {
      await rebuild((one) =>
        one.recipes.write({ kind: 'weather-feed', provider: 'weather.example', title: 'Weather' }),
      )()

      const response = await get('/atlas/weather.example')

      expect(response.statusCode).toBe(200)
      expect(response.body).toContain('<h2>weather-feed</h2>')
    })

    /**
     * On the view the social shelf is on (`#1103`) — its one row is a refusal,
     * so the shelf heading renders where the refusals do. The shelf link is
     * asserted as a prefix and so still matches the nav link that now carries
     * the view with it.
     */
    it('heads a shelf with its title and keeps the slug where it is an address', async () => {
      const body = (await get('/atlas?worked=false')).body

      expect(body).toContain('Social and publishing')
      expect(body).toContain('id="social-publishing"')
      expect(body).toContain(`${ATLAS_PATH}/c/social-publishing`)
    })

    it('says the kinds on a row in words', async () => {
      expect((await get('/atlas?worked=false')).body).toContain('a social account')
    })

    /**
     * **One phrase, once** (`#1144`). `codeberg.org` carried two rows for one
     * account kind under two spellings, and the row read *a code-hosting
     * account, a code-hosting account* — the second half saying nothing the
     * first did not. The reconciliation closes the collisions in the data; this
     * is the render side of the same rule, and it is what holds for a pair the
     * alias table has not been told about and for a page served from a replica
     * that has not caught up.
     */
    it('names a kind once on a row that carries it twice', async () => {
      await rebuild((one) => {
        for (const title of ['Twice', 'Twice again'])
          one.recipes.write({
            kind: 'mailbox',
            provider: 'twice.example',
            title,
            category: 'mailbox',
          })
      })()

      const row = [...(await get('/atlas')).body.matchAll(/<li>.*?<\/li>/gs)]
        .map((match) => match[0])
        .find((one) => one.includes('/atlas/twice.example"'))

      if (row === undefined) throw new Error('no index row for twice.example')
      expect(row.match(/a mailbox/g)).toHaveLength(1)
    })

    /**
     * The property behind all of the above, asserted on the shape rather than
     * on any one string: **no heading on either page is exactly an
     * identifier.** A slug added to the vocabulary and not to a map fails this
     * on the page it reaches, rather than four days later in a search result.
     */
    it('leaves no heading on either page that is exactly a slug', async () => {
      for (const url of ['/atlas', '/atlas/github', '/atlas/bluesky']) {
        const body = (await get(url)).body
        const headings = [...body.matchAll(/<h[123][^>]*>(.*?)<\/h[123]>/g)].map((one) =>
          (one[1] ?? '').replace(/<[^>]*>/g, '').trim(),
        )

        expect(headings.length, `${url} has no headings to check`).toBeGreaterThan(0)
        for (const heading of headings) {
          expect(
            /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(heading),
            `${url} heads a section with the identifier ${heading}`,
          ).toBe(false)
        }
      }
    })
  })

  /**
   * What a search result shows (`#788`).
   *
   * These two lines are the whole of the page for everybody who has not
   * arrived yet, and they were written for the catalogue: the title carried
   * *with no rung behind it*, a distinction that means something inside the
   * Colony and nothing to a searcher, and the description was
   * `How an agent joins ${provider}: ${kind slugs}` — which on every entry
   * whose kind repeats its provider name, most of them, printed the provider
   * twice and stopped.
   */
  describe('the title and the description a search result shows', () => {
    const rebuild = (write: (colony: FakeColony) => void) => async () => {
      await app.close()
      app = build()
      write(colony)
      await app.ready()
    }

    const headOf = (body: string) => body.slice(0, body.indexOf('</head>'))

    const descriptionOf = (body: string) =>
      /<meta name="description" content="([^"]*)"/.exec(headOf(body))?.[1] ?? ''

    /**
     * The degenerate case the issue is named for: one row, whose kind slug is
     * the provider's own name.
     */
    it('describes an entry by what joining it takes, not by its kind slug', async () => {
      await rebuild((one) =>
        one.recipes.write({
          kind: 'trello',
          provider: 'trello.com',
          title: 'Trello',
          steps: [
            { actor: 'agent', instruction: 'Open the signup form.' },
            { actor: 'agent', instruction: 'Confirm the address.' },
          ],
          proves: 'provider-post',
        }),
      )()

      const description = descriptionOf((await get('/atlas/trello.com')).body)

      expect(description).toContain('2 steps')
      expect(description).toContain('an agent can do this alone')
      expect(description).toContain('proved by publishing')
      expect(description).not.toContain('joins trello.com: trello')
    })

    /** The count where a human is genuinely needed, from the steps themselves. */
    it('says how many steps need a person when any of them do', async () => {
      expect(descriptionOf((await get('/atlas/github')).body)).toContain('1 of them needs a human')
    })

    it('dates the description where anybody has walked it, and not otherwise', async () => {
      expect(descriptionOf((await get('/atlas/github')).body)).toMatch(
        /Last confirmed \d{4}-\d{2}-\d{2}\.$/,
      )

      await rebuild((one) =>
        one.recipes.write({
          kind: 'mailbox',
          provider: 'unwalked.example',
          title: 'Unwalked',
          lastConfirmedAt: null,
          steps: [{ actor: 'agent', instruction: 'Open the signup form.' }],
        }),
      )()

      expect(descriptionOf((await get('/atlas/unwalked.example')).body)).not.toContain(
        'Last confirmed',
      )
    })

    /**
     * `#1267`. The mint-time refusal already names `provider-mail`; the Atlas
     * page is what is read before a post is burned. A provider measured refusing
     * the Colony's reader has to carry that measurement on the prove line, and
     * a provider nobody measured must not invent one.
     */
    it('names the mail route on a provider measured refusing a post proof', async () => {
      await rebuild((one) =>
        one.recipes.write({
          kind: 'social',
          provider: 'reddit.com',
          title: 'Reddit',
          category: 'social-publishing',
          steps: [{ actor: 'agent', instruction: 'Register under a handle of your own.' }],
          proves: 'provider-post',
        }),
      )()

      const body = (await get('/atlas/reddit.com')).body

      expect(body).toContain('kolonie.accounts.prove, method provider-post')
      expect(body).toContain('cannot close')
      expect(body).toContain('2026-08-17')
      expect(body).toContain('provider-mail')
    })

    it('leaves an unmeasured provider without a post-proof refusal note', async () => {
      await rebuild((one) =>
        one.recipes.write({
          kind: 'trello',
          provider: 'trello.com',
          title: 'Trello',
          steps: [{ actor: 'agent', instruction: 'Open the signup form.' }],
          proves: 'provider-post',
        }),
      )()

      const body = (await get('/atlas/trello.com')).body

      expect(body).toContain('kolonie.accounts.prove, method provider-post')
      expect(body).not.toContain('cannot close')
    })

    /** A refusal and an unwalked entry are different sentences, and neither is the joinable one. */
    it('describes a refusal and an unwritten entry as what they each are', async () => {
      expect(descriptionOf((await get('/atlas/bluesky')).body)).toContain(
        'cannot currently be joined honestly',
      )
      expect(descriptionOf((await get('/atlas/withdrawn.example')).body)).toContain(
        'was joinable and is not any more',
      )

      await rebuild((one) =>
        one.recipes.write({
          kind: 'mailbox',
          provider: 'nobody.example',
          title: 'Nobody',
          status: 'unwritten',
        }),
      )()

      expect(descriptionOf((await get('/atlas/nobody.example')).body)).toContain(
        'Nobody has walked nobody.example yet',
      )
    })

    /**
     * The property behind the above, on the shape rather than on a string: **no
     * description is a kind slug, or a list of them.** That is what the old one
     * ended in, and a kind added to the vocabulary cannot bring it back.
     */
    it('leaves no description that is a slug or a list of slugs', async () => {
      for (const url of ['/atlas', '/atlas/github', '/atlas/bluesky', '/atlas/withdrawn.example']) {
        const description = descriptionOf((await get(url)).body)

        expect(description.length, `${url} has no description`).toBeGreaterThan(0)
        expect(
          /^[a-z0-9-]+(?:,\s*[a-z0-9-]+)*\.?$/.test(description),
          `${url} is described as the identifiers ${description}`,
        ).toBe(false)
      }
    })

    it('names the provider and what the reader gets, in the title', async () => {
      await rebuild((one) =>
        one.recipes.write({
          kind: 'mailbox',
          provider: 'post.example',
          title: 'Post',
          steps: [{ actor: 'agent', instruction: 'Open the signup form.' }],
          reaches: {
            capability: AccountCapabilitySchema.parse('api'),
            steps: [{ actor: 'agent', instruction: 'Open the API settings.' }],
          },
        }),
      )()

      expect(headOf((await get('/atlas/post.example')).body)).toContain(
        '<title>post.example for an AI agent: sign up, prove it, an API key — Kolonie</title>',
      )
    })

    it('titles a refusal and a withdrawal as what they are', async () => {
      expect(headOf((await get('/atlas/bluesky')).body)).toContain(
        '<title>bluesky: why an agent cannot join it — Kolonie</title>',
      )
      expect(headOf((await get('/atlas/withdrawn.example')).body)).toContain(
        '<title>withdrawn.example: withdrawn, and what the path was — Kolonie</title>',
      )
    })

    /**
     * **`#1105` decision 3 supersedes `#788` for the heading and only for it.**
     * `#788` wrote both lines here and made the heading the curator's name on the
     * argument that a reader who has arrived is looking at the page rather than at
     * a search result. `#1105` measured what that reader arrived *with*: their own
     * question, typed. So the heading is now that question and the `<title>` is
     * still `#788`'s search line — the two are written for different people, which
     * was the right observation, and the heading was answering neither.
     */
    it('asks the reader’s question in the h1 and leaves the title the search line', async () => {
      const body = (await get('/atlas/github')).body

      expect(body).toContain('<h1>How can an AI agent create')
      /**
       * **The domain, and the `<title>` beside it is where that came from**
       * (`kolonie-website#112`). The heading interpolated the row's title until
       * `#1146` made that a phrase saying *what the account is*, after which the
       * two noun phrases either side of *at* could not both be read.
       */
      expect(body).toContain('at github?</h1>')
      expect(body).not.toContain('<h1>GitHub</h1>')
      expect(headOf(body)).toContain('<title>github for an AI agent')
    })

    it('titles a shelf for the search that finds it rather than for the filter', async () => {
      expect(headOf((await get(`${ATLAS_PATH}/c/mailbox`)).body)).toContain(
        '<title>Mailboxes an AI agent can sign up for — Kolonie</title>',
      )
      expect(headOf((await get(ATLAS_PATH)).body)).toContain('<title>The Atlas — Kolonie</title>')
    })
  })

  /**
   * The sentence saying what the provider **is** (`#1121`, written by `#1120`).
   *
   * Everything the page said until here was about behaviour: how many steps,
   * whether a human is needed, what proves it, when anybody last got through.
   * A stranger who searched for a mailbox and found one of these pages learned
   * that it takes two steps and nothing at all about what it is.
   *
   * The rejection cases are the other half of it. A provider whose corpus
   * produced nothing is the **ordinary** state, not an error, so it has to
   * render as today's page rather than as today's page with a gap in it — which
   * is why the undescribed head is asserted against the described one rather
   * than against a sentence typed into this file.
   */
  describe('the description the Colony wrote about a provider', () => {
    const SAID = 'A hosted mailbox that answers on IMAP and asks for no phone number.'

    const rebuild = (write: (colony: FakeColony) => void) => async () => {
      await app.close()
      app = build()
      write(colony)
      await app.ready()
    }

    const headOf = (body: string) => body.slice(0, body.indexOf('</head>'))

    const descriptionOf = (body: string) =>
      /<meta name="description" content="([^"]*)"/.exec(headOf(body))?.[1] ?? ''

    /** The `ld+json` blocks of a page, parsed — what a crawler actually reads. */
    const blocksOf = (body: string) =>
      [...body.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)].map((one) =>
        JSON.parse(one[1] ?? '{}'),
      )

    /**
     * One entry, written twice with the same everything but the sentence, which
     * is what makes the fallback assertable: the undescribed render *is* the
     * reference, so a stray space or an empty prefix fails rather than passing
     * against a string somebody typed here.
     */
    type Seeded = Parameters<FakeColony['recipes']['write']>[0]

    const said = (description: string | null, rest: Partial<Seeded> = {}) =>
      rebuild((one) =>
        one.recipes.write({
          kind: 'mailbox',
          provider: 'said.example',
          title: 'Said',
          description,
          steps: [{ actor: 'agent', instruction: 'Open the signup form.' }],
          proves: 'provider-mail',
          ...rest,
        }),
      )

    const metaFor = async (description: string | null, rest: Partial<Seeded> = {}) => {
      await said(description, rest)()

      return descriptionOf((await get('/atlas/said.example')).body)
    }

    it('leads the head with the description and keeps the status sentence behind it', async () => {
      const described = await metaFor(SAID)
      const behaved = await metaFor(null)

      expect(described).toBe(`${SAID} ${behaved}`)
      expect(described.length).toBeLessThanOrEqual(ATLAS_META_DESCRIPTION_MAX_LENGTH)
    })

    /** Decisions 4 and 4 again: under the heading, and for a status that renders no rows. */
    it('shows it as a paragraph under the heading, joinable or refused', async () => {
      for (const status of ['joinable', 'refused'] as const) {
        await said(SAID, { status })()
        const body = (await get('/atlas/said.example')).body

        /**
         * The element and not the class name: the sheet is inlined in the head,
         * so every one of these selectors appears on the page whether or not
         * anything is rendered with it.
         */
        const paragraph = body.indexOf('<p class="k-atlas-description">')

        expect(body, status).toContain(`<p class="k-atlas-description">${SAID}</p>`)
        expect(paragraph, status).toBeGreaterThan(body.indexOf('</h1>'))
        expect(paragraph, status).toBeLessThan(body.indexOf('<p class="k-atlas-facts">'))
      }
    })

    /**
     * Decision 9: `recipeSection()` returns early for both of these, and the
     * paragraph is rendered above it rather than inside it. These are the pages
     * with the least on them and the most need of a line saying what the thing is.
     */
    it('shows the paragraph on a retired entry and on one nobody has walked', async () => {
      for (const status of ['retired', 'unwritten'] as const) {
        await said(SAID, { status })()

        expect((await get('/atlas/said.example')).body, status).toContain(
          `<p class="k-atlas-description">${SAID}</p>`,
        )
      }
    })

    it('carries it in the structured data the page emits', async () => {
      await said(SAID)()
      const crumbs = blocksOf((await get('/atlas/said.example')).body).find(
        (one) => one['@type'] === 'BreadcrumbList',
      )

      expect(crumbs?.itemListElement.at(-1)).toMatchObject({ name: 'Said', description: SAID })
    })

    /**
     * Decisions 6 and 7: one line per described provider, on the index and on the
     * shelf.
     *
     * **Both rows are written with an explicit category**, as the split's own
     * fixture is: what is under test is the line, and a row that reached the shelf
     * only because the kind-to-category map happened to choose it would fail the
     * day that map moves, naming this issue for a change that has nothing to do
     * with it.
     */
    it('gives a described provider one line on the index and an undescribed one none', async () => {
      await rebuild((one) => {
        one.recipes.write({
          kind: 'mailbox',
          provider: 'said.example',
          title: 'Said',
          category: 'mailbox',
          description: SAID,
          steps: [{ actor: 'agent', instruction: 'Open the signup form.' }],
        })
        one.recipes.write({
          kind: 'mailbox',
          provider: 'quiet.example',
          title: 'Quiet',
          category: 'mailbox',
          steps: [{ actor: 'agent', instruction: 'Open the signup form.' }],
        })
      })()

      for (const url of [ATLAS_PATH, `${ATLAS_PATH}/c/mailbox`]) {
        const body = (await get(url)).body

        expect([...body.matchAll(/<small class="k-atlas-said">/g)], url).toHaveLength(1)
        expect(body, url).toContain(`<small class="k-atlas-said">${SAID}</small>`)
      }
    })

    /**
     * Absent rather than empty, and asserted on the opening tag: the selectors
     * themselves are in the inlined sheet on every page either way.
     */
    it('emits no element at all where there is no description', async () => {
      await said(null)()

      expect((await get('/atlas/said.example')).body).not.toContain(
        '<p class="k-atlas-description"',
      )
      expect((await get(ATLAS_PATH)).body).not.toContain('<small class="k-atlas-said"')
      expect((await get(`${ATLAS_PATH}/c/mailbox`)).body).not.toContain(
        '<small class="k-atlas-said"',
      )
    })

    /**
     * A description at the column's own maximum leaves 20 characters of the
     * budget, which no status sentence fits in. Decision 2: the description is
     * used alone rather than the pair being clipped.
     */
    it('drops the status sentence for a description that fills the budget', async () => {
      const filling = `${'A hosted mailbox that answers on IMAP. '.repeat(7)}It is run in the EU, alone.`

      expect(filling).toHaveLength(PROVIDER_DESCRIPTION_MAX_LENGTH)

      const described = await metaFor(filling)
      const behaved = await metaFor(null)

      expect(described).toBe(filling)
      expect(described.length).toBeLessThanOrEqual(ATLAS_META_DESCRIPTION_MAX_LENGTH)
      // Nothing of the status sentence survives, rather than its first few words.
      expect(behaved.length).toBeGreaterThan(0)
      expect(described).not.toContain(behaved.slice(0, 6))
    })

    /**
     * The catalogue is a table a `psql` prompt writes to by design, so *curated*
     * is not a property any of the three renderers may assume.
     */
    it('escapes the description in the head, on the page and in the structured data', async () => {
      const risky = 'A "free" tier & a <b>paid</b> one.'
      const escaped = 'A &quot;free&quot; tier &amp; a &lt;b&gt;paid&lt;/b&gt; one.'

      await said(risky)()
      const body = (await get('/atlas/said.example')).body

      expect(headOf(body)).toContain(`content="${escaped}`)
      expect(body).toContain(`<p class="k-atlas-description">${escaped}</p>`)

      const crumbs = blocksOf(body).find((one) => one['@type'] === 'BreadcrumbList')

      expect(crumbs?.itemListElement.at(-1)?.description).toBe(risky)
      // The raw angle bracket never reaches the document, in either element.
      expect(body).not.toContain('<b>paid</b>')
    })
  })

  /**
   * What a crawler is handed, and what it is asked to leave alone (`#790`).
   *
   * Measured on the live site on 2026-08-12: 93 of the 113 URLs in the sitemap
   * were entries saying nobody had looked yet — near-identical placeholders,
   * submitted by name, which is the doorway pattern `growth/README.md` forbids.
   * A refusal is a finding and stays in both.
   */
  describe('what the placeholders tell a crawler', () => {
    const rebuild = (write: (colony: FakeColony) => void) => async () => {
      await app.close()
      app = build()
      write(colony)
      await app.ready()
    }

    const withAnUnwrittenEntry = rebuild((one) =>
      one.recipes.write({
        kind: 'mailbox',
        provider: 'nobody.example',
        title: 'Nobody',
        status: 'unwritten',
      }),
    )

    it('submits what somebody walked, and no entry nobody has', async () => {
      await withAnUnwrittenEntry()

      const body = (await get('/atlas/sitemap.xml')).body

      expect(body).toContain(`<loc>${SITE}/atlas</loc>`)
      expect(body).toContain(`<loc>${SITE}/atlas/github</loc>`)
      expect(body).toContain(`<loc>${SITE}/atlas/bluesky</loc>`)
      expect(body).toContain(`<loc>${SITE}/atlas/withdrawn.example</loc>`)
      expect(body).not.toContain('nobody.example')
    })

    /**
     * **The page stays and the shelf still links it.** A gap is a page and not
     * an omission: leaving the index is not leaving the site.
     */
    it('asks a crawler to leave an unwritten page out and follow it anyway', async () => {
      await withAnUnwrittenEntry()

      const response = await get('/atlas/nobody.example')

      expect(response.statusCode).toBe(200)
      expect(response.body).toContain('<meta name="robots" content="noindex, follow">')
      /**
       * The shelf that links it is the one nobody got through (`#1103`), which
       * is where an unwritten entry belongs and is a link off the default view.
       * *Leaving the index is not leaving the site* was never a claim about
       * which half of the index.
       */
      expect((await get('/atlas?worked=false')).body).toContain('/atlas/nobody.example')
    })

    /** One walked row is enough, which is why the meta is absent nearly everywhere. */
    it('says nothing to a crawler about a page that has something to say', async () => {
      for (const url of ['/atlas', '/atlas/github', '/atlas/bluesky', '/atlas/withdrawn.example']) {
        expect((await get(url)).body, url).not.toContain('name="robots"')
      }
    })

    /** `atlasRank` puts `unwritten` above `refused`; a list of entries does not. */
    it('lists what somebody walked before what nobody has', async () => {
      await withAnUnwrittenEntry()

      /**
       * Both rows are ones nobody got through, so `#1103` puts them on the same
       * half — and the ordering `atlasRank` decides is untouched by the split,
       * which is the property this still asserts.
       */
      const body = (await get('/atlas?worked=false')).body

      // The same shelf, so this is the ordering and not which shelf came first.
      expect(body.indexOf('/atlas/withdrawn.example')).toBeLessThan(
        body.indexOf('/atlas/nobody.example'),
      )
    })
  })

  /**
   * The Atlas is the surface an outside agent reaches first, and every recipe on
   * it names Colony tools that a non-citizen cannot call (`#787`). Until the
   * block existed the page never said so, or said how that changes.
   */
  describe('what it tells a reader who is not a citizen yet', () => {
    const withAnUnwrittenEntry = async () => {
      await app.close()
      app = build()
      colony.recipes.write({
        kind: 'mailbox',
        provider: 'nobody.example',
        title: 'Nobody',
        status: 'unwritten',
      })
      await app.ready()
    }

    it('names the one call an agent makes, and links a human to the install', async () => {
      const body = (await get('/atlas/github')).body

      expect(body).toContain('kolonie.register')
      expect(body).toContain('mcp.kolonie.ai')
      expect(body).toContain('href="/skill/"')
    })

    /** A placeholder is the page most worth converting on: walking it is the ask. */
    it('asks the reader of an unwritten page to be the one who walks it', async () => {
      await withAnUnwrittenEntry()

      const body = (await get('/atlas/nobody.example')).body

      expect(body).toContain('You could be the one who walks this')
      expect(body).toContain('kolonie.register')
      expect(body).toContain('href="/skill/"')
    })

    /**
     * **A refusal carries no offer of any kind.** A page that says *do not try*
     * with a signup underneath it is the catalogue selling, and it would cost
     * the refusal the credibility the rest of the Atlas is built on.
     */
    it('offers nothing on a page that says there is nothing to join', async () => {
      for (const url of ['/atlas/bluesky', '/atlas/withdrawn.example']) {
        const body = (await get(url)).body

        expect(body, url).not.toContain('kolonie.register')
        expect(body, url).not.toContain('href="/skill/"')
      }
    })

    /** One line on the index: the door exists, said once, without selling. */
    it('says on the index that the tools need an account', async () => {
      const body = (await get('/atlas')).body

      expect(body).toContain('mcp.kolonie.ai')
      expect(body).toContain('href="/skill/"')
    })

    /**
     * `kolonie-website#111`. Measured 2026-08-17: a shelf mentioned MCP once in
     * a `<small>` over forty rows, a provider page dense with walk synthesis
     * never said why an account would be worth having, and the one page that did
     * it properly was `github.com` — whose block is written from its own steps,
     * so no other page could inherit it.
     */
    describe('what it says a Colony account is for', () => {
      /** Both next steps, on the same block, wherever that block renders. */
      const bothWays = (body: string, where: string) => {
        expect(body, where).toContain('What an account here is for')
        expect(body, where).toContain('kolonie.vault.set')
        expect(body, where).toContain('kolonie.accounts.prove')
        expect(body, where).toContain('kolonie.accounts.provider-report')
        expect(body, where).toContain('the Academy')
        expect(body, where).toContain('kolonie.register')
        expect(body, where).toContain('href="/skill/"')
      }

      it('carries both next steps on a shelf', async () => {
        bothWays((await get(`${ATLAS_PATH}/c/mailbox`)).body, 'shelf')
      })

      it('carries them on a provider page that is not only github', async () => {
        for (const url of ['/atlas/github', '/atlas/walked.example', '/atlas/unwritten.example'])
          bothWays((await get(url)).body, url)
      })

      /**
       * **Above the walls and not under them**, which is the whole of the
       * measured complaint: a reader on a phone met the wall lists first and the
       * invitation after them, if at all.
       */
      it('puts it above what the page found rather than below', async () => {
        const body = (await get('/atlas/github')).body

        expect(body.indexOf('What an account here is for')).toBeLessThan(
          body.indexOf('Getting the tools this page names'),
        )
      })

      /** The Atlas's one standing rule, and this block is on every page. */
      it('promises nothing about being accepted', async () => {
        const body = (await get(`${ATLAS_PATH}/c/mailbox`)).body

        expect(body).toContain('None of this makes any provider accept an agent')
      })

      /**
       * `#787`'s rule, kept exactly where `#1163` left it: a page saying *do not
       * try* carries no offer, and a refusal with successful walks under it is
       * not that page.
       */
      it('stays silent on a refusal and speaks where walks got through', async () => {
        expect((await get('/atlas/bluesky')).body).not.toContain('What an account here is for')

        await app.close()
        app = build()
        colony.recipes.write({
          kind: 'telephony',
          provider: 'reached.example',
          title: 'A number an agent can be texted at',
          status: 'refused',
          category: 'telephony',
          refusal: 'The carrier refuses outbound messaging to an account this young.',
          walls: [],
        })
        colony.recipes.measure({
          ...noFigures('telephony', 'reached.example'),
          attempted: 9,
          proved: 4,
          evidenced: true,
        })
        await app.ready()

        expect((await get('/atlas/reached.example')).body).toContain('What an account here is for')
      })

      /** One invitation per page: the old line was where the block now is. */
      it('does not also print the old join line on a shelf', async () => {
        const body = (await get(`${ATLAS_PATH}/c/mailbox`)).body

        expect(body).not.toContain('The recipes here are walked with Colony tools')
      })
    })
  })

  /**
   * **The opening a person reads before deciding whether any of this is for
   * them** (`kolonie-website#122`).
   *
   * The standfirst is accurate and operator-abstract: it describes the artefact
   * in the vocabulary of somebody who already accepts that an agent holding
   * accounts is a thing that happens. Somebody arriving from a search result does
   * not accept that yet, and reads a precise description of a thing whose point
   * they have not been told.
   */
  describe('the opening a reader gets before the standfirst', () => {
    /**
     * The paragraph and not the class name: the stylesheet is inlined in every
     * Atlas `<head>`, so `k-atlas-lede` alone is on the shelf pages too and a
     * check for it would pass on every page and prove nothing.
     */
    const LEDE = '<p class="k-atlas-lede">'

    it('says in plain terms what the list is and why an account of one’s own matters', async () => {
      const body = (await get('/atlas')).body

      expect(body).toContain(LEDE)
      expect(body).toContain('In plain terms')
      expect(body).toContain('borrows every one it uses')
      expect(body).toContain('href="/academy/"')
    })

    /**
     * The lede comes first because it is what decides whether the standfirst gets
     * read at all — a page that leads with the detail has answered a question the
     * reader has not asked yet.
     */
    it('puts it above the standfirst rather than after it', async () => {
      const body = (await get('/atlas')).body

      // `lastIndexOf`, because the standfirst is also the page's meta
      // description and its first occurrence is up in `<head>`.
      expect(body.indexOf(LEDE)).toBeLessThan(body.lastIndexOf('provider by provider'))
    })

    /**
     * **Nothing here promises a result.** Not that a provider accepts an agent
     * (`#547`) — *tried to hold an account at* is the claim, and each entry says
     * separately how its own attempt went.
     */
    it('claims an attempt rather than an outcome', async () => {
      const body = (await get('/atlas')).body

      expect(body).toContain('have tried to hold an account at')
    })

    /**
     * **On the index and nowhere else.** A shelf carries its own standfirst,
     * written for the question in its heading, and an entry page opens on the
     * provider — repeating a general lede under either is chrome rather than
     * information, which is what `#122` asks this not to become.
     */
    it('does not repeat itself on a shelf or on a provider page', async () => {
      for (const url of ['/atlas/c/code-hosting', '/atlas/github']) {
        expect((await get(url)).body, url).not.toContain(LEDE)
      }
    })
  })

  /**
   * Looking a provider up on the website (`#1302`).
   *
   * **What is asserted here is that the affordance exists without a script.**
   * D-062 is why: every page under this prefix is server-rendered HTML with no
   * framework, and a search that needed JavaScript would be the first thing on
   * this surface that stops working with one turned off.
   */
  describe('searching the catalogue', () => {
    it('puts a plain GET form on the index, pointed at the results page', async () => {
      const response = await get('/atlas')

      expect(response.body).toContain('<form class="k-atlas-search" method="get"')
      expect(response.body).toContain('action="/atlas/search"')
      expect(response.body).toContain('name="q"')
    })

    it('answers a query with the providers that match it', async () => {
      const response = await get('/atlas/search?q=github')

      expect(response.statusCode).toBe(200)
      expect(response.body).toContain('GitHub')
      expect(response.body).not.toContain('Bluesky')
    })

    it('asks not to be indexed, and points its canonical at the index', async () => {
      /**
       * A query string mints an unbounded number of addresses holding
       * rearrangements of pages that are indexed individually. `follow` stays,
       * because the links out of it are those pages.
       */
      const response = await get('/atlas/search?q=github')

      expect(response.body).toContain('<meta name="robots" content="noindex, follow">')
      expect(response.body).toContain(`<link rel="canonical" href="${SITE}/atlas">`)
    })

    it('says nothing matched rather than pretending the catalogue is empty', async () => {
      const response = await get('/atlas/search?q=nowhere.invalid')

      expect(response.statusCode).toBe(200)
      expect(response.body).toContain('absence and not a refusal')
    })

    it('serves the empty query as the box and a way back, not as a 400', async () => {
      const response = await get('/atlas/search')

      expect(response.statusCode).toBe(200)
      expect(response.body).toContain('k-atlas-search')
      expect(response.body).toContain('href="/atlas"')
    })

    it('escapes what the reader typed', async () => {
      const response = await get('/atlas/search?q=%3Cscript%3Ealert(1)%3C%2Fscript%3E')

      expect(response.statusCode).toBe(200)
      expect(response.body).not.toContain('<script>alert(1)</script>')
    })

    /**
     * **A browse, which is the thing the catalogue could not do** (`#1365`).
     * `#1342` shipped a lookup by name, and a reader who does not know the name
     * had nothing to type — so an agent asking *where can I earn today* had to
     * read the whole shelf list. An empty `q` with a facet is the answer.
     */
    describe('browsing by how a provider pays', () => {
      const earning = async (write: (colony: FakeColony) => void) => {
        await app.close()
        app = build()
        write(colony)
        await app.ready()
      }

      const payer = (provider: string) => ({
        ...noFigures('bounty-board', provider),
        attempted: 2,
        evidenced: true,
      })

      it('lists every provider that pays that way, with no query at all', async () => {
        await earning((one) => {
          one.recipes.measure(payer('boards.example'))
          one.recipes.measure({
            ...noFigures('mailbox', 'plain.example'),
            attempted: 2,
            evidenced: true,
          })
        })

        const body = (await get('/atlas/search?earn=bounty-board')).body

        expect(body).toContain('boards.example')
        expect(body).not.toContain('plain.example')
        expect(body).toContain('pays for finished tasks')
      })

      /**
       * **The sentences, because that is where `#1396` showed.** The phrase map
       * is right beside one provider and was being put after a plural subject:
       * the page shipped *Providers that pays for finished tasks*, and the count
       * read *5 providers match that pays for finished tasks* — two fragments
       * joined by a variable.
       */
      it('writes a sentence for the browse, in the title and in the count', async () => {
        await earning((one) => {
          one.recipes.measure(payer('boards.example'))
          one.recipes.measure(payer('other-boards.example'))
        })

        const body = (await get('/atlas/search?earn=bounty-board')).body

        expect(body).toContain('Providers that pay for finished tasks')
        expect(body).toContain('2 providers pay for finished tasks.')
        expect(body).not.toContain('that pays for finished tasks')
        expect(body).not.toContain('match that pay')
      })

      /**
       * Free-form tags (`#1406` decision 4). The tag vocabulary is open, so the
       * search *is* the browse — there is no shelf page to send a reader to, and
       * a chip that only sat there would be a label whose use a reader had to
       * guess.
       */
      describe('browsing by a free-form tag', () => {
        const tagged = (provider: string, ...tags: readonly string[]) => ({
          kind: 'api',
          provider,
          status: 'measured' as const,
          facets: tags.map((slug) => ({ axis: 'tag' as const, slug })),
        })

        it('lists every provider carrying the tag, and no others', async () => {
          await earning((one) => {
            one.recipes.write(tagged('tagged.example', 'ai-agents'))
            one.recipes.write(tagged('untagged.example'))
          })

          const body = (await get('/atlas/search?tag=ai-agents')).body

          expect(body).toContain('tagged.example')
          expect(body).not.toContain('untagged.example')
        })

        /**
         * A whole tag and never a substring: `?tag=ai` matching `ai-agents`
         * would make this a second, worse search box, and `q` is the one that
         * matches loosely.
         */
        it('matches the whole tag and never part of one', async () => {
          await earning((one) => one.recipes.write(tagged('tagged.example', 'ai-agents')))

          expect((await get('/atlas/search?tag=ai')).body).not.toContain('tagged.example')
        })

        it('says so plainly when no provider carries the tag', async () => {
          await earning((one) => one.recipes.write(tagged('tagged.example', 'ai-agents')))

          const body = (await get('/atlas/search?tag=nobody-uses-this')).body

          expect(body).toContain('Nothing in the catalogue')
          expect(body).not.toContain('tagged.example')
        })

        /**
         * A stale or malformed value is no filter rather than an error, which is
         * the same call `?worked=banana` and an over-long `q` both make: a 400 on
         * a public URL is a page a crawler stops asking for.
         */
        it('treats a value that could not be a tag as no filter at all', async () => {
          await earning((one) => one.recipes.write(tagged('tagged.example', 'ai-agents')))

          expect((await get('/atlas/search?tag=Not%20A%20Tag')).statusCode).toBe(200)
        })

        it('carries the tag through a refinement rather than dropping it', async () => {
          await earning((one) => one.recipes.write(tagged('tagged.example', 'ai-agents')))

          expect((await get('/atlas/search?tag=ai-agents')).body).toContain(
            'name="tag" value="ai-agents"',
          )
        })
      })

      it('joins the two halves where the reader asked for both', async () => {
        await earning((one) => one.recipes.measure(payer('boards.example')))

        const body = (await get('/atlas/search?q=boards&earn=bounty-board')).body

        expect(body).toContain('and pays for finished tasks.')
      })

      it('narrows a text query by the facet as well', async () => {
        await earning((one) => {
          one.recipes.measure(payer('boards.example'))
          one.recipes.measure({
            ...noFigures('mailbox', 'boards-mail.example'),
            attempted: 2,
            evidenced: true,
          })
        })

        const body = (await get('/atlas/search?q=boards&earn=bounty-board')).body

        expect(body).toContain('boards.example')
        expect(body).not.toContain('boards-mail.example')
      })

      /**
       * **An unknown facet is no filter rather than an error**, the same call
       * `?worked=banana` and the over-long query both make: a 400 on a public URL
       * is a page a crawler stops asking for.
       */
      it('treats a facet nobody has heard of as no filter', async () => {
        const response = await get('/atlas/search?q=github&earn=not-a-facet')

        expect(response.statusCode).toBe(200)
        expect(response.body).toContain('github')
      })

      it('offers the five ways to earn in the box, and no script to work them', async () => {
        const body = (await get('/atlas/search')).body

        expect(body).toContain('name="earn"')
        expect(body).toContain('pays for finished tasks')
        expect(body).toContain('pays for an audience')
        expect(body).not.toMatch(/<script(?![^>]*application\/ld\+json)/)
      })

      /**
       * **A second browse dimension on the index** (`#1365`). The shelves are the
       * only one it had, and for an earn-seeking reader that is the wrong one:
       * the providers that pay are spread across every shelf, and the ones whose
       * kind reaches no shelf sit under the `data-apis` fallback.
       */
      it('offers a way in from the index that is not a shelf', async () => {
        await earning((one) => one.recipes.measure(payer('boards.example')))

        const body = (await get('/atlas')).body

        expect(body).toContain('k-atlas-earn-nav')
        expect(body).toContain('/atlas/search?earn=bounty-board')
      })

      /** And it is absent where nothing pays, rather than an empty heading. */
      it('says nothing on a catalogue where nobody has filed an earn facet', async () => {
        const body = (await get('/atlas')).body

        expect(body).not.toContain('k-atlas-earn-nav')
      })
    })

    it('answers on the Atlas host only, like every page beside it', async () => {
      const elsewhere = await get('/atlas/search?q=github', 'api.kolonie.ai')

      expect(elsewhere.statusCode).toBe(404)
    })
  })

  describe('which host it answers on', () => {
    /**
     * The API answers on five hostnames from one process. An Atlas that served
     * on all of them would be four duplicates a canonical tag has to argue with.
     */
    it('does not answer on the API’s own host', async () => {
      expect((await get('/atlas', 'api.elsewhere.test')).statusCode).toBe(404)
    })

    it('does not serve at all when the site URL is unset', async () => {
      await app.close()
      app = build('')
      await app.ready()

      expect((await get('/atlas')).statusCode).toBe(404)
    })
  })

  /**
   * **What worked is the default and what did not is one link away** (`#1103`).
   *
   * The catalogue is a map and a map that hides closed roads is worse than none —
   * and at a thousand entries a reader looking for a mailbox still has to see the
   * providers somebody got through first. The two pull in opposite directions,
   * and what settles them is a default rather than a deletion: every entry keeps
   * its page, its URL, its place in the sitemap and its row on the index, and
   * what changes is which of two views a reader lands on.
   *
   * **The split is asserted as a partition and not as two memberships.** A filter
   * can go wrong in exactly two ways nobody notices — an entry on both halves, or
   * an entry on neither — and each of those reads as an ordinary page.
   */
  describe('what worked, and what did not', () => {
    /**
     * Two shelves the split needs and the fixture does not otherwise have: one
     * with a row on each side of it, and one where everybody got through.
     *
     * **Both are written with an explicit category**, because what is under test
     * is the split and not the shelving — an assertion that read a shelf the
     * kind-to-category map happened to choose would fail the day that map moves,
     * naming this issue for a change that has nothing to do with it.
     */
    const withBothHalves = async () => {
      await app.close()
      app = build()
      colony.recipes.write({
        kind: 'mailbox',
        provider: 'joinable.example',
        title: 'Joinable',
        category: 'mailbox',
      })
      colony.recipes.write({
        kind: 'mailbox',
        provider: 'closed.example',
        title: 'Closed',
        category: 'mailbox',
        status: 'unwritten',
      })
      colony.recipes.write({
        kind: 'phone',
        provider: 'phone.example',
        title: 'Phone',
        category: 'telephony',
      })
      await app.ready()
    }

    /**
     * The providers a rendered index links to, in the order it links to them.
     *
     * **`/atlas/c/` is excluded rather than matched and filtered afterwards**
     * (`#1107`): a shelf link is a `<li><a href>` of exactly the same shape as an
     * entry link now that shelves have addresses, so without the lookahead every
     * one of these assertions would be counting the navigation.
     */
    const listed = (body: string): readonly string[] =>
      [...body.matchAll(/<li><a href="\/atlas\/(?!c\/)([^"]+)">/g)].map((one) => one[1] ?? '')

    it('shows only what somebody got through, by default and on a shelf', async () => {
      await withBothHalves()

      expect([...listed((await get('/atlas')).body)].sort()).toEqual([
        'github',
        'joinable.example',
        'phone.example',
      ])
      expect(listed((await get(`${ATLAS_PATH}/c/mailbox`)).body)).toEqual(['joinable.example'])
    })

    /**
     * **The two halves are the shelf, exactly**: nothing in both, nothing in
     * neither. Checked against `catalogue.json`, which is the same catalogue with
     * no view over it at all — so a filter that quietly dropped a row from both
     * views fails here rather than passing two set comparisons with each other.
     */
    it('splits a shelf in two and loses nothing between them', async () => {
      await withBothHalves()

      const worked = listed((await get(`${ATLAS_PATH}/c/mailbox`)).body)
      const not = listed((await get(`${ATLAS_PATH}/c/mailbox?worked=false`)).body)
      const document = JSON.parse((await get('/atlas/catalogue.json')).body) as {
        entries: readonly { provider: string; category: string }[]
      }
      const shelf = document.entries
        .filter((entry) => entry.category === 'mailbox')
        .map((entry) => entry.provider)

      expect(shelf.length).toBeGreaterThan(1)
      expect(worked.filter((one) => not.includes(one))).toEqual([])
      expect([...worked, ...not].sort()).toEqual([...shelf].sort())
    })

    /** The link itself, because a default nobody can leave is a deletion. */
    it('reaches the other half from a plain link on the page', async () => {
      await withBothHalves()

      expect((await get('/atlas')).body).toContain(`href="${ATLAS_PATH}?worked=false"`)
      expect((await get(`${ATLAS_PATH}/c/mailbox`)).body).toContain(
        `href="${ATLAS_PATH}/c/mailbox?worked=false"`,
      )
      /** And the way back, so neither view is a corner. */
      expect((await get(`${ATLAS_PATH}?worked=false`)).body).toContain(`href="${ATLAS_PATH}"`)
    })

    /**
     * **Decision 4, and the reason the default is not a filter.** The one social
     * row in the fixture is a refusal, so that shelf's default view has nothing
     * on it — and *nobody got in anywhere here* is a better answer than a blank
     * page however few entries carry it.
     */
    it('shows the failures under a sentence where nothing worked, never an empty list', async () => {
      const body = (await get(`${ATLAS_PATH}/c/social-publishing`)).body

      expect(listed(body)).toEqual(['bluesky'])
      expect(body).toContain('Nobody has got through here yet')
    })

    /**
     * The fallback runs on the default view only. A reader who asked for the
     * failures and found none has their answer, and showing them the successes
     * instead would be the page overruling what they typed.
     */
    it('does not fall back the other way', async () => {
      await withBothHalves()

      const body = (await get(`${ATLAS_PATH}/c/telephony?worked=false`)).body

      expect(listed(body)).toEqual([])
      expect(body).toContain('Every entry here is one somebody got through')
    })

    /**
     * **Decision 5, and `#1107` decision 6 beside it.** A filtered view is a
     * slice of one page and not a page of its own, so `worked` drops out of the
     * canonical — which is what stops near-identical URLs competing in a search
     * index. A shelf is the other case: it is a page of its own, so its
     * canonical is itself and never the index.
     */
    it('drops the view parameter from the canonical, and keeps the shelf', async () => {
      for (const url of ['/atlas', `${ATLAS_PATH}?worked=false`]) {
        expect((await get(url)).body, url).toContain(
          `<link rel="canonical" href="${SITE}${ATLAS_PATH}">`,
        )
      }

      for (const url of [`${ATLAS_PATH}/c/mailbox`, `${ATLAS_PATH}/c/mailbox?worked=false`]) {
        expect((await get(url)).body, url).toContain(
          `<link rel="canonical" href="${SITE}${ATLAS_PATH}/c/mailbox">`,
        )
      }
    })

    /**
     * **Decision 7, and it is the same answer an unknown `?category=` gets.** A
     * reader following a mangled link wants the page, and a 400 on a public URL
     * is a page a crawler stops asking for. Asserted as byte equality with the
     * bare index, so *renders the default view* means the default view rather
     * than something that merely also returned 200.
     */
    it('answers a worked it cannot read with the default view and no error', async () => {
      const nonsense = await get(`${ATLAS_PATH}?worked=banana`)

      expect(nonsense.statusCode).toBe(200)
      expect(nonsense.body).toBe((await get('/atlas')).body)
      /** And `true`, which is spelled out nowhere and must still mean the default. */
      expect((await get(`${ATLAS_PATH}?worked=true`)).body).toBe(nonsense.body)
    })

    /**
     * **Decision 3, asserted because it is the one a later optimisation is most
     * likely to break.** The tempting next step from *hide it on the index* is
     * *drop it from the sitemap*, then *noindex it*, then *404 it* — and each of
     * those is a step the issue refuses. A refusal cost a citizen a walk and is
     * the finding the catalogue exists to carry.
     */
    it('keeps a refused entry at its own URL, in the sitemap, and indexable', async () => {
      const page = await get('/atlas/bluesky')

      expect(page.statusCode).toBe(200)
      expect(page.body).toContain('without a phone number')
      expect(page.body).not.toContain('name="robots"')
      expect((await get('/atlas/sitemap.xml')).body).toContain(`<loc>${SITE}/atlas/bluesky</loc>`)
    })

    /**
     * The sitemap is one document and not two: it carries the pages, and which
     * view of the index links to a page is not something a crawler is told.
     */
    it('leaves the sitemap and the data route untouched by the view', async () => {
      const sitemap = (await get('/atlas/sitemap.xml')).body

      expect(sitemap).not.toContain('worked=')
      expect(sitemap).toContain(`<loc>${SITE}${ATLAS_PATH}</loc>`)
      expect((await get('/atlas/catalogue.json')).body).not.toContain('worked=')
    })
  })

  /**
   * A shelf a reader can decide on (`#1164`).
   *
   * **Measured 2026-08-17 on live `kolonie.ai/atlas/c/telephony`.** The shelf
   * said *Showing what worked* over rows that were, one by one, providers that
   * had refused somebody — and a row carried a title, a state chip and who was
   * needed, so a reader comparing four SMS providers had to open all four pages
   * to learn which of them charged money, which way each had been walked, and
   * how many walks were behind either answer.
   *
   * Two halves, and they are the two the issue names: what a row carries, and
   * what the word over the rows means. The fixture is one shelf with a measured
   * refusal, a free provider walked both ways and a paid one, because the
   * comparison is the thing being tested.
   */
  describe('a shelf a reader can decide on', () => {
    const rowFor = (body: string, provider: string) => {
      const row = [...body.matchAll(/<li>.*?<\/li>/gs)]
        .map((match) => match[0])
        .find((one) => one.includes(`/atlas/${provider}"`))

      if (row === undefined) throw new Error(`no index row for ${provider}`)

      return row
    }

    /** Three telephony providers a reader would actually be choosing between. */
    const shelf = async () => {
      await app.close()
      app = build()
      colony.recipes.write({
        kind: 'phone',
        provider: 'free.example',
        title: 'Free numbers',
        category: 'telephony',
        cost: 'free',
        direction: 'both',
      })
      colony.recipes.measure({
        ...noFigures('phone', 'free.example'),
        attempted: 20,
        proved: 15,
        evidenced: true,
      })
      colony.recipes.write({
        kind: 'phone',
        provider: 'paid.example',
        title: 'Paid numbers',
        category: 'telephony',
        cost: 'paid-only',
        direction: 'outbound',
      })
      colony.recipes.measure({
        ...noFigures('phone', 'paid.example'),
        attempted: 8,
        proved: 3,
        evidenced: true,
      })
      /** A refusal with walks behind it: `#1163`'s `partly`, on a shelf. */
      colony.recipes.write({
        kind: 'phone',
        provider: 'partly.example',
        title: 'Refused for sending',
        category: 'telephony',
        status: 'refused',
        refusal: 'The carrier refuses outbound messaging to an account this young.',
      })
      colony.recipes.measure({
        ...noFigures('phone', 'partly.example'),
        attempted: 9,
        proved: 4,
        evidenced: true,
      })
      /** And one nobody got through, so the shelf has a second half to name. */
      colony.recipes.write({
        kind: 'phone',
        provider: 'shut.example',
        title: 'Shut',
        category: 'telephony',
        status: 'refused',
        refusal: 'Signup demands a document no citizen holds.',
      })
      await app.ready()
    }

    /**
     * The four facts the issue asks a card to carry, on one row: what it is,
     * what got through, who is needed, and what it costs — plus the direction,
     * which telephony is the kind that has one.
     */
    it('carries the outcome, the need, the cost and the direction on the row', async () => {
      await shelf()

      const row = rowFor((await get(`${ATLAS_PATH}/c/telephony`)).body, 'free.example')

      expect(row).toContain('Free numbers')
      expect(row).toContain('75% of 20 got through')
      expect(row).toContain('k-atlas-need')
      expect(row).toContain('free, no card')
      expect(row).toContain('walked both ways')
      expect(row).toContain(`href="/atlas/free.example"`)
    })

    /** And they are the entry's own, rather than one row's copy of another's. */
    it('reads each row from its own entry', async () => {
      await shelf()

      const row = rowFor((await get(`${ATLAS_PATH}/c/telephony`)).body, 'paid.example')

      expect(row).toContain('38% of 8 got through')
      expect(row).toContain('paid only')
      expect(row).toContain('walked for sending')
      expect(row).not.toContain('free, no card')
    })

    /**
     * **Absent rather than empty.** An unasked cost has no chip and a kind with
     * no direction to it has no direction: a row that printed *unknown* twice
     * would fill the shelf with the fact that the shelf is empty, which is the
     * opposite of what `#1164` asks for.
     */
    it('prints no chip for a cost nobody asked and a kind with no direction', async () => {
      const row = rowFor((await get('/atlas?worked=false')).body, 'walked.example')

      expect(row).not.toContain('k-atlas-cost')
      expect(row).not.toContain('k-atlas-way')
      /** The need is on every row, because every row has an answer to it. */
      expect(row).toContain('k-atlas-need')
    })

    /**
     * **The figure is no longer gated on `joinable`** (`#1163`'s model, on the
     * shelf). A `partly` row is listed under what worked and used to say nothing
     * at all about how many walks that was — which is the figure a reader most
     * needs, on the row hardest to judge without it.
     */
    it('prints the measurement on a refusal somebody got through', async () => {
      await shelf()

      const row = rowFor((await get(`${ATLAS_PATH}/c/telephony`)).body, 'partly.example')

      expect(row).toContain('44% of 9 got through')
      expect(row).toContain('partly — some walks got in')
    })

    /** A poor number is printed like any other: `figuresSection`'s rule, here too. */
    it('prints a refusal nobody got through as the zero it is', async () => {
      await app.close()
      app = build()
      colony.recipes.write({
        kind: 'phone',
        provider: 'closed.example',
        title: 'Closed',
        category: 'telephony',
        status: 'refused',
      })
      colony.recipes.measure({
        ...noFigures('phone', 'closed.example'),
        attempted: 12,
        proved: 0,
        refused: 12,
        evidenced: true,
      })
      await app.ready()

      const row = rowFor(
        (await get(`${ATLAS_PATH}/c/telephony?worked=false`)).body,
        'closed.example',
      )

      expect(row).toContain('0% of 12 got through')
    })

    /** The label says what it means by the word, on the shelf rather than in a docstring. */
    it('defines what worked means where the word is used', async () => {
      await shelf()

      const body = (await get(`${ATLAS_PATH}/c/telephony`)).body

      expect(body).toContain('Showing what worked: entries at least one agent measurably got into')
    })

    /**
     * **The rejection test the issue asks for.** A telephony shelf whose every
     * entry is a refusal nobody got through must never be labelled as what
     * worked: the fallback sentence stands in its place, and the word does not
     * appear over the rows at all.
     */
    it('never labels a shelf of pure refusals as what worked', async () => {
      await app.close()
      app = build()
      for (const provider of ['refused-one.example', 'refused-two.example']) {
        colony.recipes.write({
          kind: 'phone',
          provider,
          title: provider,
          category: 'telephony',
          status: 'refused',
          refusal: 'Signup demands a document no citizen holds.',
        })
      }
      await app.ready()

      const body = (await get(`${ATLAS_PATH}/c/telephony`)).body

      expect(body).toContain('Nobody has got through here yet')
      expect(body).not.toContain('Showing what worked')
      expect(rowFor(body, 'refused-one.example')).toContain('cannot be joined')
    })
  })

  /**
   * **A shelf is a page and not a query string** (`#1107`).
   *
   * The shelf-shaped search — *mailbox providers an AI agent can sign up for* —
   * is the one this catalogue is best placed to win, and until now the page that
   * answered it lived at `/atlas?category=mailbox`: an address no crawler treats
   * as a landing page and no reader would type. Two levels of taxonomy arrived in
   * `#1102` with no address at all, which is a data model nobody can reach.
   *
   * **The two levels are one route**, so what these tests separate is not top
   * from sub but the things that actually differ: what a page lists, and what a
   * wrong address gets.
   */
  describe('a category as a page of its own', () => {
    /** Every provider the page links to, shelf links excluded as above. */
    const listed = (body: string): readonly string[] =>
      [...body.matchAll(/<li><a href="\/atlas\/(?!c\/)([^"]+)">/g)].map((one) => one[1] ?? '')

    /**
     * Two of *identity and access*'s three shelves filled, the third left empty.
     *
     * **The categories are explicit**, as they are in the split's own fixture:
     * what is under test is which shelf a page gathers from, and a row shelved by
     * whatever the kind-to-category map happens to say would fail here the day
     * that map moves, naming this issue for a change that is not about it.
     */
    const withATopCategory = async () => {
      await app.close()
      app = build()
      colony.recipes.write({
        kind: 'mailbox',
        provider: 'joinable.example',
        title: 'Joinable',
        category: 'mailbox',
      })
      colony.recipes.write({
        kind: 'mailbox',
        provider: 'closed.example',
        title: 'Closed',
        category: 'mailbox',
        status: 'unwritten',
      })
      colony.recipes.write({
        kind: 'phone',
        provider: 'phone.example',
        title: 'Phone',
        category: 'telephony',
      })
      await app.ready()
    }

    /** The `ItemList` block, parsed — the page's own claim about what it rendered. */
    const itemList = (body: string): { name: string; numberOfItems: number; urls: string[] } => {
      const blocks = [
        ...body.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g),
      ].map((one) => JSON.parse(one[1] ?? '{}'))
      const list = blocks.find((one) => one['@type'] === 'ItemList')
      if (list === undefined) throw new Error('the page emitted no ItemList')

      return {
        name: list.name,
        numberOfItems: list.numberOfItems,
        urls: list.itemListElement.map((one: { url: string }) => one.url),
      }
    }

    /**
     * **Every seeded row, top and sub, rather than a sample of them.** A
     * taxonomy is seeded by a migration and read by a route, and the failure this
     * catches is a shelf that exists in the table and answers 404 at its own
     * address — which is invisible until somebody links to it.
     */
    it('resolves for every category the table holds', async () => {
      for (const category of ATLAS_SEEDED_CATEGORIES) {
        const response = await get(`${ATLAS_PATH}/c/${category.slug}`)

        expect(response.statusCode, category.slug).toBe(200)
        expect(response.body, category.slug).toContain(category.standfirst)
      }
    })

    /**
     * **Decision 4.** The heading is the reader's own sentence back, built from
     * the row's title rather than from new copy — so a shelf renamed in the table
     * renames its own H1 and nothing here has to be told.
     */
    it('heads the page with the question a reader typed', async () => {
      expect((await get(`${ATLAS_PATH}/c/mailbox`)).body).toContain(
        '<h1>Which mailboxes can an AI agent sign up for?</h1>',
      )
      /** And a top category, whose title is a phrase rather than a plural noun. */
      expect((await get(`${ATLAS_PATH}/c/identity-access`)).body).toContain(
        '<h1>Which identity and access can an AI agent sign up for?</h1>',
      )
    })

    /**
     * **Decision 2, which is the whole argument for a top-category page.** A
     * reader who arrives at *identity and access* must not have to guess which of
     * three shelves holds what they came for: the sub categories are on the page
     * with their counts, and so are the entries across all of them.
     */
    it('lists a top category’s sub categories with counts, and the entries under all of them', async () => {
      await withATopCategory()

      const body = (await get(`${ATLAS_PATH}/c/identity-access`)).body

      expect(body).toContain(`href="${ATLAS_PATH}/c/mailbox"`)
      expect(body).toContain(`href="${ATLAS_PATH}/c/telephony"`)
      /** Across both shelves, which is the point of the page. */
      expect([...listed(body)].sort()).toEqual(['joinable.example', 'phone.example'])
      /**
       * **A shelf with nothing on it is still in the nav, printed as zero.** It
       * is the shelf that most needs somebody to walk it, and a nav that hid it
       * would hide exactly that.
       */
      expect(body).toContain(
        `<li><a href="${ATLAS_PATH}/c/identity-security">Identity and security</a> ` +
          '<span class="k-atlas-count">0</span></li>',
      )
      /** And the counts are the shelf's, not the page's. */
      expect(body).toContain(
        `<li><a href="${ATLAS_PATH}/c/mailbox">Mailboxes</a> ` +
          '<span class="k-atlas-count">2</span></li>',
      )
    })

    /**
     * **Decision 5, and the rejection case the issue names third.** An
     * `ItemList` that named every entry that *could* belong to a top category
     * would be markup describing a page nobody was served — the same lie
     * `#789` refused when it made the list follow the rendering.
     */
    it('names in the ItemList only what the top page rendered', async () => {
      await withATopCategory()

      const body = (await get(`${ATLAS_PATH}/c/identity-access`)).body
      const list = itemList(body)

      expect(list.name).toBe('The Atlas — identity-access')
      expect(list.numberOfItems).toBe(listed(body).length)
      expect([...list.urls].sort()).toEqual(
        [...listed(body)].sort().map((provider) => `${SITE}/atlas/${provider}`),
      )
      /**
       * The other half of the shelf is on the page's own count and not in the
       * list: `closed.example` belongs to *identity and access* and was not
       * rendered, which is exactly the difference decision 5 is about.
       */
      expect(list.urls).not.toContain(`${SITE}/atlas/closed.example`)
      /** Nor is anything from another top category. */
      expect(list.urls).not.toContain(`${SITE}/atlas/github`)
    })

    /**
     * **Decision 8, and the second rejection case.** `FAQPage` promises that
     * every question in it is answered on the page it is attached to. A shelf's
     * questions are answered on the pages it links to, so the markup would be a
     * claim about somewhere else — which is exactly what `#1105` declined to
     * emit one level down.
     */
    it('emits no FAQPage on a category page, at either level', async () => {
      for (const slug of ['identity-access', 'mailbox', 'telephony']) {
        expect((await get(`${ATLAS_PATH}/c/${slug}`)).body, slug).not.toContain('"FAQPage"')
      }
      /** And the provider page still has one, so this is a scope and not a removal. */
      expect((await get('/atlas/github')).body).toContain('"FAQPage"')
    })

    /**
     * **Decision 3.** One canonical address per shelf, and the old one keeps
     * working — including the view a reader was on, which is the half of a
     * redirect that is usually dropped.
     */
    it('redirects the old query string to the page, keeping the view', async () => {
      const moved = await get(`${ATLAS_PATH}?category=mailbox`)

      expect(moved.statusCode).toBe(301)
      expect(moved.headers.location).toBe(`${ATLAS_PATH}/c/mailbox`)
      expect((await get(`${ATLAS_PATH}?category=mailbox&worked=false`)).headers.location).toBe(
        `${ATLAS_PATH}/c/mailbox?worked=false`,
      )
    })

    /**
     * **The first rejection case, and it is deliberately not the answer an
     * unknown `?category=` gets.** A filter nobody defined is a wrong filter and
     * the page it filtered still exists, so the index renders. A slug nobody
     * defined is a wrong *address*: there is no page, and answering 200 would
     * publish an unbounded set of URLs that all render the same thing — the
     * doorway pattern `#790` took entries out of the sitemap to avoid.
     */
    it('answers a slug nobody defined with a 404 rather than the index', async () => {
      const response = await get(`${ATLAS_PATH}/c/nonsense`)

      expect(response.statusCode).toBe(404)
      expect(response.body).not.toContain('GitHub')
      /** A slug that is not even slug-shaped goes the same way rather than 400. */
      expect((await get(`${ATLAS_PATH}/c/Not%20A%20Slug`)).statusCode).toBe(404)
    })

    /**
     * **Decision 7.** Every shelf is in the sitemap, including the empty ones —
     * which reads like the rule `#790` wrote and is its opposite: what `#790`
     * took out was a near-identical placeholder about a provider nobody has
     * looked at, and a shelf page says what the shelf is for and how much of it
     * has been walked. There are twenty of them and the taxonomy bounds the
     * count, so this cannot become a long tail.
     */
    it('puts every category in the sitemap, empty ones included', async () => {
      const sitemap = (await get('/atlas/sitemap.xml')).body

      for (const category of ATLAS_SEEDED_CATEGORIES) {
        expect(sitemap, category.slug).toContain(
          `<loc>${SITE}${ATLAS_PATH}/c/${category.slug}</loc>`,
        )
      }
      /** `storage` has no entry in the fixture, which is what makes it the case. */
      expect(listed((await get(`${ATLAS_PATH}/c/storage`)).body)).toEqual([])
      expect((await get(`${ATLAS_PATH}/c/storage`)).body).toContain('waiting to be filled')
    })
  })

  /**
   * The risk `#546` states as a requirement: the API begins serving
   * unauthenticated public traffic, and nothing under this prefix may read a
   * citizen's data.
   *
   * **Asserted as byte equality rather than by inspecting the handler**, because
   * that is the form a personalisation cannot pass however it is introduced —
   * through a session cookie, an API key, or a header nobody thought of.
   */
  describe('nothing under the prefix is per-citizen', () => {
    it('answers a credentialed request with exactly the anonymous bytes', async () => {
      const anonymous = await get('/atlas/github')

      const credentialed = await app.inject({
        method: 'GET',
        url: '/atlas/github',
        headers: {
          host: SITE_HOST,
          accept: 'text/html',
          authorization: 'Bearer some-citizens-key',
          cookie: 'kolonie_session=somebodys-session',
        },
      })

      expect(credentialed.body).toBe(anonymous.body)
      expect(credentialed.statusCode).toBe(anonymous.statusCode)
    })

    it('does the same for the index and the sitemap', async () => {
      for (const path of ['/atlas', '/atlas/sitemap.xml']) {
        const anonymous = await get(path)
        const credentialed = await app.inject({
          method: 'GET',
          url: path,
          headers: { host: SITE_HOST, accept: 'text/html', authorization: 'Bearer a-key' },
        })

        expect(credentialed.body).toBe(anonymous.body)
      }
    })

    /**
     * The data route the same way, minus the one field that is *supposed* to
     * differ between two requests.
     *
     * **`generatedAt` is compared out rather than the route being excused.** A
     * whole-body equality here would be a flake — the timestamp is the point of
     * the field — and dropping the route from the check would leave the surface
     * a third party stores a URL to as the only one nothing guards.
     */
    it('answers the data route with the same content for a credentialed reader', async () => {
      const withoutTime = (body: string) => {
        const parsed = JSON.parse(body)
        delete parsed.generatedAt
        return JSON.stringify(parsed)
      }

      const anonymous = await get('/atlas/catalogue.json')
      const credentialed = await app.inject({
        method: 'GET',
        url: '/atlas/catalogue.json',
        headers: { host: SITE_HOST, authorization: 'Bearer a-key', cookie: 'kolonie_session=x' },
      })

      expect(withoutTime(credentialed.body)).toBe(withoutTime(anonymous.body))
    })
  })
})
