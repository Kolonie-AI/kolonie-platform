import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { RegisterAgentRequestSchema, VAULT_MAX_ENTRIES, type AgentId } from '@kolonie-ai/core'
import { generateApiKey } from '../api-key.js'
import type { Database } from '../client.js'
import { agentVault } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import { deleteVaultEntry, getVaultEntry, listVaultEntries, setVaultEntry } from './vault.js'

const target = databaseTestTarget()

if (!target.available) {
  console.warn(`\n${target.reason}\n`)
}

describe.skipIf(!target.available)('the vault', () => {
  let db: Database
  let agentId: AgentId
  let otherId: AgentId
  let token: string
  let otherToken: string

  beforeAll(async () => {
    if (!target.available) return
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    if (!target.available) return
    await db.$client.end()
  })

  beforeEach(async () => {
    await truncateAll(db)

    token = String(generateApiKey())
    otherToken = String(generateApiKey())

    agentId = await register('keeper')
    otherId = await register('stranger')
  })

  const register = async (name: string): Promise<AgentId> => {
    const result = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name, platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    return result.agent.id
  }

  it('gives back what was stored, to the key that stored it', async () => {
    const stored = await setVaultEntry(db, token, agentId, 'email', 'hunter2')
    expect(stored.outcome).toBe('stored')

    const read = await getVaultEntry(db, token, agentId, 'email')

    expect(read).toMatchObject({ outcome: 'found', value: 'hunter2' })
  })

  it('says whether a write created an entry or replaced one', async () => {
    const first = await setVaultEntry(db, token, agentId, 'email', 'hunter2')
    const second = await setVaultEntry(db, token, agentId, 'email', 'hunter3')

    expect(first).toMatchObject({ outcome: 'stored', created: true })
    expect(second).toMatchObject({ outcome: 'stored', created: false })

    // One row, not two: the unique index makes the second write an upsert.
    const rows = await db.select().from(agentVault).where(eq(agentVault.agentId, agentId))
    expect(rows).toHaveLength(1)

    const read = await getVaultEntry(db, token, agentId, 'email')
    expect(read).toMatchObject({ outcome: 'found', value: 'hunter3' })
  })

  /**
   * The acceptance criterion of `#98`, at the layer that actually stores bytes.
   *
   * `vault-crypto.test.ts` proves the primitive; this proves that what lands in
   * the column is the sealed form and nothing beside it. A row that also carried
   * the plaintext somewhere would pass every test above.
   */
  it('stores nothing the database itself can read', async () => {
    await setVaultEntry(db, token, agentId, 'github', 'ghp_a_secret_value')

    const [row] = await db.select().from(agentVault).where(eq(agentVault.agentId, agentId))

    expect(row).toBeDefined()
    expect(JSON.stringify(row)).not.toContain('ghp_a_secret_value')
    expect(JSON.stringify(row)).not.toContain(token)
    // The name is plaintext on purpose — see the column comment in `schema/vault.ts`.
    expect(row?.key).toBe('github')
  })

  it('will not open an entry for a different key', async () => {
    await setVaultEntry(db, token, agentId, 'email', 'hunter2')

    expect(await getVaultEntry(db, otherToken, agentId, 'email')).toEqual({
      outcome: 'unreadable',
    })
  })

  it('keeps one citizen’s entries out of another’s reach', async () => {
    await setVaultEntry(db, token, agentId, 'email', 'hunter2')

    // Same name, different citizen: not found rather than unreadable, because
    // the row genuinely is not theirs to have.
    expect(await getVaultEntry(db, otherToken, otherId, 'email')).toEqual({ outcome: 'unknown' })
    expect(await listVaultEntries(db, otherId)).toEqual([])
  })

  it('lets two citizens hold the same name independently', async () => {
    await setVaultEntry(db, token, agentId, 'email', 'mine')
    await setVaultEntry(db, otherToken, otherId, 'email', 'theirs')

    expect(await getVaultEntry(db, token, agentId, 'email')).toMatchObject({ value: 'mine' })
    expect(await getVaultEntry(db, otherToken, otherId, 'email')).toMatchObject({ value: 'theirs' })
  })

  it('answers unknown for a name that was never stored', async () => {
    expect(await getVaultEntry(db, token, agentId, 'never-written')).toEqual({ outcome: 'unknown' })
  })

  it('lists names without needing the key, oldest first', async () => {
    await setVaultEntry(db, token, agentId, 'email', 'one')
    await setVaultEntry(db, token, agentId, 'github', 'two')

    const entries = await listVaultEntries(db, agentId)

    expect(entries.map((entry) => entry.key)).toEqual(['email', 'github'])
    // Nothing here is a value, and nothing here was decrypted to produce it.
    expect(JSON.stringify(entries)).not.toContain('one')
  })

  it('forgets an entry, and says whether there was one to forget', async () => {
    await setVaultEntry(db, token, agentId, 'email', 'hunter2')

    expect(await deleteVaultEntry(db, agentId, 'email')).toBe(true)
    expect(await deleteVaultEntry(db, agentId, 'email')).toBe(false)
    expect(await getVaultEntry(db, token, agentId, 'email')).toEqual({ outcome: 'unknown' })
  })

  it('lets an entry sealed with a lost key be cleared out', async () => {
    // The one operation that must work without the sealing key. An agent that
    // cannot read an entry and cannot delete it either would be stuck with a
    // name it can never reuse.
    await setVaultEntry(db, token, agentId, 'email', 'hunter2')

    expect(await getVaultEntry(db, otherToken, agentId, 'email')).toEqual({ outcome: 'unreadable' })
    expect(await deleteVaultEntry(db, agentId, 'email')).toBe(true)
  })

  it('refuses a new entry once the citizen is at the quota', async () => {
    for (let index = 0; index < VAULT_MAX_ENTRIES; index += 1) {
      const stored = await setVaultEntry(db, token, agentId, `key-${index}`, 'value')
      expect(stored.outcome).toBe('stored')
    }

    expect(await setVaultEntry(db, token, agentId, 'one-too-many', 'value')).toEqual({
      outcome: 'full',
      maxEntries: VAULT_MAX_ENTRIES,
    })
  })

  it('still lets a full vault replace an entry it already holds', async () => {
    for (let index = 0; index < VAULT_MAX_ENTRIES; index += 1) {
      await setVaultEntry(db, token, agentId, `key-${index}`, 'value')
    }

    // An agent whose token expired and cannot rewrite it because the vault is
    // full would be stuck in the worst possible way — so the quota gates new
    // names only.
    const replaced = await setVaultEntry(db, token, agentId, 'key-0', 'rotated')

    expect(replaced).toMatchObject({ outcome: 'stored', created: false })
    expect(await getVaultEntry(db, token, agentId, 'key-0')).toMatchObject({ value: 'rotated' })
  })

  it('stores a value at the size an agent is allowed to write', async () => {
    const large = 'x'.repeat(8 * 1024)

    await setVaultEntry(db, token, agentId, 'large', large)

    expect(await getVaultEntry(db, token, agentId, 'large')).toMatchObject({ value: large })
  })
})
