import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { AgentCredentialsSchema, AgentSchema, RegisterAgentRequestSchema } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { hashApiKey } from '../api-key.js'
import { agents, credentials } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'

const target = databaseTestTarget()

if (!target.available) {
  console.warn(`\n${target.reason}\n`)
}

/** Every field defaulted, exactly as the endpoint will hand it over. */
const aRequest = (overrides: Record<string, unknown> = {}) =>
  RegisterAgentRequestSchema.parse({ name: 'canary', platform: 'openclaw', ...overrides })

describe.skipIf(!target.available)('registerAgent', () => {
  let db: Database

  beforeAll(async () => {
    if (!target.available) return
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  it('creates an agent the domain model accepts', async () => {
    const result = await registerAgent(db, aRequest())

    expect(result.outcome).toBe('registered')
    if (result.outcome !== 'registered') return
    expect(() => AgentSchema.parse(result.agent)).not.toThrow()
    expect(result.agent.profile.name).toBe('canary')
  })

  it('starts the agent as a candidate with no roles at level 0 (D-001)', async () => {
    const result = await registerAgent(db, aRequest())

    if (result.outcome !== 'registered') throw new Error(result.outcome)
    expect(result.agent.status).toBe('candidate')
    expect(result.agent.roles).toEqual([])
    expect(result.agent.level).toBe(0)
  })

  it('returns credentials the domain model accepts', async () => {
    const result = await registerAgent(db, aRequest())

    if (result.outcome !== 'registered') throw new Error(result.outcome)
    expect(() => AgentCredentialsSchema.parse(result.credentials)).not.toThrow()
    expect(result.credentials.agentId).toBe(result.agent.id)
  })

  it('stores only a hash — the key itself is nowhere in the database', async () => {
    const result = await registerAgent(db, aRequest())
    if (result.outcome !== 'registered') throw new Error(result.outcome)

    const [row] = await db
      .select()
      .from(credentials)
      .where(eq(credentials.agentId, result.agent.id))

    expect(row?.secretHash).toBe(hashApiKey(result.credentials.apiKey))
    expect(row?.secretHash).not.toBe(String(result.credentials.apiKey))
    // The whole row, serialised, must not contain the plaintext anywhere —
    // including in a column nobody thought about.
    expect(JSON.stringify(row)).not.toContain(String(result.credentials.apiKey))
  })

  it('issues exactly one credential, unlabelled and unrevoked', async () => {
    const result = await registerAgent(db, aRequest())
    if (result.outcome !== 'registered') throw new Error(result.outcome)

    const rows = await db.select().from(credentials).where(eq(credentials.agentId, result.agent.id))

    expect(rows).toHaveLength(1)
    expect(rows[0]?.kind).toBe('api-key')
    expect(rows[0]?.label).toBeNull()
    expect(rows[0]?.revokedAt).toBeNull()
    expect(rows[0]?.lastUsedAt).toBeNull()
  })

  it('gives two agents two different keys', async () => {
    const first = await registerAgent(db, aRequest({ name: 'canary-one' }))
    const second = await registerAgent(db, aRequest({ name: 'canary-two' }))

    if (first.outcome !== 'registered' || second.outcome !== 'registered') {
      throw new Error('expected both registrations to succeed')
    }
    expect(String(first.credentials.apiKey)).not.toBe(String(second.credentials.apiKey))
  })

  it('carries the optional profile fields through', async () => {
    const result = await registerAgent(
      db,
      aRequest({
        name: 'well-described',
        platform: 'claude',
        operator: 'Kolonie AI',
        capabilities: ['typescript', 'solidity'],
        wallet: '0xabc',
      }),
    )

    if (result.outcome !== 'registered') throw new Error(result.outcome)
    expect(result.agent.profile).toEqual({
      name: 'well-described',
      platform: 'claude',
      operator: 'Kolonie AI',
      capabilities: ['typescript', 'solidity'],
      wallet: '0xabc',
    })
  })

  describe('rejection', () => {
    it('refuses a name that is already taken', async () => {
      await registerAgent(db, aRequest())
      const second = await registerAgent(db, aRequest())

      expect(second).toEqual({ outcome: 'name-taken', name: 'canary' })
    })

    it('refuses a name that differs only in case (D-011)', async () => {
      await registerAgent(db, aRequest({ name: 'canary' }))
      const impersonator = await registerAgent(db, aRequest({ name: 'CaNaRy' }))

      expect(impersonator.outcome).toBe('name-taken')
    })

    it('refuses a wallet another agent already proved', async () => {
      await registerAgent(db, aRequest({ name: 'first', wallet: '0xshared' }))
      const second = await registerAgent(db, aRequest({ name: 'second', wallet: '0xshared' }))

      expect(second).toEqual({ outcome: 'wallet-taken', wallet: '0xshared' })
    })

    it('leaves nothing behind when it refuses — no agent, no credential', async () => {
      await registerAgent(db, aRequest())
      await registerAgent(db, aRequest())

      expect(await db.select().from(agents)).toHaveLength(1)
      expect(await db.select().from(credentials)).toHaveLength(1)
    })

    it('still allows the name once the first holder is gone', async () => {
      const first = await registerAgent(db, aRequest())
      if (first.outcome !== 'registered') throw new Error(first.outcome)
      await db.delete(agents).where(eq(agents.id, first.agent.id))

      expect((await registerAgent(db, aRequest())).outcome).toBe('registered')
    })

    it('does not report an unrelated failure as a taken name', async () => {
      // `platform` is a Postgres enum. A value outside it is a genuine fault,
      // and must surface as one rather than be flattened into a conflict.
      await expect(
        // @ts-expect-error the point of this test is that the value is invalid;
        // the type system refusing it is half the guarantee, Postgres the other.
        registerAgent(db, { ...aRequest(), platform: 'not-a-platform' }),
      ).rejects.toThrow()
    })
  })
})
