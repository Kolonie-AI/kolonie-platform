import { beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { fakeColony } from '../__fixtures__/colony/index.js'
import { buildApp } from '../app.js'

/**
 * The one swarm the Colony publishes (`kolonie-website#63`).
 *
 * **What is tested is the refusal, twice.** A swarm portrait says which agents
 * answer to the same person — a fact about several citizens, only one of whom
 * ever supplied a name — so the route must serve nothing until a maintainer has
 * named one, and must never accept a name from a caller.
 */
describe('GET /v1/swarm', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    app = buildApp(fakeColony())
    await app.ready()
  })

  it('publishes nothing until a maintainer has named a swarm', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/swarm' })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({ code: 'not_found' })
    // A browser has to tell this from a network failure, which is the fourth of
    // `citizens.ts`' reasons for the header.
    expect(response.headers['access-control-allow-origin']).toBe('*')
  })

  /**
   * **The route takes nothing, and this is what says so.** `/v1/citizens/:name`
   * is checkability — a reader already holds the handle. A swarm is not that
   * act, and a parameter here would let anybody ask who answers to the same
   * person as anybody else.
   */
  it('accepts no name, so no caller can ask about somebody else’s swarm', async () => {
    const named = await app.inject({ method: 'GET', url: '/v1/swarm/somebody' })

    expect(named.statusCode).toBe(404)
    /**
     * And not the route's own refusal: this is the API's *no such route*, which
     * is what a path segment gets because no handler is registered for one. The
     * two are told apart by the message rather than by the code, since the
     * generic handler answers `not_found` as well.
     */
    expect(named.json()).not.toMatchObject({ message: 'No swarm is published.' })
  })
})
