import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { RegisterAgentRequestSchema, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import type * as VaultCrypto from '../vault-crypto.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import { authenticateApiKey } from './authentication.js'
import { rotateApiKey } from './rotation.js'
import { getVaultEntry, setVaultEntry } from './vault.js'

/**
 * A switch the mock below reads, so the fixture can be written normally and only
 * the re-seal fails. `vi.hoisted` because `vi.mock` factories run before the
 * module body.
 */
const failing = vi.hoisted(() => ({ now: false }))

vi.mock('../vault-crypto.js', async (importOriginal) => {
  const real = await importOriginal<typeof VaultCrypto>()
  return {
    ...real,
    sealVaultValue: (...args: Parameters<typeof real.sealVaultValue>) => {
      if (failing.now) throw new Error('the cipher fell over mid-rotation')
      return real.sealVaultValue(...args)
    },
  }
})

const target = databaseTestTarget()

/**
 * `#1127`'s worst outcome, made impossible: a rotation that half-succeeded.
 *
 * Re-sealing happens inside the transaction that swaps the key, so a failure
 * anywhere in it takes the new credential down with it. The citizen is left with
 * the key it started with and a vault that still opens under it — which is a
 * rotation it may simply call again, rather than a citizen locked out of both.
 *
 * The failure is forced at the cipher rather than at the database, because a
 * constraint violation would prove the transaction rolls back and this needs to
 * prove that *anything* thrown between the swap and the commit does.
 */
describe('a re-seal that fails leaves the old key live (#1127)', () => {
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
    failing.now = false
    await truncateAll(db)

    const registered = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name: 'keeper', platform: 'openclaw' }),
    )
    if (registered.outcome !== 'registered') throw new Error(registered.outcome)

    agentId = registered.agent.id
    apiKey = String(registered.credentials.apiKey)
  })

  it('rolls the whole rotation back, vault and credential together', async () => {
    await setVaultEntry(db, apiKey, agentId, 'mailbox', 'a value')

    failing.now = true
    await expect(rotateApiKey(db, apiKey)).rejects.toThrow()
    failing.now = false

    // The credential the citizen is holding still authenticates: nothing was
    // revoked, so it has not been locked out while its key is compromised.
    expect((await authenticateApiKey(db, apiKey)).outcome).toBe('authenticated')
    // And the entry still opens under it, which is the half a rollback that
    // covered only the `credentials` table would have missed.
    expect(await getVaultEntry(db, apiKey, agentId, 'mailbox')).toMatchObject({
      outcome: 'found',
      value: 'a value',
    })
  })

  it('can be rotated again once whatever failed stops failing', async () => {
    await setVaultEntry(db, apiKey, agentId, 'mailbox', 'a value')

    failing.now = true
    await expect(rotateApiKey(db, apiKey)).rejects.toThrow()
    failing.now = false

    const rotated = await rotateApiKey(db, apiKey)
    expect(rotated.outcome).toBe('rotated')
    if (rotated.outcome !== 'rotated') return

    expect(rotated.vault).toEqual({ resealed: 1, unreadable: 0 })
    expect(
      await getVaultEntry(db, String(rotated.credentials.apiKey), agentId, 'mailbox'),
    ).toMatchObject({ outcome: 'found', value: 'a value' })
  })
})
