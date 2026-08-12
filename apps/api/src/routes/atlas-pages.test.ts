import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.js'
import { fakeColony, type FakeColony } from '../__fixtures__/colony/index.js'
import { noFigures } from '@kolonie-ai/core'
import type { SiteChrome } from '../atlas/site-chrome.js'

const SITE = 'https://site.test'
const SITE_HOST = 'site.test'

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
      provider: 'unreviewed.example',
      title: 'Unreviewed',
      status: 'draft',
      steps: [{ actor: 'agent', instruction: 'A step no steward has read.' }],
    })
    colony.recipes.write({
      kind: 'mailbox',
      provider: 'suggested.example',
      title: 'Suggested',
      status: 'proposed',
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

    it('serves one page per provider at a readable path', async () => {
      const response = await get('/atlas/github')

      expect(response.statusCode).toBe(200)
      expect(response.body).toContain('Open the signup form.')
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
    it('gives a withdrawn provider a page that says what happened and keeps the steps', async () => {
      const response = await get('/atlas/withdrawn.example')

      expect(response.statusCode).toBe(200)
      expect(response.body).toContain('demanding a phone number in June')
      expect(response.body).toContain('Withdrawn')
      /** The record of what the path was, which is the argument for keeping the row. */
      expect(response.body).toContain('Open the signup form.')
    })

    /**
     * **The two states no stranger may see** (`#604`).
     *
     * A `proposed` entry is somebody's suggestion about a third party's product
     * that nobody at the Colony has read; a `draft` is a path no steward has
     * stood behind. Asserted against the served bytes rather than against the
     * filter, because the filter passing while a page renders the row is exactly
     * the failure that matters.
     */
    it('shows neither a draft nor a proposal on the index', async () => {
      const response = await get('/atlas')

      expect(response.body).not.toContain('unreviewed.example')
      expect(response.body).not.toContain('suggested.example')
      expect(response.body).not.toContain('A step no steward has read.')
      /** And the withdrawal is on it, which is what makes the assertion above about state. */
      expect(response.body).toContain('withdrawn.example')
    })

    it('answers 404 for a draft and for a proposal, as if the row were not there', async () => {
      expect((await get('/atlas/unreviewed.example')).statusCode).toBe(404)
      expect((await get('/atlas/suggested.example')).statusCode).toBe(404)
    })

    it('leaves both out of catalogue.json', async () => {
      const response = await get('/atlas/catalogue.json')
      const document = JSON.parse(response.body) as {
        entries: readonly { provider: string }[]
      }
      const providers = document.entries.map((entry) => entry.provider)

      expect(providers).not.toContain('unreviewed.example')
      expect(providers).not.toContain('suggested.example')
      expect(providers).toContain('withdrawn.example')
    })

    it('leaves both out of the sitemap', async () => {
      const response = await get('/atlas/sitemap.xml')

      expect(response.body).not.toContain('unreviewed.example')
      expect(response.body).not.toContain('suggested.example')
      expect(response.body).toContain('withdrawn.example')
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
        expect(response.body).toContain('Open the signup form.')
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
      expect(body).toMatch(/social-publishing<\/a> <span class="k-atlas-count">1<\/span>/)
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

      /** 1 what it is · 2 can it do this alone · 3 the recipe · 5 last confirmed */
      expect(at('<h1>')).toBeLessThan(at('k-atlas-facts'))
      expect(at('k-atlas-facts')).toBeLessThan(at('Open the signup form.'))
      expect(at('Open the signup form.')).toBeLessThan(at('k-atlas-confirmed'))
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
     * The page was already a numbered list of steps with an actor on each; this
     * is that shape written down for a reader that is not a person.
     */
    it('carries the machine-readable copy of what it says', async () => {
      const entryPage = (await get('/atlas/github')).body
      const index = (await get('/atlas')).body

      expect(entryPage).toContain('<script type="application/ld+json">')
      expect(entryPage).toContain('"@type":"BreadcrumbList"')
      expect(entryPage).toContain('"@type":"HowTo"')
      expect(index).toContain('"@type":"ItemList"')
      /** A refusal is still a place in the map, and still not a set of steps. */
      expect((await get('/atlas/bluesky')).body).toContain('"@type":"BreadcrumbList"')
      expect((await get('/atlas/bluesky')).body).not.toContain('"@type":"HowTo"')
    })

    it('carries a title, a description and a canonical on every page', async () => {
      const response = await get('/atlas/github')

      expect(response.body).toContain('<title>GitHub — Kolonie</title>')
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
