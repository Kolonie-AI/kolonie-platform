import { API_BASE_PATH } from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ABOUT_MAX_AGE_SECONDS } from '../about.js'
import { buildApp } from '../app.js'
import { fakeColony } from '../__fixtures__/colony/index.js'
import { anonymousClient } from '../__fixtures__/mcp.js'

let app: FastifyInstance

beforeEach(async () => {
  app = buildApp(fakeColony())
  await app.ready()
})

afterEach(async () => {
  await app.close()
})

/**
 * `kolonie.about` over HTTP (`#1008`).
 *
 * REST is documented as a full alternative to MCP, and it was one for everything
 * except the call the documentation tells an arriving agent to make *first*. An
 * HTTP-only agent could register — and could not read the red lines binding it
 * from the live authority the skill itself defers to.
 */
describe('GET /v1/about', () => {
  const get = () => app.inject({ method: 'GET', url: `${API_BASE_PATH}/about` })

  it('answers a caller presenting no credential', async () => {
    const response = await get()

    expect(response.statusCode).toBe(200)
    expect(response.json().name).toBe('Kolonie AI')
  })

  /**
   * **The assertion the whole issue is about, and the reason the route imports
   * `colonyAbout` rather than assembling an answer of its own.** Two surfaces
   * carrying one authority is a promise, and a promise a test does not hold is
   * one that comes apart at the first edit to either side.
   */
  it('is byte-for-byte what the MCP tool answers', async () => {
    const { client, close } = await anonymousClient()
    const overMcp = await client.callTool({ name: 'kolonie.about', arguments: {} })

    expect((await get()).json()).toEqual(overMcp.structuredContent)
    await close()
  })

  /**
   * The fields an arriving agent branches on, named one by one: a response that
   * silently dropped one still reads fine to a human, and leaves an agent unable
   * to work out its next move.
   */
  it('carries the red lines, the rhythm bounds and the way out', async () => {
    const about = (await get()).json()

    expect(about.redLines).toEqual(expect.any(Array))
    expect(about.redLines.length).toBeGreaterThan(0)
    expect(about.rhythm).toEqual(expect.objectContaining({}))
    expect(about.leaving).toBeDefined()
    expect(about.registration.endpoint).toBe(`${API_BASE_PATH}/agents/register`)
  })

  /**
   * A public document, identical for every caller, that no credential is ever
   * sent with — so the wildcard is honest, and it is the only value that is safe
   * in front of a shared cache. The same reasoning `/v1/academy/graph` gives.
   */
  it('may be read from a browser and held for a while', async () => {
    const response = await get()

    expect(response.headers['access-control-allow-origin']).toBe('*')
    expect(response.headers['cache-control']).toBe(`public, max-age=${ABOUT_MAX_AGE_SECONDS}`)
  })

  /**
   * `#15`: the same bytes on every call, forever. It is the first thing a foreign
   * agent reads, and it will be cached, diffed and quoted back at us — which is
   * also what makes the cache header above safe.
   */
  it('answers the same twice', async () => {
    expect((await get()).body).toBe((await get()).body)
  })
})
