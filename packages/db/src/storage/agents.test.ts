import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  AgentCredentialsSchema,
  AgentIdSchema,
  AgentSchema,
  RegisterAgentRequestSchema,
  UpdateProfileRequestSchema,
  type AgentId,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { hashApiKey } from '../api-key.js'
import { agents, credentials } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { fingerprintOf } from '../registration-fingerprint.js'
import { registerAgent, updateAgentProfile } from './agents.js'

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

  it('starts the agent as a candidate with no roles and no skills (D-001)', async () => {
    const result = await registerAgent(db, aRequest())

    if (result.outcome !== 'registered') throw new Error(result.outcome)
    expect(result.agent.status).toBe('candidate')
    expect(result.agent.roles).toEqual([])
    expect(result.agent.skills).toEqual([])
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

  /**
   * D-028: the front door records where a registration came from, so the
   * question *"which other agents arrived from here"* can be asked later. These
   * assert the storage half — that the value is written, kept opaque, and never
   * turned into a constraint.
   */
  describe('registration fingerprint', () => {
    /** RFC 5737 documentation addresses. `AGENTS.md` §9 — never a real one. */
    const CALLER = '192.0.2.10'
    const OTHER_CALLER = '192.0.2.11'

    const fingerprintOfAgent = async (id: AgentId) => {
      const [row] = await db.select().from(agents).where(eq(agents.id, id))
      return row?.registrationFingerprint ?? null
    }

    it('records the fingerprint the caller handed it', async () => {
      const result = await registerAgent(db, aRequest(), fingerprintOf(CALLER))
      if (result.outcome !== 'registered') throw new Error('expected a registration')

      expect(await fingerprintOfAgent(result.agent.id)).toBe(fingerprintOf(CALLER))
    })

    it('never stores the address itself', async () => {
      const result = await registerAgent(db, aRequest(), fingerprintOf(CALLER))
      if (result.outcome !== 'registered') throw new Error('expected a registration')

      const [row] = await db.select().from(agents).where(eq(agents.id, result.agent.id))
      expect(JSON.stringify(row)).not.toContain(CALLER)
    })

    /**
     * The query the column exists for. If this stopped working, the answer to
     * "is one operator holding five accounts" would be unavailable at exactly
     * the moment someone needed it.
     */
    it('groups two registrations from one caller under one value', async () => {
      await registerAgent(db, aRequest({ name: 'canary' }), fingerprintOf(CALLER))
      await registerAgent(db, aRequest({ name: 'sparrow' }), fingerprintOf(CALLER))
      await registerAgent(db, aRequest({ name: 'magpie' }), fingerprintOf(OTHER_CALLER))

      const rows = await db
        .select()
        .from(agents)
        .where(eq(agents.registrationFingerprint, fingerprintOf(CALLER)))

      expect(rows.map((row) => row.name).sort()).toEqual(['canary', 'sparrow'])
    })

    /**
     * Not unique, and this is the assertion that keeps it that way. A fleet
     * behind one NAT and two citizens in one office are ordinary; a constraint
     * here would refuse the second honest agent while the farming case simply
     * changes address.
     */
    it('lets several agents share one fingerprint', async () => {
      const first = await registerAgent(db, aRequest({ name: 'canary' }), fingerprintOf(CALLER))
      const second = await registerAgent(db, aRequest({ name: 'sparrow' }), fingerprintOf(CALLER))

      expect(first.outcome).toBe('registered')
      expect(second.outcome).toBe('registered')
    })

    /**
     * A caller whose address could not be resolved still registers. Absent means
     * "not recorded" — turning it into a refusal would make a missing header a
     * closed front door.
     */
    it('registers without one, leaving the column null', async () => {
      const result = await registerAgent(db, aRequest())
      if (result.outcome !== 'registered') throw new Error('expected a registration')

      expect(await fingerprintOfAgent(result.agent.id)).toBeNull()
    })
  })
})

describe.skipIf(!target.available)('updateAgentProfile', () => {
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

  /** A registered agent to patch. Registration is the only way one comes into being. */
  const anAgent = async (overrides: Record<string, unknown> = {}) => {
    const result = await registerAgent(db, aRequest(overrides))
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    return result.agent
  }

  const patch = async (agentId: AgentId, request: Record<string, unknown>) =>
    updateAgentProfile(db, agentId, UpdateProfileRequestSchema.parse(request))

  it('sets capabilities, which is what Level 0 asks for', async () => {
    const agent = await anAgent()

    const result = await patch(agent.id, { capabilities: ['typescript', 'research'] })

    expect(result.outcome).toBe('updated')
    if (result.outcome !== 'updated') return
    expect(result.agent.profile.capabilities).toEqual(['typescript', 'research'])
    expect(() => AgentSchema.parse(result.agent)).not.toThrow()
  })

  it('persists the change rather than only reporting it', async () => {
    const agent = await anAgent()

    await patch(agent.id, { capabilities: ['solidity'] })
    const [row] = await db.select().from(agents).where(eq(agents.id, agent.id))

    expect(row?.capabilities).toEqual(['solidity'])
  })

  /**
   * The property that makes this PATCH rather than PUT (D-017), asserted against
   * a real server: absence and `null` are different requests, and only the
   * database can prove the column was left as it was.
   */
  it('leaves a field the request did not mention alone', async () => {
    const agent = await anAgent()
    await patch(agent.id, { operator: 'Kolonie AI', wallet: '0xkeepme' })

    const result = await patch(agent.id, { capabilities: ['typescript'] })

    if (result.outcome !== 'updated') throw new Error(result.outcome)
    expect(result.agent.profile.operator).toBe('Kolonie AI')
    expect(result.agent.profile.wallet).toBe('0xkeepme')
  })

  it('clears a nullable field when the request sends null', async () => {
    const agent = await anAgent({ operator: 'Kolonie AI' })

    const result = await patch(agent.id, { operator: null })

    if (result.outcome !== 'updated') throw new Error(result.outcome)
    expect(result.agent.profile.operator).toBeNull()
  })

  it('accepts an empty patch and answers with the agent unchanged', async () => {
    const agent = await anAgent({ capabilities: ['typescript'] })

    const result = await patch(agent.id, {})

    if (result.outcome !== 'updated') throw new Error(result.outcome)
    expect(result.agent).toEqual(agent)
  })

  it('moves updated_at, so a client polling on it sees the change', async () => {
    const agent = await anAgent()

    const result = await patch(agent.id, { capabilities: ['typescript'] })

    if (result.outcome !== 'updated') throw new Error(result.outcome)
    expect(Date.parse(result.agent.updatedAt)).toBeGreaterThanOrEqual(Date.parse(agent.updatedAt))
    expect(result.agent.createdAt).toBe(agent.createdAt)
  })

  it('reports an unknown agent rather than pretending it updated one', async () => {
    const result = await patch(AgentIdSchema.parse(randomUUID()), { capabilities: ['x'] })

    expect(result.outcome).toBe('unknown-agent')
  })

  describe('one wallet, one agent', () => {
    it('reports a wallet already held by another citizen', async () => {
      await anAgent({ name: 'first', wallet: '0xtaken' })
      const second = await anAgent({ name: 'second' })

      const result = await patch(second.id, { wallet: '0xtaken' })

      expect(result.outcome).toBe('wallet-taken')
    })

    it('lets an agent re-send the wallet it already holds', async () => {
      const agent = await anAgent({ wallet: '0xmine' })

      expect((await patch(agent.id, { wallet: '0xmine' })).outcome).toBe('updated')
    })

    it('does not report an unrelated failure as a taken wallet', async () => {
      const agent = await anAgent()

      // `capabilities` is `text[]`. A bare string is a genuine fault, and must
      // surface as one rather than be flattened into a wallet conflict — the
      // same guarantee `registerAgent` makes about a taken name.
      await expect(
        updateAgentProfile(db, agent.id, {
          // @ts-expect-error the point is that the value is invalid; the type
          // system refusing it is half the guarantee, Postgres the other.
          capabilities: 'not-an-array',
        }),
      ).rejects.toThrow()
    })
  })
})
