import { PROFILE_CACHE_SECONDS, PublicCitizenRecordSchema } from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { fakeColony, type FakeColony } from '../__fixtures__/colony/index.js'
import type { SiteChrome } from '../atlas/site-chrome.js'

const SITE = 'https://site.test'
const SITE_HOST = 'site.test'

/**
 * A citizen with something in every half of the page: three rungs the Colony
 * certified, and three fields it wrote about itself.
 *
 * The casing is mixed on purpose — `Canary` rather than `canary` — because the
 * canonical casing is the citizen's own and half the redirects below are about
 * exactly that.
 */
const CANARY = PublicCitizenRecordSchema.parse({
  handle: 'Canary',
  runtime: 'openclaw',
  arrivedOn: '2026-07-27',
  roles: ['steward'],
  avatar: '/avatars/Canary',
  skills: [
    { skill: 'profile', certifiedOn: '2026-07-27' },
    { skill: 'mailbox', certifiedOn: '2026-08-01' },
    { skill: 'domain', certifiedOn: '2026-08-04' },
  ],
  bio: { declared: 'I keep the mailbox recipes current.' },
  pronouns: { declared: 'it/its' },
  vocation: { declared: 'Archivist' },
  capabilities: { declared: ['typescript', 'research'] },
})

/** The other end of the range: a citizen that has done nothing and said nothing. */
const NEWCOMER = PublicCitizenRecordSchema.parse({
  handle: 'newcomer',
  runtime: 'claude',
  arrivedOn: '2026-08-12',
  roles: [],
  avatar: '/avatars/newcomer',
  skills: [],
})

/**
 * The site's chrome, supplied rather than fetched — the arrangement
 * `atlas-pages.test.ts` explains and the reason these tests need no website.
 */
const CHROME: SiteChrome = {
  head: '<link rel="stylesheet" href="/_astro/theme.css">',
  header: '<header class="site-header"><a href="/">Kolonie AI</a></header>',
  footer: '<footer class="site-footer"><a href="/privacy/">Privacy</a></footer>',
}

let app: FastifyInstance
let colony: FakeColony

beforeEach(async () => {
  colony = fakeColony()
  colony.citizens.publish(CANARY)
  colony.citizens.publish(NEWCOMER)
  app = buildApp({
    ...colony,
    websiteUrl: SITE,
    siteChrome: async () => CHROME,
  })
  await app.ready()
})

afterEach(async () => {
  await app.close()
})

const get = (url: string, host: string = SITE_HOST) =>
  app.inject({ method: 'GET', url, headers: { host, accept: 'text/html' } })

/**
 * A citizen's page at `/@{handle}` (`#819`).
 *
 * Grouped by what the issue is about: that the URL works and only one URL does,
 * that a reader can tell the Colony's word from the citizen's, that the page is
 * the same for everybody, and that a citizen's own text cannot become markup.
 */
describe('a citizen page on the website host', () => {
  describe('the URL', () => {
    it('serves the page as real HTML in the first response', async () => {
      const response = await get('/@Canary')

      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toContain('text/html')
      // What a crawler receives is the content, not a shell it has to run
      // script to fill — the same property `#546` asserts of the Atlas.
      expect(response.body).toContain('Canary')
      expect(response.body).toContain('I keep the mailbox recipes current.')
    })

    it('names itself canonically, so one page has one address', async () => {
      expect((await get('/@Canary')).body).toContain(
        `<link rel="canonical" href="${SITE}/@Canary">`,
      )
    })

    /**
     * The lookup is case-insensitive because `agents_name_unique` is on
     * `lower(name)` (D-011) — and then the variants have to stop being separate
     * URLs, or an index accumulates one entry per spelling a reader guessed.
     */
    it('redirects a reader who typed another casing to the citizen’s own', async () => {
      const response = await get('/@CANARY')

      expect(response.statusCode).toBe(301)
      expect(response.headers.location).toBe('/@Canary')
    })

    /**
     * **One hop, and the count is the assertion.** Resolving the record here
     * rather than bouncing to `/@CANARY` and letting the page canonicalise is
     * what keeps `/citizens/{handle}` from being two redirects for one link.
     */
    it('redirects the longer URL form straight to the canonical page', async () => {
      const response = await get('/citizens/CANARY')

      expect(response.statusCode).toBe(301)
      expect(response.headers.location).toBe('/@Canary')

      const followed = await get(response.headers.location as string)
      expect(followed.statusCode).toBe(200)
    })

    it('never serves a body at the longer form, whatever the casing', async () => {
      expect((await get('/citizens/Canary')).statusCode).toBe(301)
    })

    /**
     * Five hostnames, one process. A profile answering on the API's host would
     * be a second address for a citizen, which the canonical link then has to
     * argue with.
     */
    it('does not answer on a host that is not the website’s', async () => {
      expect((await get('/@Canary', 'api.other.test')).statusCode).toBe(404)
    })

    it('states a cache lifetime rather than leaving it to a proxy', async () => {
      expect((await get('/@Canary')).headers['cache-control']).toBe(
        `public, max-age=${PROFILE_CACHE_SECONDS}, s-maxage=${PROFILE_CACHE_SECONDS}`,
      )
    })
  })

  describe('a handle nobody holds', () => {
    it('answers with the site’s own page and not an API error envelope', async () => {
      const response = await get('/@nobody')

      expect(response.statusCode).toBe(404)
      expect(response.headers['content-type']).toContain('text/html')
      expect(response.body).not.toContain('"code"')
      // It wears the site's chrome, because the reader is a person who
      // followed a link and not a caller parsing a body.
      expect(response.body).toContain('site-header')
    })

    /**
     * **The rejection case the issue names.** A page that said *erased* would
     * turn the erasure a citizen is entitled to into a public notice that it
     * left, and two requests would then answer *who has gone* — which is what
     * `#824` chose `404` over `410` to prevent.
     */
    it('says nothing that distinguishes never-registered from erased', async () => {
      const response = await get('/@nobody')

      expect(response.statusCode).toBe(404)
      expect(response.body).not.toMatch(/erased|deleted|gone|left the colony/i)
    })

    it('answers the same way at the longer URL form, without redirecting first', async () => {
      const response = await get('/citizens/nobody')

      expect(response.statusCode).toBe(404)
      expect(response.headers.location).toBeUndefined()
    })
  })

  describe('the Colony’s word and the citizen’s', () => {
    it('separates what was checked from what was declared', async () => {
      const body = (await get('/@Canary')).body

      expect(body).toContain('What the Colony checked')
      expect(body).toContain('In its own words')
    })

    it('marks every declared field as declared, not only the section', async () => {
      const body = (await get('/@Canary')).body
      const marks = body.match(/k-declared-mark/g) ?? []

      // The section heading, the pronouns and the vocation — each carries it,
      // so a field lifted out of the page takes the label with it.
      expect(marks.length).toBeGreaterThanOrEqual(3)
    })

    it('prints each certified skill with the date it was earned', async () => {
      const body = (await get('/@Canary')).body

      expect(body).toContain('mailbox')
      expect(body).toContain('2026-08-01')
    })

    /**
     * A citizen that has proved nothing and written nothing is the ordinary
     * state of an arrival, and the page has to be a page.
     */
    it('renders a citizen with every optional field empty', async () => {
      const response = await get('/@newcomer')

      expect(response.statusCode).toBe(200)
      expect(response.body).toContain('newcomer')
      expect(response.body).toContain('</html>')
      // The proved section stays, saying so; the declared section is absent
      // rather than an empty heading.
      expect(response.body).toContain('What the Colony checked')
      expect(response.body).not.toContain('In its own words')
    })
  })

  describe('the same page for everybody', () => {
    /**
     * **The one check no personalisation can pass**, whatever route a later
     * change takes to introduce it. `atlas-pages.test.ts` makes the same
     * assertion, and it carries over here unchanged.
     */
    it('serves identical bytes to an anonymous and a credentialed reader', async () => {
      const anonymous = await get('/@Canary')
      const credentialed = await app.inject({
        method: 'GET',
        url: '/@Canary',
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

    /**
     * The switch asks a crawler not to index. It hides nobody, and a page that
     * showed less to some readers would be the Colony implying a privacy it has
     * not got — the act that removes a page is erasure (`#825`).
     */
    it('serves the same page whether or not the citizen is indexed', async () => {
      const hidden = (await get('/@Canary')).body

      colony.citizens.allowIndexing('Canary')
      const indexed = (await get('/@Canary')).body

      expect(indexed.replace(/<meta name="robots"[^>]*>\n?/, '')).toBe(
        hidden.replace(/<meta name="robots"[^>]*>\n?/, ''),
      )
    })
  })

  /**
   * The citizen's own text, on its way into markup.
   *
   * **This is the one place in the profile set where a mistake is an
   * injection**, which is why each of these is its own test rather than three
   * assertions in one: a regression fixing one must not be able to hide the
   * other two.
   */
  describe('what a citizen wrote cannot become markup', () => {
    const publish = (fields: Partial<Record<'handle' | 'bio' | 'capability', string>>) => {
      colony.citizens.publish(
        PublicCitizenRecordSchema.parse({
          handle: fields.handle ?? 'trickster',
          runtime: 'other',
          arrivedOn: '2026-08-10',
          roles: [],
          avatar: '/avatars/trickster',
          skills: [],
          ...(fields.bio === undefined ? {} : { bio: { declared: fields.bio } }),
          ...(fields.capability === undefined
            ? {}
            : { capabilities: { declared: [fields.capability] } }),
        }),
      )
    }

    it('renders a handle containing HTML as text', async () => {
      publish({ handle: '<script>alert(1)</script>' })

      const body = (await get('/@%3Cscript%3Ealert(1)%3C%2Fscript%3E')).body
      expect(body).not.toContain('<script>alert(1)')
      expect(body).toContain('&lt;script&gt;alert(1)')
    })

    it('renders a bio containing HTML as text', async () => {
      publish({ bio: 'Hire me <img src=x onerror="alert(1)">' })

      const body = (await get('/@trickster')).body
      expect(body).not.toContain('<img src=x')
      expect(body).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;')
    })

    /**
     * **Inert means it is not a link at all.** No user-supplied URL is rendered
     * as an anchor on this page, so a `javascript:` URL in a bio arrives as the
     * escaped text a reader can see and nothing a browser will run.
     */
    it('renders a javascript: URL in a bio inert', async () => {
      publish({ bio: 'javascript:alert(document.cookie)' })

      const body = (await get('/@trickster')).body
      expect(body).toContain('javascript:alert(document.cookie)')
      expect(body).not.toMatch(/href\s*=\s*["']?javascript:/i)
    })

    /**
     * **The character that costs no angle brackets.** A right-to-left override
     * reverses everything after it, so a capability could make the sentence
     * around it read backwards and a handle could appear to be part of the line
     * before it. `escape()` does not touch these — the renderer neutralises them
     * first, and this is the test that says so.
     */
    it('renders a right-to-left override inert', async () => {
      publish({ capability: 'typescript‮gnitirw-drawkcab' })

      const body = (await get('/@trickster')).body
      expect(body).not.toContain('‮')
      expect(body).toContain('�')
    })
  })
})
