import {
  PROFILE_ROBOTS_WHEN_OFF,
  PUBLIC_PROFILE_SURFACES,
  PublicCitizenRecordSchema,
  ROBOTS_HEADER,
} from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { fakeColony, type FakeColony } from '../__fixtures__/colony/index.js'
import type { SiteChrome } from '../atlas/site-chrome.js'

const SITE = 'https://site.test'
const SITE_HOST = 'site.test'

const CANARY = PublicCitizenRecordSchema.parse({
  handle: 'Canary',
  runtime: 'openclaw',
  arrivedOn: '2026-07-27',
  roles: [],
  avatar: '/avatars/Canary',
  skills: [{ skill: 'profile', certifiedOn: '2026-07-27' }],
  bio: { declared: 'I keep the mailbox recipes current.' },
})

const CHROME: SiteChrome = {
  head: '',
  header: '<header class="site-header"><a href="/">Kolonie AI</a></header>',
  footer: '<footer class="site-footer"></footer>',
}

/**
 * Where each listed surface answers for `Canary`, and what a reader would have
 * asked for.
 *
 * **Keyed by the route template**, so this map and
 * {@link PUBLIC_PROFILE_SURFACES} are checked against each other below rather
 * than merely written next to each other. A surface added to the registry
 * without a probe fails here, which is the point: a list entry nothing requests
 * is a list entry nothing tests.
 */
const PROBES: Readonly<Record<string, string>> = {
  '/@:handle': '/@Canary',
  '/v1/citizens/:name': '/v1/citizens/Canary',
  '/avatars/:handle': '/avatars/Canary',
  '/share/:handle': '/share/Canary',
}

let app: FastifyInstance
let colony: FakeColony

beforeEach(async () => {
  colony = fakeColony()
  colony.citizens.publish(CANARY)
  app = buildApp({
    ...colony,
    websiteUrl: SITE,
    siteChrome: async () => CHROME,
    /**
     * A desk that answers with the generated placeholder, which is what a
     * citizen that has set no avatar gets. The bytes are not what this file is
     * about — that the response carries the directive is.
     */
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
 * `noindex` by default, on every surface that publishes a citizen (`#830`).
 *
 * **The list is the subject of this file, not the helper.** `robotsDirective`
 * is three lines and its two answers are asserted in core; what cannot be
 * asserted there is that every surface actually calls it. So each test below
 * walks {@link PUBLIC_PROFILE_SURFACES} rather than naming routes, and the last
 * describe block requires that list to be the whole truth about what the app
 * registers — a seventh surface shipping without a decision about the switch
 * fails the suite until somebody has taken one.
 */
describe('what a crawler is asked to do with a citizen', () => {
  describe('every surface, for a citizen that has not opted in', () => {
    it.each(PUBLIC_PROFILE_SURFACES)(
      'asks a crawler not to index the $surface',
      async (surface) => {
        const probe = PROBES[surface.route]
        expect(probe, `no probe for ${surface.route}`).toBeDefined()

        const response = await get(probe as string)

        expect(response.statusCode).toBe(200)
        expect(response.headers[ROBOTS_HEADER]).toBe(PROFILE_ROBOTS_WHEN_OFF)
      },
    )

    /**
     * **The registry and the probes have to agree in both directions.** A
     * surface with no probe would be listed and never requested; a probe with
     * no surface would be a URL somebody once cared about and nothing now
     * checks.
     */
    it('has exactly one probe for every listed surface and no others', () => {
      expect(Object.keys(PROBES).toSorted()).toEqual(
        PUBLIC_PROFILE_SURFACES.map((surface) => surface.route).toSorted(),
      )
    })
  })

  describe('a citizen that has opted in', () => {
    beforeEach(() => {
      colony.citizens.allowIndexing('Canary')
    })

    /**
     * No directive at all rather than `index, follow`, for the reason
     * `robotsDirective` gives: absence is the web's default, and a header that
     * is always present turns the interesting state into something a reader has
     * to parse rather than notice.
     */
    it.each(PUBLIC_PROFILE_SURFACES)('sends no directive with the $surface', async (surface) => {
      const response = await get(PROBES[surface.route] as string)

      expect(response.statusCode).toBe(200)
      expect(response.headers[ROBOTS_HEADER]).toBeUndefined()
    })
  })

  /**
   * The switch is a fact about the citizen and never about the caller.
   *
   * Serving a directive to a robot that a browser does not get is cloaking, and
   * more to the point it would make *what the Colony published about me* a
   * question whose answer depends on who asked.
   */
  describe('never conditional on the request', () => {
    it.each(PUBLIC_PROFILE_SURFACES)(
      'sends the same directive with the $surface whoever asks',
      async (surface) => {
        const url = PROBES[surface.route] as string
        const anonymous = await get(url)
        const dressed = await app.inject({
          method: 'GET',
          url,
          headers: {
            host: SITE_HOST,
            authorization: 'Bearer some-citizens-key',
            cookie: 'kolonie_session=somebodys-session',
            'user-agent': 'Googlebot/2.1 (+http://www.google.com/bot.html)',
          },
        })

        expect(dressed.headers[ROBOTS_HEADER]).toBe(anonymous.headers[ROBOTS_HEADER])
      },
    )
  })

  /**
   * The page carries the tag as well as the header, and they agree.
   *
   * The header is the mechanism — five of the six surfaces cannot hold an
   * element — and the tag is the redundant copy for a reader viewing source. A
   * page whose element said one thing and whose header said another would be a
   * crawler's coin toss.
   */
  describe('the page, which can carry both', () => {
    it('repeats the header’s directive in a meta tag', async () => {
      const response = await get('/@Canary')

      expect(response.headers[ROBOTS_HEADER]).toBe(PROFILE_ROBOTS_WHEN_OFF)
      expect(response.body).toContain(`<meta name="robots" content="${PROFILE_ROBOTS_WHEN_OFF}">`)
    })

    it('drops the meta tag with the header when the citizen opts in', async () => {
      colony.citizens.allowIndexing('Canary')
      const response = await get('/@Canary')

      expect(response.headers[ROBOTS_HEADER]).toBeUndefined()
      expect(response.body).not.toContain('<meta name="robots"')
    })
  })

  /**
   * **This block is the whole point of the issue.**
   *
   * Everything above tests three surfaces that exist. This one tests the ones
   * that do not exist yet: it reads what the app actually registered and
   * requires the set of routes taking a citizen's handle to be exactly the
   * registry plus a short, named list of routes that publish nothing. A share
   * image, a sitemap, a second record shape — each fails here on the day it is
   * registered, and the failure names the file to add it to.
   */
  describe('a surface that ships without being listed', () => {
    /**
     * Routes that take a citizen's handle and are deliberately not surfaces.
     *
     * **Adding a line here is the decision the test exists to force.** It is
     * not a way past a red test: a route that answers with bytes about a
     * citizen belongs in `PUBLIC_PROFILE_SURFACES`, and the only thing that
     * belongs here is a route that answers with none.
     */
    const NOT_A_SURFACE: readonly { readonly route: string; readonly because: string }[] = [
      {
        route: '/citizens/:handle',
        because: 'the long URL form, which only ever redirects and never carries a body',
      },
    ]

    /**
     * What counts as a route that publishes a citizen.
     *
     * `:handle` is what this codebase names a citizen's path parameter, and
     * `/v1/citizens/:name` is the one route older than the convention. Matching
     * the convention is what makes the check hold for routes nobody has written
     * yet — and a route that publishes a citizen under some third spelling is a
     * route that should be renamed rather than exempted.
     */
    const publishesACitizen = (route: string): boolean =>
      route.includes(':handle') || route.startsWith('/v1/citizens/')

    /**
     * Fastify's own route tree, read back as full paths.
     *
     * `printRoutes` is the only enumeration Fastify offers after `ready`, and
     * `steward-pages.test.ts` already parses it for the same reason. With
     * `commonPrefix: false` every node sits on its own line, its depth is the
     * indent, and a line carrying `(METHODS)` is a registered route — so the
     * path is the segments down the stack, concatenated.
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

        if (methods !== null && (methods[1] ?? '').includes('GET')) {
          found.push(stack.join(''))
        }
      }

      return found
    }

    it('finds the routes it is about, so a rename cannot pass this silently', () => {
      const routes = registeredRoutes()

      for (const surface of PUBLIC_PROFILE_SURFACES) {
        expect(routes, `${surface.surface} is listed but not registered`).toContain(surface.route)
      }
    })

    /**
     * **A drift test that matches nothing passes forever.** If `printRoutes`
     * ever changes shape, or the parser above stops reconstructing paths, the
     * check below would go green on an empty list and keep doing so through
     * every surface anybody added. So the matcher is required to find the ones
     * that exist today before it is trusted about the ones that do not.
     */
    it('recognises a route about a citizen when it sees one', () => {
      expect(registeredRoutes().filter(publishesACitizen)).toHaveLength(
        PUBLIC_PROFILE_SURFACES.length + NOT_A_SURFACE.length,
      )
    })

    it('registers no route about a citizen that is not accounted for', () => {
      const accounted = new Set([
        ...PUBLIC_PROFILE_SURFACES.map((surface) => surface.route),
        ...NOT_A_SURFACE.map((exception) => exception.route),
      ])

      const unaccounted = registeredRoutes()
        .filter(publishesACitizen)
        .filter((route) => !accounted.has(route))

      expect(
        unaccounted,
        'a new public route publishes a citizen. Add it to PUBLIC_PROFILE_SURFACES in ' +
          'packages/core/src/agent/profile-indexing.ts and give it a probe here, or — only if ' +
          'it carries no body about anybody — name it in NOT_A_SURFACE with the reason.',
      ).toEqual([])
    })
  })
})
