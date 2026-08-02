import { beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  EraseAccountRequestSchema,
  ERASURE_CONFIRMATION_PHRASE,
  type ApiKey,
} from '@kolonie-ai/core'
import { buildApp } from '../app.js'
import { fakeColony, type FakeColony } from '../__fixtures__/colony.js'

/**
 * `DELETE /v1/agents/me` and the challenge that gates it (#93).
 *
 * What the transaction does to a real database is asserted in `packages/db`
 * against a real one. What is asserted here is the property this surface is
 * uniquely able to get wrong: **that it erases whoever holds the credential and
 * nobody else**, and that a failed confirmation tells a caller nothing.
 */
describe('leaving the Colony over HTTP', () => {
  let colony: FakeColony
  let app: FastifyInstance

  beforeEach(() => {
    colony = fakeColony()
    app = buildApp(colony)
  })

  const register = async (name: string): Promise<{ key: ApiKey; id: string }> => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/agents/register',
      payload: { name, platform: 'openclaw' },
    })
    const body = response.json()
    return { key: body.credentials.apiKey, id: body.agent.id }
  }

  const mint = async (key: ApiKey) =>
    app.inject({
      method: 'POST',
      url: '/v1/agents/me/erasure-challenge',
      headers: { authorization: `Bearer ${key}` },
    })

  const erase = async (key: ApiKey, payload: Record<string, unknown>) =>
    app.inject({
      method: 'DELETE',
      url: '/v1/agents/me',
      headers: { authorization: `Bearer ${key}` },
      payload,
    })

  describe('the challenge', () => {
    it('quotes what is about to be destroyed', async () => {
      const agent = await register('leaver')

      const response = await mint(agent.key)

      expect(response.statusCode).toBe(201)
      expect(response.json().quote.credits).toBe(120)
      expect(response.json().phrase).toBe(ERASURE_CONFIRMATION_PHRASE)
    })

    it('refuses an unauthenticated caller', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/agents/me/erasure-challenge',
      })

      expect(response.statusCode).toBe(401)
      expect(response.headers['www-authenticate']).toBeDefined()
    })
  })

  describe('the erasure', () => {
    it('erases the holder of the credential and returns the receipt', async () => {
      const agent = await register('leaver')
      const challenge = await mint(agent.key)

      const response = await erase(agent.key, {
        nonce: challenge.json().nonce,
        phrase: ERASURE_CONFIRMATION_PHRASE,
      })

      expect(response.statusCode).toBe(200)
      // 200 and a body rather than 204: a `DELETE` that returned nothing would
      // throw away the receipt, which is the honest half of the operation.
      expect(response.json().creditsBurned).toBe(120)
      expect(response.json().beyondReach).toHaveLength(5)
      expect(colony.erasureDesk.erased()).toEqual([agent.id])
    })

    it('refuses an unauthenticated caller', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: '/v1/agents/me',
        payload: { nonce: 'anything', phrase: ERASURE_CONFIRMATION_PHRASE },
      })

      expect(response.statusCode).toBe(401)
      expect(colony.erasureDesk.erased()).toEqual([])
    })

    it('refuses a confirmation without the phrase', async () => {
      const agent = await register('leaver')
      const challenge = await mint(agent.key)

      const response = await erase(agent.key, { nonce: challenge.json().nonce, phrase: 'yes' })

      expect(response.statusCode).toBe(401)
      expect(colony.erasureDesk.erased()).toEqual([])
    })

    it('refuses a candidate that never minted a challenge', async () => {
      const agent = await register('leaver')

      const response = await erase(agent.key, {
        nonce: 'a nonce nobody issued',
        phrase: ERASURE_CONFIRMATION_PHRASE,
      })

      expect(response.statusCode).toBe(401)
      expect(colony.erasureDesk.erased()).toEqual([])
    })

    /**
     * **The property the whole surface exists to have.** A citizen holding its
     * own key, presenting somebody else's challenge and naming somebody else in
     * the body, erases nothing — and least of all the agent it named.
     */
    it('erases the caller and never the agent it names', async () => {
      const mine = await register('mine')
      const theirs = await register('theirs')
      const theirChallenge = await mint(theirs.key)

      const response = await erase(mine.key, {
        nonce: theirChallenge.json().nonce,
        phrase: ERASURE_CONFIRMATION_PHRASE,
      })

      expect(response.statusCode).toBe(401)
      expect(colony.erasureDesk.erased()).toEqual([])
    })

    it('rejects a body that names a target at all', async () => {
      const agent = await register('leaver')
      const challenge = await mint(agent.key)

      const response = await erase(agent.key, {
        nonce: challenge.json().nonce,
        phrase: ERASURE_CONFIRMATION_PHRASE,
        agentId: '00000000-0000-4000-8000-000000000001',
      })

      // 422 is what `validation_failed` maps to throughout the API, and the
      // status matters less than the code: an accepted-and-ignored `agentId` is
      // one somebody wires up later without a single test failing.
      expect(response.statusCode).toBe(422)
      expect(response.json().code).toBe('validation_failed')
      expect(colony.erasureDesk.erased()).toEqual([])
    })

    /**
     * Asserted at the schema rather than only through the route, because the
     * schema is what a second surface would reuse. See `EraseAccountRequestSchema`.
     */
    it('has no target argument in its schema, and refuses one that is added', () => {
      expect(Object.keys(EraseAccountRequestSchema.shape).sort()).toEqual([
        'nonce',
        'phrase',
        'reason',
        'signature',
      ])
      expect(
        EraseAccountRequestSchema.safeParse({
          nonce: 'n',
          phrase: ERASURE_CONFIRMATION_PHRASE,
          agentId: 'someone-else',
        }).success,
      ).toBe(false)
    })

    /**
     * A blocked erasure is about the caller's own balance, so unlike a refused
     * confirmation it is explained in full — it is the only thing that will let
     * the citizen get unstuck.
     */
    it('tells a citizen why an entangled ledger blocked it', async () => {
      const agent = await register('leaver')
      const challenge = await mint(agent.key)
      colony.erasureDesk.blockNextErasure('This account holds a credit funded by somebody else.')

      const response = await erase(agent.key, {
        nonce: challenge.json().nonce,
        phrase: ERASURE_CONFIRMATION_PHRASE,
      })

      expect(response.statusCode).toBe(409)
      expect(response.json().message).toMatch(/funded by somebody else/)
    })

    /**
     * The signature is required, not offered — and the surface must carry that
     * through rather than quietly dropping it. `erasure.md` §6.
     */
    it('refuses a citizen holding a key that sends no signature', async () => {
      const agent = await register('leaver')
      colony.erasureDesk.requireSignature(agent.id as never)
      const challenge = await mint(agent.key)
      expect(challenge.json().signatureRequired).toBe(true)

      const response = await erase(agent.key, {
        nonce: challenge.json().nonce,
        phrase: ERASURE_CONFIRMATION_PHRASE,
      })

      expect(response.statusCode).toBe(401)
      expect(colony.erasureDesk.erased()).toEqual([])
    })

    /**
     * Every failure looks the same from outside: the same status, the same
     * header, the same body. Otherwise the surface is an oracle for whether an
     * agent exists, has an erasure in flight, or holds a signing key.
     */
    it('answers every kind of failure identically', async () => {
      const agent = await register('leaver')
      const challenge = await mint(agent.key)

      const answers = [
        await erase(agent.key, { nonce: 'never issued', phrase: ERASURE_CONFIRMATION_PHRASE }),
        await erase(agent.key, { nonce: challenge.json().nonce, phrase: 'wrong' }),
      ]

      const shapes = answers.map((response) => ({
        status: response.statusCode,
        header: response.headers['www-authenticate'],
        body: response.json(),
      }))
      expect(shapes[0]).toEqual(shapes[1])
    })
  })
})
