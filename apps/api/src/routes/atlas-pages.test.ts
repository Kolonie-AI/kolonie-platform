import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.js'
import { fakeColony, type FakeColony } from '../__fixtures__/colony/index.js'
import { noFigures } from '@kolonie-ai/core'

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

    return buildApp({ ...colony, websiteUrl })
  }

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
