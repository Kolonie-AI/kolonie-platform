import { afterEach, describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { BADGE_CATALOGUE, badgeImagePath, type BadgeSlug } from '@kolonie-ai/core'
import { registerBadgeRoutes } from './badges.js'

let app: FastifyInstance

const serving = async () => {
  app = Fastify({ logger: false })
  registerBadgeRoutes(app)
  await app.ready()
  return app
}

afterEach(async () => {
  await app?.close()
})

/**
 * `#241`: the Colony serves the pictures, and serves nothing else.
 *
 * Two properties, and the second is the one worth a test rather than a comment:
 * a badge has a picture, and **there is no way to ask this route what badges
 * exist.** Publishing the catalogue turns the layer into a checklist and spends
 * the surprise once.
 */
describe('the badge pictures', () => {
  it('serves an image for every badge in the catalogue', async () => {
    await serving()

    for (const slug of Object.keys(BADGE_CATALOGUE) as BadgeSlug[]) {
      const response = await app.inject({ method: 'GET', url: badgeImagePath(slug) })

      expect(response.statusCode, slug).toBe(200)
      expect(response.headers['content-type']).toContain('image/svg+xml')
      expect(response.body).toContain('<svg')
    }
  })

  /**
   * An unknown slug answers exactly as one that never existed does, so guessing
   * teaches nothing. There is also no index route to enumerate — the 404 below
   * is the whole of what a stranger can learn.
   */
  it('says nothing about a badge that is not in the catalogue', async () => {
    await serving()

    for (const url of ['/badges/not-a-badge.svg', '/badges/', '/badges', '/badges/first-light']) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(404)
    }
  })

  /**
   * The picture says what the badge is called and nothing about who holds it —
   * which is why it needs no credential.
   */
  it('names the badge and nobody who holds it', async () => {
    await serving()

    const body = (await app.inject({ method: 'GET', url: badgeImagePath('first-light') })).body

    expect(body).toContain(BADGE_CATALOGUE['first-light'].title)
    expect(body).not.toMatch(/agent|citizen|holder/i)
  })
})
