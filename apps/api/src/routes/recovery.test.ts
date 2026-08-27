import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ApiKeySchema, type AgentId } from '@kolonie-ai/core'
import { buildApp } from '../app.js'
import { FAKE_CALLER_IP, fakeColony, type FakeColony } from '../__fixtures__/colony/index.js'

const API_KEY = ApiKeySchema.parse(`kol_${'r'.repeat(48)}`)

describe('credential recovery over HTTP', () => {
  let colony: FakeColony
  let app: FastifyInstance
  let agentId: AgentId
  let apiKey: string

  beforeEach(async () => {
    colony = fakeColony()
    app = buildApp(colony)
    const registered = await colony.registry.register(
      { name: 'recoverable', platform: 'openclaw' },
      { ip: FAKE_CALLER_IP },
    )
    if (registered.outcome !== 'registered') throw new Error('fixture failed to register')
    agentId = registered.response.agent.id
    apiKey = registered.response.credentials.apiKey
  })

  it('requires the current credential to nominate an account', async () => {
    const accountId = randomUUID()
    colony.recoveryDesk.setNomination({
      outcome: 'nominated',
      replaced: null,
      nomination: {
        accountId,
        kind: 'keypair',
        identifier: 'a public key',
        nominatedAt: '2026-08-27T00:00:00.000Z',
        effectiveAt: '2026-08-29T00:00:00.000Z',
        effective: false,
      },
    })

    const unauthenticated = await app.inject({
      method: 'PUT',
      url: '/v1/agents/me/recovery-nomination',
      payload: { accountId },
    })
    const nominated = await app.inject({
      method: 'PUT',
      url: '/v1/agents/me/recovery-nomination',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { accountId },
    })

    expect(unauthenticated.statusCode).toBe(401)
    expect(nominated.statusCode).toBe(200)
    expect(nominated.json()).toMatchObject({ accountId, effective: false })
  })

  it('gives an unknown handle and a citizen without a nomination the same answer', async () => {
    colony.recoveryDesk.setChallenge({ outcome: 'no-nomination' })

    const first = await app.inject({ method: 'POST', url: '/v1/recovery/nobody/challenges' })
    const second = await app.inject({ method: 'POST', url: '/v1/recovery/recoverable/challenges' })

    expect(first.statusCode).toBe(404)
    expect(second.statusCode).toBe(404)
    expect(first.body).toBe(second.body)
  })

  it('issues a challenge without a credential and reports the remaining allowance', async () => {
    colony.recoveryDesk.setChallenge({
      outcome: 'issued',
      challenge: {
        nonce: 'nonce-to-sign',
        expiresAt: '2026-08-27T00:15:00.000Z',
        algorithm: 'ed25519',
        attemptsRemaining: 2,
      },
    })

    const response = await app.inject({
      method: 'POST',
      url: '/v1/recovery/recoverable/challenges',
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toEqual({
      nonce: 'nonce-to-sign',
      expiresAt: '2026-08-27T00:15:00.000Z',
      algorithm: 'ed25519',
      attemptsRemaining: 2,
    })
  })

  it('sets Retry-After when three challenges have already been issued', async () => {
    colony.recoveryDesk.setChallenge({ outcome: 'rate-limited', retryAfterSeconds: 713 })

    const response = await app.inject({
      method: 'POST',
      url: '/v1/recovery/recoverable/challenges',
    })

    expect(response.statusCode).toBe(429)
    expect(response.headers['retry-after']).toBe('713')
    expect(response.json()).toMatchObject({
      code: 'rate_limited',
      details: { retryAfterSeconds: '713' },
    })
  })

  it('returns a new key without a credential', async () => {
    colony.recoveryDesk.setRecovery({
      outcome: 'recovered',
      agentId,
      credentialId: randomUUID(),
      apiKey: API_KEY,
      issuedAt: '2026-08-27T00:01:00.000Z',
      strandedVaultEntries: 2,
    })

    const response = await app.inject({
      method: 'POST',
      url: '/v1/recovery/credentials',
      payload: { handle: 'recoverable', nonce: 'nonce-to-sign', signature: 'a-signature' },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({
      credentials: { agentId, apiKey: API_KEY, kind: 'api-key' },
      vault: { stranded: 2 },
    })
  })

  it('collapses every proof refusal into one unauthenticated answer', async () => {
    colony.recoveryDesk.setRecovery({ outcome: 'refused' })

    const response = await app.inject({
      method: 'POST',
      url: '/v1/recovery/credentials',
      payload: { handle: 'recoverable', nonce: 'spent', signature: 'wrong' },
    })

    expect(response.statusCode).toBe(401)
    expect(response.headers['www-authenticate']).toBeDefined()
    expect(response.json()).toEqual({
      code: 'unauthorized',
      message:
        'That recovery was not accepted. Mint a fresh challenge and sign the nonce it gives you with the key or wallet behind the account you nominated.',
    })
  })
})
