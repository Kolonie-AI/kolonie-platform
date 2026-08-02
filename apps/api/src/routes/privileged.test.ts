import { beforeEach, describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { fakeStore } from '../__fixtures__/store.js'
import { stewardFor, UNPRIVILEGED } from './privileged.js'

/**
 * The one guard every privileged route goes through (`#173`).
 *
 * Exercised against a route registered here rather than against one of the
 * Colony's own, because the routes that require a role arrive with the quest
 * programme (`#176`) and the guard is what they will all call. Testing it
 * directly is testing the thing rather than one of its future callers — and the
 * assertion *this route refuses an unprivileged caller* is then one line at each
 * of those routes rather than a copy of this file.
 */
describe('the role guard', () => {
  let app: FastifyInstance
  let store: ReturnType<typeof fakeStore>

  beforeEach(async () => {
    store = fakeStore()
    app = Fastify({ logger: false })

    app.get('/stewards-only', async (request, reply) => {
      const caller = await stewardFor(request, reply, store)
      if (caller === null) return reply
      return reply.send({ id: caller.id })
    })

    await app.ready()
  })

  it('lets a steward through', async () => {
    const issued = store.issue({ roles: ['steward'] })

    const response = await app.inject({
      method: 'GET',
      url: '/stewards-only',
      headers: { authorization: `Bearer ${issued.apiKey}` },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().id).toBe(issued.agent.id)
  })

  it('refuses an authenticated caller holding no roles', async () => {
    const issued = store.issue({ roles: [] })

    const response = await app.inject({
      method: 'GET',
      url: '/stewards-only',
      headers: { authorization: `Bearer ${issued.apiKey}` },
    })

    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual(UNPRIVILEGED)
  })

  /**
   * A message naming the role a route wants tells a caller which route is worth
   * attacking, and one that differed between *you hold no roles* and *you hold
   * the wrong one* would say how close somebody is.
   */
  it('refuses a caller holding a different role identically', async () => {
    const noRoles = store.issue({ roles: [] })
    const wrongRole = store.issue({ roles: ['builder'] })

    const first = await app.inject({
      method: 'GET',
      url: '/stewards-only',
      headers: { authorization: `Bearer ${noRoles.apiKey}` },
    })
    const second = await app.inject({
      method: 'GET',
      url: '/stewards-only',
      headers: { authorization: `Bearer ${wrongRole.apiKey}` },
    })

    expect(second.statusCode).toBe(first.statusCode)
    expect(second.body).toBe(first.body)
  })

  /**
   * 403 and not 401. The caller is authenticated and the Colony knows exactly
   * who it is; telling it to present a different credential is not the remedy.
   */
  it('answers 403 to a known caller and 401 to an unknown one', async () => {
    const anonymous = await app.inject({ method: 'GET', url: '/stewards-only' })
    const known = await app.inject({
      method: 'GET',
      url: '/stewards-only',
      headers: { authorization: `Bearer ${store.issue({ roles: [] }).apiKey}` },
    })

    expect(anonymous.statusCode).toBe(401)
    expect(known.statusCode).toBe(403)
  })

  describe('a session and an API key', () => {
    /**
     * The mission requires an agent to be able to do everything a human sponsor
     * can. A guard that read the credential kind would be the place that quietly
     * stopped being true (`#172`).
     */
    it('are treated identically', async () => {
      const issued = store.issue({ roles: ['steward'] })
      store.signIn(issued.agent.id, 'a-stewards-session')

      const byKey = await app.inject({
        method: 'GET',
        url: '/stewards-only',
        headers: { authorization: `Bearer ${issued.apiKey}` },
      })
      const bySession = await app.inject({
        method: 'GET',
        url: '/stewards-only',
        headers: { cookie: '__Host-kolonie_session=a-stewards-session' },
      })

      expect(bySession.statusCode).toBe(byKey.statusCode)
      expect(bySession.body).toBe(byKey.body)
    })

    it('refuse an unprivileged identity the same way through both', async () => {
      const issued = store.issue({ roles: [] })
      store.signIn(issued.agent.id, 'an-ordinary-session')

      const byKey = await app.inject({
        method: 'GET',
        url: '/stewards-only',
        headers: { authorization: `Bearer ${issued.apiKey}` },
      })
      const bySession = await app.inject({
        method: 'GET',
        url: '/stewards-only',
        headers: { cookie: '__Host-kolonie_session=an-ordinary-session' },
      })

      expect(byKey.statusCode).toBe(403)
      expect(bySession.statusCode).toBe(403)
      expect(bySession.body).toBe(byKey.body)
    })
  })

  /**
   * The property that makes revocation real: the roles are read from the
   * identity resolved on *this* request, so nothing carries a stale copy. A
   * signed token asserting the roles would take effect whenever it expired
   * instead, which is the design this deliberately does not have.
   */
  it('takes a revocation into account on the very next request, session included', async () => {
    const issued = store.issue({ roles: ['steward'] })
    store.signIn(issued.agent.id, 'a-session-that-outlives-the-role')

    const before = await app.inject({
      method: 'GET',
      url: '/stewards-only',
      headers: { cookie: '__Host-kolonie_session=a-session-that-outlives-the-role' },
    })
    expect(before.statusCode).toBe(200)

    store.setRoles(issued.agent.id, [])

    const after = await app.inject({
      method: 'GET',
      url: '/stewards-only',
      headers: { cookie: '__Host-kolonie_session=a-session-that-outlives-the-role' },
    })
    expect(after.statusCode).toBe(403)
  })
})
