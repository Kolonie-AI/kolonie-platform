import {
  PUBLIC_PROFILE_SURFACES,
  PublicCitizenRecordSchema,
  avatarPath,
  citizenRecordPath,
  profilePath,
} from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { fakeColony, type FakeColony } from '../__fixtures__/colony/index.js'
import type { SiteChrome } from '../atlas/site-chrome.js'

const SITE = 'https://site.test'
const SITE_HOST = 'site.test'

/**
 * A citizen with something on every surface, so that every surface has something
 * to stop answering with.
 *
 * The bio is a sentence nothing else in this file contains, which is what lets
 * the assertions below look for it in whole response bodies rather than in
 * parsed fields — a leak that survives an erasure will not be in the field
 * somebody thought to check.
 */
const CANARY = PublicCitizenRecordSchema.parse({
  handle: 'Canary',
  runtime: 'openclaw',
  arrivedOn: '2026-07-27',
  roles: ['steward'],
  avatar: '/avatars/Canary',
  skills: [{ skill: 'profile', certifiedOn: '2026-07-27' }],
  bio: { declared: 'I keep the mailbox recipes current.' },
  vocation: { declared: 'Archivist' },
})

/** Bytes nothing generates, so finding them means the real avatar was served. */
const AVATAR_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x42, 0x42])

const CHROME: SiteChrome = {
  head: '',
  header: '<header class="site-header"><a href="/">Kolonie AI</a></header>',
  footer: '<footer class="site-footer"></footer>',
}

/**
 * Where each listed surface answers for `Canary`, built from the same helpers
 * the receipt uses rather than typed out.
 *
 * **Keyed by the route template**, so this map and {@link PUBLIC_PROFILE_SURFACES}
 * are checked against each other below. `#820` adds two more surfaces; a surface
 * that ships without an entry here fails this file, which is the only mechanism
 * that makes *every* surface a claim rather than a hope.
 */
const PROBES: Readonly<Record<string, string>> = {
  '/@:handle': profilePath(CANARY.handle),
  '/v1/citizens/:name': citizenRecordPath(CANARY.handle),
  '/avatars/:handle': avatarPath(CANARY.handle),
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
     * A desk that serves a real image rather than the placeholder, because the
     * question here is whether *bytes about this citizen* stop being served. A
     * placeholder is derived from the handle and would leave the test asserting
     * something weaker than it looks.
     */
    avatars: {
      publicAvatar: async (handle) =>
        (await colony.citizens.publicRecord(handle)) === undefined
          ? { outcome: 'unknown-citizen' }
          : { outcome: 'image', avatar: { bytes: AVATAR_BYTES, format: 'png' } },
    },
  })
  await app.ready()
})

afterEach(async () => {
  await app.close()
})

const get = (url: string) => app.inject({ method: 'GET', url, headers: { host: SITE_HOST } })

/**
 * What an erasure does to the surfaces that publish a citizen (`#825`).
 *
 * **The removal is one delete and this file is the proof of it.** `eraseAgent`
 * issues exactly one `delete(agents)`; the page, the record and the avatar all
 * derive from that row, so they go together by construction rather than by three
 * pieces of cleanup code that could each be forgotten. What construction does not
 * prove is that no fourth surface was added since, or that a body which no longer
 * has a citizen behind it has stopped carrying what the citizen wrote — and those
 * are the two things asserted here.
 *
 * `withdraw` on the fake is that delete, seen from the route's side: the record
 * is gone and the indexing switch with it, which is the only state production
 * can be in afterwards.
 */
describe('a citizen that has erased itself', () => {
  describe('while it is still here', () => {
    /**
     * The control, and it is not a formality. Every assertion below is that
     * something is *absent*, and an absence proves nothing unless the same
     * request produced a presence a moment earlier — a typo in a probe URL would
     * otherwise pass the whole file.
     */
    it.each(PUBLIC_PROFILE_SURFACES)('answers on the $surface', async (surface) => {
      const probe = PROBES[surface.route]
      expect(probe, `no probe for ${surface.route}`).toBeDefined()

      const response = await get(probe as string)

      expect(response.statusCode).toBe(200)
    })

    it('serves what the citizen wrote and the bytes of its avatar', async () => {
      expect((await get(PROBES['/@:handle'] as string)).body).toContain(
        'I keep the mailbox recipes current.',
      )
      expect((await get(PROBES['/avatars/:handle'] as string)).rawPayload).toEqual(
        Buffer.from(AVATAR_BYTES),
      )
    })
  })

  describe('once it is gone', () => {
    beforeEach(() => {
      colony.citizens.withdraw(CANARY.handle)
    })

    /**
     * **404 and not 410**, on every one of them.
     *
     * `410 Gone` is the status that means *there was something here*, and that
     * is precisely the sentence an erasure exists to stop the Colony saying. A
     * departed citizen and a handle nobody ever registered have to be one
     * answer, or the erased set is readable by asking for names — see
     * `handle-lifecycle.test.ts`, which makes the same argument at the front
     * door.
     */
    it.each(PUBLIC_PROFILE_SURFACES)('stops answering on the $surface', async (surface) => {
      const response = await get(PROBES[surface.route] as string)

      expect(response.statusCode).toBe(404)
    })

    /**
     * The same answer as a name nobody ever held, byte for byte on the two
     * surfaces that return a body a caller can compare.
     *
     * The page is excluded because it renders chrome with the requested handle
     * in the title of the not-found page, which is a reflection of the request
     * rather than a fact about a citizen — and the assertion after this one is
     * what pins that the page says nothing more.
     */
    it('answers as it does for a name nobody ever held', async () => {
      for (const route of ['/v1/citizens/:name', '/avatars/:handle'] as const) {
        const erased = await get(PROBES[route] as string)
        const stranger = await get((PROBES[route] as string).replace('Canary', 'nobody-at-all'))

        expect(erased.statusCode).toBe(stranger.statusCode)
        expect(erased.body).toEqual(stranger.body)
      }
    })

    /**
     * **Nothing the citizen wrote survives in any body**, which is the assertion
     * the 404s do not make on their own: a not-found page that echoed the bio out
     * of a cache, or an avatar route that fell back to the placeholder, would be
     * four green status codes and a leak.
     *
     * The handle itself is not on this list, and deliberately: it is in the URL
     * the reader just typed, so a page that prints it back has published nothing
     * the reader did not already have. What must not survive is what only the
     * Colony held.
     */
    it.each(PUBLIC_PROFILE_SURFACES)(
      'carries nothing the citizen wrote on the $surface',
      async (surface) => {
        const response = await get(PROBES[surface.route] as string)
        const body = response.rawPayload.toString('latin1')

        expect(body).not.toContain('I keep the mailbox recipes current.')
        expect(body).not.toContain('Archivist')
        expect(body).not.toContain('steward')
        expect(response.rawPayload.includes(Buffer.from(AVATAR_BYTES))).toBe(false)
      },
    )

    /** A surface added without a probe would be untested by every case above. */
    it('has exactly one probe for every listed surface and no others', () => {
      expect(Object.keys(PROBES).toSorted()).toEqual(
        PUBLIC_PROFILE_SURFACES.map((surface) => surface.route).toSorted(),
      )
    })
  })
})
