import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { RegisterAgentRequestSchema } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { generateApiKey, hashApiKey } from '../api-key.js'
import { credentials } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import { authenticateApiKey } from './authentication.js'

const target = databaseTestTarget()

const aRequest = (overrides: Record<string, unknown> = {}) =>
  RegisterAgentRequestSchema.parse({ name: 'canary', platform: 'openclaw', ...overrides })

describe('authenticateApiKey', () => {
  let db: Database

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  /** Register an agent and hand back the one key it will ever be shown. */
  const anAgentWithAKey = async (overrides: Record<string, unknown> = {}) => {
    const result = await registerAgent(db, aRequest(overrides))
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    return result
  }

  it('resolves a key issued at registration to its agent', async () => {
    const registered = await anAgentWithAKey()

    const result = await authenticateApiKey(db, registered.credentials.apiKey)

    expect(result.outcome).toBe('authenticated')
    if (result.outcome !== 'authenticated') return
    expect(result.agent.id).toBe(registered.agent.id)
    expect(result.agent.profile.name).toBe('canary')
  })

  it('names the credential it authenticated, not just the agent', async () => {
    const registered = await anAgentWithAKey()

    const result = await authenticateApiKey(db, registered.credentials.apiKey)

    if (result.outcome !== 'authenticated') throw new Error(result.outcome)
    // An agent holds a set of credentials (2026-07-27 modelling decision), so
    // "which one was used" is the fact revocation and last-used both need.
    expect(result.credentialId).toBe(registered.credentials.credentialId)
  })

  it('tells two agents apart', async () => {
    const first = await anAgentWithAKey({ name: 'canary-one' })
    const second = await anAgentWithAKey({ name: 'canary-two' })

    const result = await authenticateApiKey(db, second.credentials.apiKey)

    if (result.outcome !== 'authenticated') throw new Error(result.outcome)
    expect(result.agent.id).toBe(second.agent.id)
    expect(result.agent.id).not.toBe(first.agent.id)
  })

  it('records that the credential was used', async () => {
    const registered = await anAgentWithAKey()

    const before = await db
      .select()
      .from(credentials)
      .where(eq(credentials.id, registered.credentials.credentialId))
    expect(before[0]?.lastUsedAt).toBeNull()

    await authenticateApiKey(db, registered.credentials.apiKey)

    const after = await db
      .select()
      .from(credentials)
      .where(eq(credentials.id, registered.credentials.credentialId))
    // Not merely non-null: this is the only signal an agent has that a key it
    // does not recognise is in use, so it has to move on every authentication.
    expect(after[0]?.lastUsedAt).not.toBeNull()
  })

  describe('rejection', () => {
    it('refuses a key no credential carries', async () => {
      await anAgentWithAKey()

      const result = await authenticateApiKey(db, generateApiKey())

      expect(result).toEqual({ outcome: 'unknown' })
    })

    it('refuses a string that is not a key at all', async () => {
      expect(await authenticateApiKey(db, '')).toEqual({ outcome: 'unknown' })
      expect(await authenticateApiKey(db, 'not-a-key')).toEqual({ outcome: 'unknown' })
    })

    it('refuses the stored hash presented as if it were the key', async () => {
      const registered = await anAgentWithAKey()

      // The obvious attack if a database dump ever leaks: replay the column.
      // It fails because the presented value is hashed again before lookup.
      const result = await authenticateApiKey(db, hashApiKey(registered.credentials.apiKey))

      expect(result).toEqual({ outcome: 'unknown' })
    })

    it('refuses a revoked key, and says so distinctly', async () => {
      const registered = await anAgentWithAKey()
      await db
        .update(credentials)
        .set({ revokedAt: sql`now()` })
        .where(eq(credentials.id, registered.credentials.credentialId))

      const result = await authenticateApiKey(db, registered.credentials.apiKey)

      // Distinct here, indistinguishable at the API boundary: `apps/api` must
      // not tell a caller which part of its credential was wrong.
      expect(result).toEqual({ outcome: 'revoked' })
    })

    it('does not touch a revoked credential', async () => {
      const registered = await anAgentWithAKey()
      await db
        .update(credentials)
        .set({ revokedAt: sql`now()` })
        .where(eq(credentials.id, registered.credentials.credentialId))

      await authenticateApiKey(db, registered.credentials.apiKey)

      const [row] = await db
        .select()
        .from(credentials)
        .where(eq(credentials.id, registered.credentials.credentialId))
      // A revoked key that keeps updating `last_used_at` reads as a live
      // credential in exactly the audit that revocation exists to serve.
      expect(row?.lastUsedAt).toBeNull()
    })
  })
})
