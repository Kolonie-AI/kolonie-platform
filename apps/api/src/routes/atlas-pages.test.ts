import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.js'
import { fakeColony, type FakeColony } from '../__fixtures__/colony/index.js'
import { AccountCapabilitySchema, AccountKindSchema, ATLAS_PATH, noFigures } from '@kolonie-ai/core'
import type { SiteChrome } from '../atlas/site-chrome.js'

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

  const build = (websiteUrl: string = SITE) => {
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

    return buildApp({ ...colony, websiteUrl, siteChrome })
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
      expect(response.body).toContain('Bluesky')
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
      const response = await get('/atlas')

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

      const body = (await get('/atlas')).body

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
     * **Filtering is a link and never a widget** — `?category=`, D-062, the
     * same decision the console's browser took in `#591`. There is no script on
     * this page to fail.
     */
    it('filters to one shelf from a link, with no JavaScript anywhere', async () => {
      const response = await get('/atlas?category=social-publishing')

      expect(response.statusCode).toBe(200)
      expect(response.body).toContain('Bluesky')
      expect(response.body).not.toContain('>GitHub<')
      /**
       * **No executable script, which is the promise** (`#97`, D-062): filtering
       * is a link and the page works with JavaScript off. The `ld+json` block
       * `#789` added is data — the browser never executes it — so the assertion
       * is about a script that *runs* rather than about the string.
       */
      expect(response.body).not.toContain('<script>')
      expect(response.body).not.toContain('text/javascript')
      /** And a way back out of the filter. */
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
      expect(response.body).toContain('Bluesky')
    })

    /**
     * **Internal linking runs in both directions** (`kolonie-website#97`),
     * which is what makes a map out of a list. Entry to category was the
     * missing half: the category on an entry page linked to the whole index.
     */
    it('links an entry to its own shelf, and the shelf back to the entry', async () => {
      expect((await get('/atlas/github')).body).toContain('/atlas?category=code-hosting')
      expect((await get('/atlas?category=code-hosting')).body).toContain('/atlas/github')
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

      expect(text).toContain('Bluesky')
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

    /**
     * **The refusal first, then the figures, then the write-up.** A reader has
     * to learn the road is closed before reading what walkers found there, or
     * the findings read as an invitation.
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

      expect(refusal).toBeGreaterThan(-1)
      expect(refusal).toBeLessThan(figures)
      expect(figures).toBeLessThan(written)
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

    it('heads a shelf with its title and keeps the slug where it is an address', async () => {
      const body = (await get('/atlas')).body

      expect(body).toContain('Social and publishing')
      expect(body).toContain('id="social-publishing"')
      expect(body).toContain(`${ATLAS_PATH}?category=social-publishing`)
    })

    it('says the kinds on a row in words', async () => {
      expect((await get('/atlas')).body).toContain('a social account')
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
     * **The heading is the curator's line and stays it.** A reader who has
     * arrived is looking at the page, not at a search result, and the two
     * sentences are written for different people.
     */
    it('leaves the h1 alone', async () => {
      const body = (await get('/atlas/github')).body

      expect(body).toContain('<h1>GitHub</h1>')
      expect(body).not.toContain('<h1>github for an AI agent')
    })

    it('titles a shelf for the search that finds it rather than for the filter', async () => {
      expect(headOf((await get(`${ATLAS_PATH}?category=mailbox`)).body)).toContain(
        '<title>Mailboxes an AI agent can sign up for — Kolonie</title>',
      )
      expect(headOf((await get(ATLAS_PATH)).body)).toContain('<title>The Atlas — Kolonie</title>')
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
      expect((await get('/atlas')).body).toContain('/atlas/nobody.example')
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

      const body = (await get('/atlas')).body

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
