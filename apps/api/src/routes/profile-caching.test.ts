import {
  PROFILE_CACHE_SECONDS,
  PROFILE_ROBOTS_WHEN_OFF,
  PUBLIC_PROFILE_SURFACES,
  PublicCitizenRecordSchema,
  ROBOTS_HEADER,
  longestProfileCacheSeconds,
} from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import type { Response as LightMyRequestResponse } from 'light-my-request'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { fixedWindowLimiter } from '../rate-limit.js'
import { fakeColony, type FakeColony } from '../__fixtures__/colony/index.js'
import type { SiteChrome } from '../atlas/site-chrome.js'

const SITE = 'https://site.test'
const SITE_HOST = 'site.test'

const CHROME: SiteChrome = { head: '', header: '', footer: '' }

const CANARY = PublicCitizenRecordSchema.parse({
  handle: 'Canary',
  runtime: 'openclaw',
  arrivedOn: '2026-07-27',
  roles: [],
  avatar: '/avatars/Canary',
  skills: [{ skill: 'profile', certifiedOn: '2026-07-27' }],
  bio: { declared: 'I keep the mailbox recipes current.' },
})

/** Where each listed surface answers, keyed by route template as elsewhere. */
const PROBES: Readonly<Record<string, string>> = {
  '/@:handle': '/@Canary',
  '/v1/citizens/:name': '/v1/citizens/Canary',
  '/avatars/:handle': '/avatars/Canary',
}

/** Three requests to the ceiling, so a rejection case costs three lines. */
const LIMIT = 3

let app: FastifyInstance
let colony: FakeColony

beforeEach(async () => {
  colony = fakeColony()
  colony.citizens.publish(CANARY)
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
    profileTier: { limiter: fixedWindowLimiter({ limit: LIMIT, windowMs: 60_000 }) },
  })
  await app.ready()
})

afterEach(async () => {
  await app.close()
})

/**
 * A request from one caller. `x-forwarded-for` is what `clientIp` keys on, so
 * naming it here is how one test reaches the ceiling without the next one
 * inheriting an exhausted allowance.
 */
const get = (url: string, from = '198.51.100.7', headers: Record<string, string> = {}) =>
  app.inject({
    method: 'GET',
    url,
    headers: { host: SITE_HOST, 'x-forwarded-for': from, ...headers },
  })

/** `max-age=60` out of `public, max-age=60, s-maxage=60`, or `undefined`. */
const maxAge = (response: LightMyRequestResponse): number | undefined => {
  const header = response.headers['cache-control']
  const found = /max-age=(\d+)/.exec(typeof header === 'string' ? header : '')

  return found === null ? undefined : Number(found[1])
}

/**
 * The end-to-end headers of a response, as a cache or a reverse proxy would pass
 * them on.
 *
 * **RFC 9110 §7.6.1**: the listed fields are connection-specific and a proxy
 * strips them, so a header this drops is a header the reader at the far end of a
 * CDN never sees. The point of running an assertion through this rather than
 * over `response.headers` directly is that `x-robots-tag` is only a real defence
 * if it is *not* one of them — a directive that a proxy eats is a directive that
 * protects the origin's own callers and nobody else's.
 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

type Headers = Readonly<Record<string, string | string[] | number | undefined>>

const throughAProxy = (sent: Headers): Headers => {
  /** `Connection: keep-alive, x-thing` names further fields to strip. */
  const named = new Set(
    String(sent['connection'] ?? '')
      .split(',')
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token !== ''),
  )

  return Object.fromEntries(
    Object.entries(sent).filter(
      ([header]) => !HOP_BY_HOP.has(header.toLowerCase()) && !named.has(header.toLowerCase()),
    ),
  )
}

/**
 * How long a copy of a citizen may live, and what a cache is told about it
 * (`#828`).
 *
 * ## Why this is a test and not three comments
 *
 * `#825` prints a delay in the erasure receipt: *the copies the Colony controls
 * are gone within this*. That sentence is only true if no public surface is
 * cached for longer than the number in it — and the three surfaces set their
 * headers in three different files, from constants in a fourth. Nothing failed
 * when they disagreed; the receipt simply became false. So the registry
 * `PUBLIC_PROFILE_SURFACES` declares a lifetime per surface, `#825` prints
 * `longestProfileCacheSeconds()`, and **this file is where the declared numbers
 * are made to equal the headers actually sent**.
 *
 * ## And why the proxy round trip
 *
 * `#830` made `noindex` the default, which is only worth anything if the
 * directive reaches a crawler. A crawler is usually behind a CDN. So every
 * assertion about `x-robots-tag` here is made against
 * {@link throughAProxy}-filtered headers rather than the raw reply: a directive
 * that would be stripped in transit fails here rather than in an index.
 */
describe('what a cache is allowed to keep about a citizen', () => {
  describe('the lifetime on each surface', () => {
    it.each(PUBLIC_PROFILE_SURFACES)(
      'sends the $surface with exactly the lifetime the registry declares',
      async (surface) => {
        const response = await get(PROBES[surface.route] as string)

        expect(response.statusCode).toBe(200)
        expect(maxAge(response), `${surface.surface} cache-control`).toBe(surface.cacheSeconds)
      },
    )

    /**
     * The property `#825` actually depends on, asserted against the wire rather
     * than against the registry — the registry's own copy is checked in
     * `packages/core/src/agent/profile-indexing.test.ts`, and this is the half
     * that would catch a route that ignored it.
     */
    it('holds nothing longer than the delay the erasure receipt promises', async () => {
      for (const surface of PUBLIC_PROFILE_SURFACES) {
        const response = await get(PROBES[surface.route] as string)

        expect(maxAge(response) ?? 0, surface.surface).toBeLessThanOrEqual(
          longestProfileCacheSeconds(),
        )
      }
    })

    /**
     * **The redirect is a cached copy of a citizen too**, and it was the one
     * without a lifetime until `#828`. Its `location` carries the citizen's exact
     * registered casing, so an indefinitely cached `301` would go on answering
     * *there is a citizen and this is how it spells its name* after the page and
     * the record had both stopped.
     */
    it.each(['/@CANARY', '/citizens/Canary'])('puts a lifetime on the 301 from %s', async (url) => {
      const response = await get(url)

      expect(response.statusCode).toBe(301)
      expect(response.headers['location']).toBe('/@Canary')
      expect(maxAge(response)).toBe(PROFILE_CACHE_SECONDS)
    })

    /**
     * A miss must not be cached as though it were an answer: a handle registered
     * a second after somebody looked for it would otherwise stay *not held* for
     * as long as the page it is about would have been kept.
     */
    it('does not let a 404 outlive the answer it stands in for', async () => {
      const response = await get('/@NoSuchCitizen')

      expect(response.statusCode).toBe(404)
      expect(maxAge(response) ?? 0).toBeLessThanOrEqual(PROFILE_CACHE_SECONDS)
    })
  })

  describe('the indexing directive as a reader behind a CDN sees it', () => {
    it.each(PUBLIC_PROFILE_SURFACES)(
      'keeps the directive on the $surface through a proxy',
      async (surface) => {
        const response = await get(PROBES[surface.route] as string)

        expect(throughAProxy(response.headers)[ROBOTS_HEADER]).toBe(PROFILE_ROBOTS_WHEN_OFF)
      },
    )

    /**
     * The rejection case for the filter itself. If `throughAProxy` returned its
     * input unchanged the block above would pass on a response whose directive a
     * real proxy would strip, so the filter is required to actually drop
     * something.
     */
    it('drops a hop-by-hop header, so the check above is doing work', async () => {
      const response = await get('/@Canary')
      const passedOn = throughAProxy({
        ...response.headers,
        connection: 'keep-alive',
        'keep-alive': 'timeout=5',
      })

      expect(passedOn['keep-alive']).toBeUndefined()
      expect(passedOn['connection']).toBeUndefined()
      expect(passedOn[ROBOTS_HEADER]).toBe(PROFILE_ROBOTS_WHEN_OFF)
    })

    it('stops asking for noindex once the citizen has opted in', async () => {
      colony.citizens.allowIndexing('Canary')

      expect(throughAProxy((await get('/@Canary')).headers)[ROBOTS_HEADER]).toBeUndefined()
    })
  })

  describe('a caller over the ceiling', () => {
    const exhaust = async (from: string): Promise<void> => {
      for (let taken = 0; taken < LIMIT; taken += 1) await get('/@Canary', from)
    }

    it('refuses with the wait, and does not let the refusal be cached', async () => {
      const from = '203.0.113.10'
      await exhaust(from)

      const refused = await get('/@Canary', from)

      expect(refused.statusCode).toBe(429)
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0)
      expect(refused.headers['cache-control']).toBe('no-store')
      expect(refused.json()).toMatchObject({ code: 'rate_limited' })
    })

    /**
     * **The reason the brake runs before the lookup.** Over the limit, a handle
     * somebody holds and one nobody holds have to be one answer — otherwise the
     * refusal is a cheaper existence oracle than the thing it is refusing.
     */
    it('answers a held and an unheld handle identically once it is refusing', async () => {
      const from = '203.0.113.11'
      await exhaust(from)

      const held = await get('/@Canary', from)
      const unheld = await get('/@NoSuchCitizen', from)

      expect(held.statusCode).toBe(unheld.statusCode)
      expect(held.rawPayload.equals(unheld.rawPayload)).toBe(true)
    })

    /** One allowance for the tier: the record and the avatar spend the page's. */
    it('spends one allowance across the page, the record and the avatar', async () => {
      const from = '203.0.113.12'

      expect((await get('/@Canary', from)).statusCode).toBe(200)
      expect((await get('/v1/citizens/Canary', from)).statusCode).toBe(200)
      expect((await get('/avatars/Canary', from)).statusCode).toBe(200)

      expect((await get('/@Canary', from)).statusCode).toBe(429)
    })

    it('leaves the next caller its own allowance', async () => {
      await exhaust('203.0.113.13')

      expect((await get('/@Canary', '203.0.113.14')).statusCode).toBe(200)
    })

    /**
     * A wrong-host request is charged too. It reaches the handler, so a ceiling
     * that skipped it would be one number for the website's host and no number at
     * all for the other four the process answers on.
     */
    it('charges a request on the wrong host rather than serving it free', async () => {
      const from = '203.0.113.15'
      for (let taken = 0; taken < LIMIT; taken += 1) {
        await app.inject({
          method: 'GET',
          url: '/@Canary',
          headers: { host: 'api.test', 'x-forwarded-for': from },
        })
      }

      expect((await get('/@Canary', from)).statusCode).toBe(429)
    })
  })

  /**
   * The tier reads no credential, so a cache keyed on the URL alone is correct —
   * which is only safe while this stays true. `profile-pages.test.ts` asserts it
   * for the page; here it is asserted for the tier, because a record that varied
   * by bearer token would be a record a shared cache would hand to the wrong
   * reader.
   */
  describe('a request carrying a credential', () => {
    it.each(PUBLIC_PROFILE_SURFACES)(
      'answers the $surface byte for byte as it does anonymously',
      async (surface) => {
        const probe = PROBES[surface.route] as string

        const anonymous = await get(probe, '203.0.113.20')
        const credentialed = await get(probe, '203.0.113.21', {
          authorization: 'Bearer not-a-real-key',
          cookie: 'kolonie_console=not-a-real-session',
        })

        expect(credentialed.statusCode).toBe(anonymous.statusCode)
        expect(credentialed.rawPayload.equals(anonymous.rawPayload)).toBe(true)
        expect(credentialed.headers['vary']).toBe(anonymous.headers['vary'])
      },
    )
  })

  /**
   * The whole point of the numbers above: once the citizen is gone, every
   * surface is a miss, and the longest a stale copy can be out there is the
   * figure the receipt gave.
   */
  describe('a citizen that has erased itself', () => {
    it.each(PUBLIC_PROFILE_SURFACES)('stops answering on the $surface', async (surface) => {
      colony.citizens.withdraw('Canary')

      const response = await get(PROBES[surface.route] as string)

      expect(response.statusCode).toBe(404)
    })

    it('stops redirecting to the casing it registered under', async () => {
      colony.citizens.withdraw('Canary')

      expect((await get('/@CANARY')).statusCode).toBe(404)
      expect((await get('/citizens/Canary')).statusCode).toBe(404)
    })
  })
})
