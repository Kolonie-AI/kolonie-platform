import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { RegisterAgentRequestSchema, type AgentId } from '@kolonie-ai/core'
import { generateApiKey } from '../api-key.js'
import type { Database } from '../client.js'
import { agentVault } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import { authenticateApiKey } from './authentication.js'
import { rotateApiKey } from './rotation.js'
import { getVaultEntry, listVaultEntries, reSealVault, setVaultEntry } from './vault.js'

const target = databaseTestTarget()

/**
 * The vault travels with the key (`#1127`).
 *
 * Every entry is sealed under a key derived from the API key, so until this the
 * call the Colony most wants a citizen to reach for — *your key has been seen,
 * replace it* — quietly destroyed everything that citizen kept. The assertions
 * here are the two halves of the fix: what survives a rotation, and what a
 * rotation that goes wrong is not allowed to take with it.
 */
describe('rotating a key re-seals the vault (#1127)', () => {
  let db: Database
  let agentId: AgentId
  let apiKey: string

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db.$client.end()
  })

  beforeEach(async () => {
    await truncateAll(db)

    const registered = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name: 'keeper', platform: 'openclaw' }),
    )
    if (registered.outcome !== 'registered') throw new Error(registered.outcome)

    agentId = registered.agent.id
    apiKey = String(registered.credentials.apiKey)
  })

  const rotate = async (presented: string) => {
    const rotated = await rotateApiKey(db, presented)
    if (rotated.outcome !== 'rotated') throw new Error(rotated.outcome)
    return rotated
  }

  it('opens every entry under the new key, byte for byte', async () => {
    // Bytes rather than words: a value that survives a round trip through the
    // envelope has to survive the ones a naive re-encode would not.
    const values = {
      simple: 'hunter2',
      unicode: 'pässwörd — 🔐 — 密码',
      whitespace: ' leading and trailing \n\t',
    }

    for (const [key, value] of Object.entries(values)) {
      await setVaultEntry(db, apiKey, agentId, key, value)
    }

    const rotated = await rotate(apiKey)

    for (const [key, value] of Object.entries(values)) {
      const read = await getVaultEntry(db, String(rotated.credentials.apiKey), agentId, key)
      expect(read).toMatchObject({ outcome: 'found', value })
    }
  })

  it('carries the descriptions across rather than leaving a list of nulls', async () => {
    await setVaultEntry(db, apiKey, agentId, 'mailbox', 'a value', 'the mailbox at a provider')

    const rotated = await rotate(apiKey)

    const listed = await listVaultEntries(db, String(rotated.credentials.apiKey), agentId)
    expect(listed).toMatchObject([{ key: 'mailbox', description: 'the mailbox at a provider' }])
  })

  it('counts what moved', async () => {
    await setVaultEntry(db, apiKey, agentId, 'one', 'a')
    await setVaultEntry(db, apiKey, agentId, 'two', 'b')

    expect((await rotate(apiKey)).vault).toEqual({ resealed: 2, unreadable: 0 })
  })

  /**
   * Decision 3: an orphan from an earlier rotation is not archaeology, and it is
   * not a reason to refuse a citizen the remedy for a leak.
   */
  it('rotates around an orphan, leaves it alone, and says it is there', async () => {
    const stranded = String(generateApiKey())
    await setVaultEntry(db, stranded, agentId, 'from-a-past-life', 'unreachable')
    await setVaultEntry(db, apiKey, agentId, 'current', 'reachable')

    const rotated = await rotate(apiKey)

    expect(rotated.vault).toEqual({ resealed: 1, unreadable: 1 })
    // Untouched rather than re-sealed under something else: the row is exactly
    // as dead as it was, and `kolonie.vault.delete` is still its broom.
    expect(await getVaultEntry(db, stranded, agentId, 'from-a-past-life')).toMatchObject({
      outcome: 'found',
      value: 'unreachable',
    })
  })

  it('rotates an empty vault and reports zero', async () => {
    expect((await rotate(apiKey)).vault).toEqual({ resealed: 0, unreadable: 0 })
  })

  /**
   * `updatedAt` means *when the value was last written*, and a re-seal writes the
   * same value. Moving it would tell a citizen its credential had changed by
   * pointing at the entry rather than at the credential.
   */
  it('does not move updatedAt', async () => {
    await setVaultEntry(db, apiKey, agentId, 'mailbox', 'a value')
    const [before] = await db.select().from(agentVault).where(eq(agentVault.agentId, agentId))

    await rotate(apiKey)

    const [after] = await db.select().from(agentVault).where(eq(agentVault.agentId, agentId))
    expect(after?.updatedAt).toEqual(before?.updatedAt)
    // The ciphertext did move, which is what makes the assertion above a claim
    // about the column rather than about nothing having happened.
    expect(after?.encryptedValue).not.toEqual(before?.encryptedValue)
  })

  /**
   * Decision 5, asserted rather than promised.
   *
   * The rotation writes no log lines at all today, and this is what keeps that
   * true: a debug line added later that names the entry it is re-sealing would
   * put a citizen's key names — the half of the vault the Colony can see — into
   * a log that outlives the request.
   */
  it('writes no vault value and no vault key name to any log', async () => {
    await setVaultEntry(db, apiKey, agentId, 'a-recognisable-key-name', 'a-recognisable-value')

    const written: string[] = []
    const capture = (...parts: unknown[]) => {
      written.push(parts.map((part) => String(part)).join(' '))
    }
    const spies = (['debug', 'info', 'log', 'warn', 'error'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(capture),
    )
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      capture(chunk)
      return true
    }) as typeof process.stdout.write)

    try {
      await rotate(apiKey)
    } finally {
      for (const spy of spies) spy.mockRestore()
      stdout.mockRestore()
    }

    const log = written.join('\n')
    expect(log).not.toContain('a-recognisable-value')
    expect(log).not.toContain('a-recognisable-key-name')
  })

  it('touches nobody else’s vault', async () => {
    const other = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name: 'stranger', platform: 'openclaw' }),
    )
    if (other.outcome !== 'registered') throw new Error(other.outcome)
    const otherKey = String(other.credentials.apiKey)
    await setVaultEntry(db, otherKey, other.agent.id, 'theirs', 'not mine')
    await setVaultEntry(db, apiKey, agentId, 'mine', 'mine')

    expect((await rotate(apiKey)).vault).toEqual({ resealed: 1, unreadable: 0 })

    expect(await getVaultEntry(db, otherKey, other.agent.id, 'theirs')).toMatchObject({
      outcome: 'found',
      value: 'not mine',
    })
  })

  /**
   * Called directly, because rotation is not the only caller it could ever have
   * and the contract is the function's rather than the rotation's.
   */
  it('is a no-op when the two tokens are the same', async () => {
    await setVaultEntry(db, apiKey, agentId, 'mailbox', 'a value')

    expect(await reSealVault(db, agentId, apiKey, apiKey)).toEqual({ resealed: 1, unreadable: 0 })
    expect(await getVaultEntry(db, apiKey, agentId, 'mailbox')).toMatchObject({
      outcome: 'found',
      value: 'a value',
    })
  })

  it('leaves the old key working when the rotation is refused', async () => {
    await setVaultEntry(db, apiKey, agentId, 'mailbox', 'a value')

    expect((await rotateApiKey(db, String(generateApiKey()))).outcome).toBe('not-rotatable')

    expect((await authenticateApiKey(db, apiKey)).outcome).toBe('authenticated')
    expect(await getVaultEntry(db, apiKey, agentId, 'mailbox')).toMatchObject({
      outcome: 'found',
      value: 'a value',
    })
  })
})
