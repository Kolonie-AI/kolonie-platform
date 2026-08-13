import { PublicCitizenRecordSchema, PUBLIC_PROFILE_SURFACES } from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { fakeColony, type FakeColony } from '../__fixtures__/colony/index.js'
import type { SiteChrome } from '../atlas/site-chrome.js'

const SITE = 'https://site.test'
const SITE_HOST = 'site.test'

const CHROME: SiteChrome = { head: '', header: '', footer: '' }

/**
 * Three citizens, so that *this response is about one of them* is a claim with
 * something to fail against. One published citizen would make every assertion
 * below vacuously true.
 */
const CITIZENS = ['Canary', 'Kestrel', 'Wren'].map((handle) =>
  PublicCitizenRecordSchema.parse({
    handle,
    runtime: 'openclaw',
    arrivedOn: '2026-07-27',
    roles: [],
    avatar: `/avatars/${handle}`,
    skills: [{ skill: 'profile', certifiedOn: '2026-07-27' }],
    bio: { declared: `I am ${handle} and I keep the recipes current.` },
  }),
)

/**
 * What a reader asks each listed surface for, keyed by the route template.
 *
 * Kept in step with {@link PUBLIC_PROFILE_SURFACES} by the test below, on the
 * same terms `profile-indexing.test.ts` keeps its own probes: a surface with no
 * probe is a surface nothing here requests.
 */
const PROBES: Readonly<Record<string, string>> = {
  '/@:handle': '/@Canary',
  '/v1/citizens/:name': '/v1/citizens/Canary',
  '/avatars/:handle': '/avatars/Canary',
  '/share/:handle': '/share/Canary',
}

/**
 * The parameters a listing surface would need, and none of them belongs here.
 *
 * Every one of these is something somebody will reasonably want one day — a
 * paged directory, a type-ahead, a count for a landing page. The point of
 * sending them all at once is that the answer must be **identical to the answer
 * with none of them**, so that adding support for one is a visible change to
 * this file rather than a quiet widening of what the tier does.
 */
const LISTING_PARAMETERS =
  '?limit=50&count=50&page=2&offset=10&cursor=eyJ0IjoxfQ&prefix=Ca&q=Ca&search=Ca&' +
  'sort=arrivedOn&order=desc&fields=handle&all=true&format=json'

let app: FastifyInstance
let colony: FakeColony

beforeEach(async () => {
  colony = fakeColony()
  for (const record of CITIZENS) colony.citizens.publish(record)
  app = buildApp({
    ...colony,
    websiteUrl: SITE,
    siteChrome: async () => CHROME,
    avatars: {
      publicAvatar: async (handle) =>
        (await colony.citizens.publicRecord(handle)) === undefined
          ? { outcome: 'unknown-citizen' }
          : { outcome: 'placeholder', handle },
    },
  })
  await app.ready()
})

afterEach(async () => {
  await app.close()
})

const get = (url: string) => app.inject({ method: 'GET', url, headers: { host: SITE_HOST } })

/**
 * **The public profile tier answers about a name, and never about the set of
 * names** (`#828`).
 *
 * This file is the standing assertion of that, and it is the artefact `#828` is
 * really for: it fails when somebody later adds the convenient `?limit=` that
 * would end the doctrine. Everything it checks is already true today — which is
 * exactly why it is worth writing down, because the change that breaks it will
 * look like a small feature and will not look like a decision.
 *
 * ## What is defended, and what is honestly not
 *
 * `GET /@{handle}` answers `200` for a citizen that exists and `404` for one
 * that does not, so **it is an existence oracle** and nothing here pretends
 * otherwise. `PROFILE_TIER_LIMIT` bounds the rate at which that question can be
 * asked and does not close it — the same position `NAME_CHECK_LIMIT` takes about
 * the same question asked at a different door.
 *
 * What *is* closed is the cheap route: no parameter widens an answer, no
 * response mentions a citizen other than the one asked about, no route matches
 * more than a single handle, and there is no route anywhere that takes no handle
 * at all. An enumerator has to guess names one at a time, against a limiter,
 * with no feedback about how close a guess was. Three existing refusals say the
 * same thing at other doors and none of them is softened: `kolonie-website#8`
 * and `#19` on the population count, `routes/badges.ts`, `routes/attribution.ts`.
 */
describe('what the public profile tier says about who exists', () => {
  it('has one probe for every listed surface and no others', () => {
    expect(Object.keys(PROBES).toSorted()).toEqual(
      PUBLIC_PROFILE_SURFACES.map((surface) => surface.route).toSorted(),
    )
  })

  /**
   * **The parameter test.** A query string that would mean something to a
   * listing endpoint has to mean nothing here — not *be rejected*, which would
   * itself be a signal, but be ignored down to the byte.
   */
  describe('a query string that asks for a list', () => {
    it.each(PUBLIC_PROFILE_SURFACES)(
      'answers the $surface exactly as it would with no parameters at all',
      async (surface) => {
        const probe = PROBES[surface.route] as string

        const plain = await get(probe)
        const asked = await get(`${probe}${LISTING_PARAMETERS}`)

        expect(asked.statusCode).toBe(plain.statusCode)
        expect(asked.rawPayload.equals(plain.rawPayload)).toBe(true)
      },
    )
  })

  /**
   * A prefix is the enumerator's first try, because it turns one guess into a
   * branch of the search tree. Every one of these is a handle nobody holds, and
   * the tier must treat it as exactly that rather than as a pattern.
   */
  describe('a handle that is a pattern rather than a name', () => {
    const PATTERNS = ['Ca', 'Can*', '*', '_anary', 'Can%25', 'Canary.', 'Canary%20']

    it.each(PATTERNS)('does not match a citizen for %s', async (pattern) => {
      const page = await get(`/@${pattern}`)
      const record = await get(`/v1/citizens/${pattern}`)

      expect(page.statusCode, `page for ${pattern}`).toBe(404)
      expect(record.statusCode, `record for ${pattern}`).toBe(404)
    })

    /**
     * A lone `%` is not a bad handle, it is a bad URL: the escape has no digits
     * after it, so nothing can decode the path and the `400` comes from below the
     * router. **Asserted rather than folded into the `404`s above**, because the
     * two are different sentences — *no such citizen* and *that is not an
     * address* — and a day when this starts answering `404` is a day the path is
     * being decoded more leniently than it was, which is worth a failing test.
     */
    it.each(['%', 'Canary%'])('refuses %s as a URL rather than answering about it', async (bad) => {
      expect((await get(`/@${bad}`)).statusCode, `page for ${bad}`).toBe(400)
      expect((await get(`/v1/citizens/${bad}`)).statusCode, `record for ${bad}`).toBe(400)
    })

    /**
     * The rejection case's own rejection case: the exact handle must still
     * resolve, or the block above would pass on a tier that had stopped
     * answering altogether.
     */
    it('still answers for the whole handle', async () => {
      expect((await get('/@Canary')).statusCode).toBe(200)
      expect((await get('/v1/citizens/Canary')).statusCode).toBe(200)
    })
  })

  /**
   * One answer is about one citizen. A response that mentioned a second — in a
   * body, a header, a link, a *see also* — would be a directory that had grown
   * one entry at a time.
   */
  describe('an answer about one citizen', () => {
    it.each(PUBLIC_PROFILE_SURFACES)('names no other citizen in the $surface', async (surface) => {
      const response = await get(PROBES[surface.route] as string)
      const wholeResponse = `${JSON.stringify(response.headers)}\n${response.body}`

      for (const other of ['Kestrel', 'Wren']) {
        expect(wholeResponse, `${surface.surface} mentions ${other}`).not.toContain(other)
      }
    })

    /**
     * And the matcher is checked before it is trusted: if the assembled string
     * were empty, or the handles were spelled differently in the fixture, the
     * block above would pass on every surface forever.
     */
    it('would notice a handle in a response, so the check above means something', async () => {
      const response = await get('/@Canary')

      expect(`${JSON.stringify(response.headers)}\n${response.body}`).toContain('Canary')
    })
  })

  /**
   * **The structural half, and the one that outlives the assertions above.**
   *
   * A future listing route would not have to break any test here — it would
   * simply be a new route. So this block reads what the app actually registered
   * and requires every route in the citizen namespaces to carry exactly one
   * parameter: a collection endpoint has none, and a route with two is a route
   * that relates citizens to each other.
   */
  describe('the shape of what is registered', () => {
    /**
     * Fastify's own route tree, read back as full paths — the same parser
     * `profile-indexing.test.ts` uses, and for the same reason: `printRoutes` is
     * the only enumeration Fastify offers after `ready`.
     */
    const registeredRoutes = (): readonly string[] => {
      const stack: string[] = []
      const found: string[] = []

      for (const line of app.printRoutes({ commonPrefix: false }).split('\n')) {
        const marker = line.indexOf('── ')
        if (marker === -1) continue

        const depth = (marker - 1) / 4
        const rest = line.slice(marker + 3)
        const methods = /\s\(([A-Z, ]+)\)$/.exec(rest)

        stack[depth] = methods === null ? rest : rest.slice(0, methods.index)
        stack.length = depth + 1

        if (methods !== null) found.push(stack.join(''))
      }

      return found
    }

    /** Everywhere a citizen is addressed by name: the two prefixes and the avatars. */
    const inTheCitizenNamespace = (route: string): boolean =>
      route.startsWith('/@') ||
      route.startsWith('/citizens/') ||
      route.startsWith('/v1/citizens') ||
      route.startsWith('/avatars') ||
      route.startsWith('/share')

    const parametersIn = (route: string): number =>
      route.split('/').filter((segment) => segment.includes(':') || segment.startsWith('*')).length

    it('finds the routes it is about', () => {
      expect(registeredRoutes().filter(inTheCitizenNamespace).length).toBeGreaterThanOrEqual(
        PUBLIC_PROFILE_SURFACES.length,
      )
    })

    /**
     * **The line that fails on the day somebody adds the directory.** A route
     * with no parameter in the citizen namespace is a collection: `/v1/citizens`,
     * `/citizens/`, `/avatars`. There is no acceptable one, which is why the
     * expectation is an empty list rather than an allowlist.
     */
    it('registers no route that addresses citizens without naming one', () => {
      const collections = registeredRoutes()
        .filter(inTheCitizenNamespace)
        .filter((route) => parametersIn(route) === 0)

      expect(
        collections,
        'a route in the citizen namespace takes no handle, which makes it a directory. ' +
          'The Colony answers about a name and never about the set of names — see ' +
          'routes/profile-tier.ts and routes/citizens.ts for the argument.',
      ).toEqual([])
    })

    it('registers no route that names more than one citizen at a time', () => {
      const plural = registeredRoutes()
        .filter(inTheCitizenNamespace)
        .filter((route) => parametersIn(route) > 1)

      expect(plural, 'a citizen route takes two parameters, so it relates citizens').toEqual([])
    })

    /**
     * A wildcard would match `/@` followed by anything, including nothing, which
     * is a collection wearing a parameter's clothes.
     */
    it('matches a handle with a parameter and never with a wildcard', () => {
      for (const route of registeredRoutes().filter(inTheCitizenNamespace)) {
        expect(route, `${route} matches by wildcard`).not.toContain('*')
      }
    })
  })
})
