import { API_BASE_PATH } from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { fakeColony } from '../__fixtures__/colony.js'

let app: FastifyInstance

beforeEach(async () => {
  app = buildApp(fakeColony())
  await app.ready()
})

afterEach(async () => {
  await app.close()
})

/**
 * The `/v1` index, checked against the router rather than against its own text.
 *
 * **A hand-maintained list of siblings is the failure mode `AGENTS.md` §7
 * names**, and this list is exactly that: twenty-two paths written out by hand
 * beside sixty-odd routes that nothing updates it from. Splitting the handlers
 * into modules (#195) is the moment it would silently go stale — a route that
 * changed file and lost a path would leave the index advertising it, and every
 * other test of this endpoint compares the list to its own previous text, which
 * cannot notice.
 *
 * It asks Fastify's router rather than parsing `printRoutes`, so a change in how
 * Fastify formats a tree cannot quietly turn this into a test that checks
 * nothing.
 *
 * **One-directional on purpose.** The index is a curated entry point and not a
 * sitemap, so a route missing from it is an editorial choice; a path in it that
 * answers nothing is a lie to an arriving agent.
 */
describe('the /v1 index', () => {
  const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const

  const advertised = async (): Promise<string[]> => {
    const response = await app.inject({ method: 'GET', url: `${API_BASE_PATH}/` })
    return (response.json() as { endpoints: string[] }).endpoints
  }

  it('advertises only paths this server actually answers', async () => {
    const endpoints = await advertised()
    expect(endpoints.length).toBeGreaterThan(0)

    const unanswered = endpoints.filter(
      (url) => !METHODS.some((method) => app.hasRoute({ method, url })),
    )

    expect(unanswered).toEqual([])
  })

  /** The guard on the guard: a probe that matched everything would prove nothing. */
  it('finds no route for a path this server does not serve', () => {
    expect(METHODS.some((method) => app.hasRoute({ method, url: '/v1/nothing/here' }))).toBe(false)
  })

  it('advertises every path under the version prefix it claims', async () => {
    const response = await app.inject({ method: 'GET', url: `${API_BASE_PATH}/` })
    const { endpoints, version } = response.json() as { endpoints: string[]; version: string }

    expect(version).toBe('v1')
    expect(endpoints.filter((endpoint) => !endpoint.startsWith(`${API_BASE_PATH}/`))).toEqual([])
  })
})
