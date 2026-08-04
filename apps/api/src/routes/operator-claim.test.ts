import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ERROR_STATUS, type AgentId, type ApiKey } from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.js'
import { fakeColony, type FakeColony } from '../__fixtures__/colony/index.js'
import { fakeStore } from '../__fixtures__/store.js'
import {
  fakeClaimReader,
  fakeOperatorClaims,
  type FakeOperatorClaims,
} from '../__fixtures__/operator-claim.js'

const A_POST = 'https://x.com/gregorsprint/status/1234567890'

describe('the operator claim routes', () => {
  let app: FastifyInstance
  let colony: FakeColony
  let claims: FakeOperatorClaims
  let reader: ReturnType<typeof fakeClaimReader>
  let apiKey: ApiKey
  let agentId: AgentId

  beforeEach(async () => {
    colony = fakeColony()
    claims = fakeOperatorClaims()
    reader = fakeClaimReader()
    const store = fakeStore()
    app = buildApp({ ...colony, store, operatorClaim: { claims, reader } })
    await app.ready()

    const issued = store.issue()
    apiKey = issued.apiKey
    agentId = issued.agent.id
  })

  afterEach(async () => {
    await app?.close()
  })

  const post = (url: string, payload: unknown, key: ApiKey | null = apiKey) =>
    app.inject({
      method: 'POST',
      url,
      payload: payload as Record<string, unknown>,
      ...(key === null ? {} : { headers: { authorization: `Bearer ${key}` } }),
    })

  const aClaimString = async (): Promise<string> => {
    const response = await post('/v1/operator/claims/challenges', {})
    return response.json().claim as string
  }

  describe('asking for a string', () => {
    it('issues one and says when it stops working', async () => {
      const response = await post('/v1/operator/claims/challenges', {})

      expect(response.statusCode).toBe(201)
      expect(response.json().claim).toContain('kolonie-operator-claim')
      expect(response.json().expiresAt).toBeTruthy()
    })

    it('refuses an unauthenticated request', async () => {
      const response = await post('/v1/operator/claims/challenges', {}, null)

      expect(response.statusCode).toBe(ERROR_STATUS.unauthorized)
    })
  })

  describe('handing in the post', () => {
    it('records the vouch and answers 201', async () => {
      const claim = await aClaimString()
      reader.answers({ outcome: 'found', post: { handle: 'gregorsprint', body: claim } })

      const response = await post('/v1/operator/claims', { postUrl: A_POST })

      expect(response.statusCode).toBe(201)
      expect(response.json().handle).toBe('gregorsprint')
      // The date is half of what makes this a dated event rather than a standing
      // claim about who holds the handle — see D-066.
      expect(response.json().claimedAt).toBeTruthy()
    })

    it('records the handle X reported, not the one in the submitted address', async () => {
      const claim = await aClaimString()
      reader.answers({ outcome: 'found', post: { handle: 'someoneelse', body: claim } })

      const response = await post('/v1/operator/claims', { postUrl: A_POST })

      expect(response.json().handle).toBe('someoneelse')
    })

    it('refuses a post that does not carry the string', async () => {
      await aClaimString()
      reader.answers({ outcome: 'found', post: { handle: 'gregorsprint', body: 'nice weather' } })

      const response = await post('/v1/operator/claims', { postUrl: A_POST })

      expect(response.statusCode).toBe(ERROR_STATUS.validation_failed)
    })

    it('refuses when nothing is outstanding, and does not reach X', async () => {
      reader.answers({ outcome: 'found', post: { handle: 'gregorsprint', body: 'anything' } })

      const response = await post('/v1/operator/claims', { postUrl: A_POST })

      expect(response.statusCode).toBe(ERROR_STATUS.conflict)
    })

    /**
     * The one that matters most. X being unreachable is not the operator's
     * mistake and must come back as something the citizen retries, not as a
     * refusal that sends a person to look for a problem that is not theirs.
     */
    it('answers 503 when X cannot be read, and spends nothing', async () => {
      const claim = await aClaimString()
      reader.answers({ outcome: 'unavailable', reason: 'X answered 503.' })

      const down = await post('/v1/operator/claims', { postUrl: A_POST })

      expect(down.statusCode).toBe(503)
      expect(down.json().message).toContain('not your problem')

      // Nothing was spent: the same post works once X is back.
      reader.answers({ outcome: 'found', post: { handle: 'gregorsprint', body: claim } })
      const retried = await post('/v1/operator/claims', { postUrl: A_POST })

      expect(retried.statusCode).toBe(201)
    })

    it('refuses an unauthenticated submission', async () => {
      const response = await post('/v1/operator/claims', { postUrl: A_POST }, null)

      expect(response.statusCode).toBe(ERROR_STATUS.unauthorized)
    })

    it('refuses a body with no post address', async () => {
      await aClaimString()

      const response = await post('/v1/operator/claims', {})

      expect(response.statusCode).toBe(ERROR_STATUS.validation_failed)
    })

    it('takes the agent from the credential and never from the body', async () => {
      const claim = await aClaimString()
      reader.answers({ outcome: 'found', post: { handle: 'gregorsprint', body: claim } })

      await post('/v1/operator/claims', {
        agentId: '00000000-0000-4000-8000-000000000000',
        postUrl: A_POST,
      })

      expect(claims.recorded().at(-1)).toBeDefined()
      expect(await claims.current(agentId)).not.toBeNull()
    })
  })
})
