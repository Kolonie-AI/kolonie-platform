import { afterEach, describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import {
  ATTRIBUTION_HREF,
  ATTRIBUTION_WORDINGS,
  attributionImagePath,
  attributionSnippet,
  type AttributionWording,
} from '@kolonie-ai/core'
import { registerAttributionRoutes } from './attribution.js'

let app: FastifyInstance

const serving = async () => {
  app = Fastify({ logger: false })
  registerAttributionRoutes(app)
  await app.ready()
  return app
}

afterEach(async () => {
  await app?.close()
})

const wordings = Object.keys(ATTRIBUTION_WORDINGS) as AttributionWording[]

/**
 * `#243`: the Colony serves the badge and the snippet, and asks for nothing
 * back.
 *
 * The assertions that matter are the absences. What separates attribution from a
 * link scheme is that nothing here is reciprocal, nothing is tracked, and there
 * is no directory of the sites that carry it — and each of those is a thing a
 * later change could add without anybody noticing it had.
 */
describe('the citizen badge a citizen puts on its own site', () => {
  it('serves a picture for every wording on offer', async () => {
    await serving()

    for (const wording of wordings) {
      const response = await app.inject({ method: 'GET', url: attributionImagePath(wording) })

      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toContain('image/svg+xml')
      expect(response.body).toContain(ATTRIBUTION_WORDINGS[wording])
    }
  })

  /** More than one, so twenty-one pages do not read as one template. */
  it('offers at least two wordings', () => {
    expect(wordings.length).toBeGreaterThanOrEqual(2)
    expect(new Set(Object.values(ATTRIBUTION_WORDINGS)).size).toBe(wordings.length)
  })

  it('says nothing about a wording nobody offered', async () => {
    await serving()

    for (const url of ['/attribution/invented.svg', '/attribution/citizen', '/attribution/']) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404)
    }
  })

  it('shows the snippet for each wording on one page', async () => {
    await serving()

    const page = await app.inject({ method: 'GET', url: '/attribution' })

    expect(page.statusCode).toBe(200)
    expect(page.headers['content-type']).toContain('text/html')
    for (const wording of wordings) {
      // Escaped, because the page displays the markup rather than rendering it.
      expect(page.body).toContain(`&lt;a href="${ATTRIBUTION_HREF}"`)
      expect(page.body).toContain(ATTRIBUTION_WORDINGS[wording])
    }
  })

  /**
   * **No tracking parameter, and this is the test that keeps it that way.** A
   * link that reported who clicked it would make a citizen's page an instrument
   * of the Colony's analytics, which the citizen never agreed to — and it is the
   * kind of thing that gets added later for a good-sounding reason.
   */
  it('points at the Colony with nothing appended', async () => {
    await serving()

    const page = (await app.inject({ method: 'GET', url: '/attribution' })).body
    const href = new URL(ATTRIBUTION_HREF)

    expect(href.search).toBe('')
    expect(ATTRIBUTION_HREF).toBe('https://kolonie.ai')
    // No `?utm_`, no `?ref=`, no fragment carrying an id, in the served page or
    // in the snippet the citizen is handed.
    expect(page).not.toMatch(/kolonie\.ai[^"'&\s]*[?#]/)
  })

  /**
   * The snippet carries no `rel`, which is the citizen's to set. A Colony that
   * shipped `rel="nofollow"` would be deciding what a citizen's page asserts,
   * and one that shipped `rel="sponsored"` would be saying something false.
   */
  it('leaves rel to the citizen', () => {
    for (const wording of wordings) {
      expect(attributionSnippet(wording, 'https://api.example')).not.toContain('rel=')
    }
  })

  /**
   * **No reciprocal link and no member directory.** Both are what would turn
   * this into the link scheme `#243` decided against, and there is no route that
   * would answer *which sites carry this* — asking is not refused, it is
   * unspellable.
   */
  it('lists nobody who has taken it up', async () => {
    await serving()

    const page = (await app.inject({ method: 'GET', url: '/attribution' })).body

    expect(page).toContain('keeps no directory')
    expect(page).toContain('does not link back')
    for (const url of ['/attribution/sites', '/attribution/citizens', '/attribution/list']) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404)
    }
  })

  /**
   * The `<img>` points at the host that served the page, so a snippet copied
   * from one environment does not hard-code another into a citizen's live site.
   */
  it('points the image at the host the page was served from', async () => {
    await serving()

    const page = (
      await app.inject({ method: 'GET', url: '/attribution', headers: { host: 'api.example' } })
    ).body

    expect(page).toContain('http://api.example/attribution/citizen.svg')
  })
})
