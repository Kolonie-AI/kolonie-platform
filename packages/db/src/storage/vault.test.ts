import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  RegisterAgentRequestSchema,
  VAULT_MAX_ENTRIES,
  VAULT_PAGE_SIZE,
  type AgentId,
} from '@kolonie-ai/core'
import { generateApiKey } from '../api-key.js'
import type { Database } from '../client.js'
import { agentVault } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import {
  deleteVaultEntry,
  getVaultEntry,
  listVaultEntries,
  setVaultDescription,
  setVaultEntry,
  vaultEntryCount,
} from './vault.js'

const target = databaseTestTarget()

/** One page, or a thrown failure — the tests below are never about a bad cursor. */
const asListed = (
  outcome: Awaited<ReturnType<typeof listVaultEntries>>,
): Extract<typeof outcome, { outcome: 'listed' }> => {
  if (outcome.outcome !== 'listed') throw new Error(outcome.outcome)
  return outcome
}

describe('the vault', () => {
  let db: Database
  let agentId: AgentId
  let otherId: AgentId
  let token: string
  let otherToken: string

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db.$client.end()
  })

  beforeEach(async () => {
    await truncateAll(db)

    token = String(generateApiKey())
    otherToken = String(generateApiKey())

    agentId = await register('keeper')
    otherId = await register('stranger')
  })

  /**
   * Fill a vault to the quota without a thousand round trips (`#1872`).
   *
   * One statement rather than one write per entry: the rows are what these
   * boundary tests need, and sealing a thousand values would spend a minute of
   * wall clock proving something `vault-crypto` already asserts. The one entry
   * the tests write through `setVaultEntry` is what keeps the write path
   * exercised.
   */
  const fillToQuota = async (howMany: number = VAULT_MAX_ENTRIES): Promise<void> => {
    const rows = Array.from({ length: howMany }, (_unused, index) => ({
      agentId,
      key: `key-${String(index).padStart(4, '0')}`,
      encryptedValue: 'not-openable-and-not-read-by-these-tests',
    }))
    await db.insert(agentVault).values(rows)
  }

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
    expect(await listVaultEntries(db, otherToken, otherId)).toMatchObject({ entries: [] })
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

  it('lists names and descriptions, never values, oldest first', async () => {
    await setVaultEntry(db, token, agentId, 'email', 'one')
    await setVaultEntry(db, token, agentId, 'github', 'two')

    const { entries } = asListed(await listVaultEntries(db, token, agentId))

    expect(entries.map((entry) => entry.key)).toEqual(['email', 'github'])
    // **No value is here and none was decrypted to produce this.** What #154
    // changed is that descriptions are opened; the values are what the list has
    // always been careful about and still is.
    expect(JSON.stringify(entries)).not.toContain('one')
  })

  /**
   * The description, sealed like the value and returned by the list (`#154`).
   *
   * The failure being repaired is an agent waking to a list of bare labels it
   * cannot tell apart — so a description it would have to fetch per entry would
   * not be read, and one in the clear would hand an operator with database
   * access the usable profile the plaintext key deliberately stops short of.
   */
  describe('what an entry says it is', () => {
    it('comes back in the listing, decrypted, beside the name', async () => {
      await setVaultEntry(db, token, agentId, 'email', 'hunter2', 'the mailbox at mail.example')

      const [entry] = asListed(await listVaultEntries(db, token, agentId)).entries

      expect(entry).toMatchObject({ key: 'email', description: 'the mailbox at mail.example' })
    })

    it('is stored sealed, not in the clear', async () => {
      await setVaultEntry(db, token, agentId, 'email', 'hunter2', 'user citizen@mail.example')

      const [row] = await db
        .select({ description: agentVault.encryptedDescription })
        .from(agentVault)
        .where(eq(agentVault.agentId, agentId))

      expect(row?.description).not.toContain('citizen@mail.example')
      expect(row?.description).toContain('.')
    })

    it('lists as absent for an entry written before descriptions existed', async () => {
      await setVaultEntry(db, token, agentId, 'email', 'hunter2')

      const [entry] = asListed(await listVaultEntries(db, token, agentId)).entries

      expect(entry?.description).toBeNull()
    })

    /**
     * A description this token cannot open is an absence rather than a failure.
     * One unopenable row must not take down the listing of the sixty-three that
     * open — and a citizen that has rotated a key is exactly the one that needs
     * the list.
     */
    it('lists as absent under a key that did not write it, without failing', async () => {
      await setVaultEntry(db, token, agentId, 'email', 'hunter2', 'the mailbox')

      const { entries } = asListed(await listVaultEntries(db, otherToken, agentId))

      expect(entries).toHaveLength(1)
      expect(entries[0]?.description).toBeNull()
    })

    it('is replaced without the value being re-sent', async () => {
      await setVaultEntry(db, token, agentId, 'email', 'hunter2', 'first words')

      const described = await setVaultDescription(db, token, agentId, 'email', 'second words')

      expect(described).toMatchObject({ outcome: 'described' })
      expect(await getVaultEntry(db, token, agentId, 'email')).toMatchObject({
        value: 'hunter2',
        entry: { description: 'second words' },
      })
    })

    it('is cleared with null, leaving the value alone', async () => {
      await setVaultEntry(db, token, agentId, 'email', 'hunter2', 'first words')

      await setVaultDescription(db, token, agentId, 'email', null)

      expect(await getVaultEntry(db, token, agentId, 'email')).toMatchObject({
        value: 'hunter2',
        entry: { description: null },
      })
    })

    /**
     * Rotating a token must not silently drop the description — the entry is
     * being maintained at exactly that moment, which is the worst time to lose
     * what it is.
     */
    it('survives a value being replaced without one', async () => {
      await setVaultEntry(db, token, agentId, 'email', 'hunter2', 'the mailbox')

      await setVaultEntry(db, token, agentId, 'email', 'hunter3')

      expect(await getVaultEntry(db, token, agentId, 'email')).toMatchObject({
        value: 'hunter3',
        entry: { description: 'the mailbox' },
      })
    })

    it('refuses to describe an entry that does not exist', async () => {
      expect(await setVaultDescription(db, token, agentId, 'never-written', 'x')).toEqual({
        outcome: 'unknown',
      })
    })

    /** One page lists with every description, which is the bounded cost. */
    it('lists one page of a vault with its descriptions', async () => {
      for (let index = 0; index < VAULT_PAGE_SIZE; index += 1) {
        await setVaultEntry(db, token, agentId, `entry-${index}`, 'x', `number ${index}`)
      }

      const page = asListed(await listVaultEntries(db, token, agentId))

      expect(page.entries).toHaveLength(VAULT_PAGE_SIZE)
      expect(page.entries.every((entry) => entry.description !== null)).toBe(true)
    })
  })

  /**
   * The bound moved from the quota to the page when the quota rose (`#1872`).
   *
   * At 1024 entries a whole listing is roughly 681 KB of maximum-length
   * descriptions, which is ten times what a runtime has been measured to
   * refuse. So a listing is a page and the rest is reachable through a cursor:
   * a page nobody can follow would lose the entries past the first.
   */
  describe('paging a listing', () => {
    const storeMany = async (howMany: number): Promise<void> => {
      for (let index = 0; index < howMany; index += 1) {
        await setVaultEntry(db, token, agentId, `key-${String(index).padStart(4, '0')}`, 'value')
      }
    }

    it('serves at most one page and says there is more', async () => {
      await storeMany(VAULT_PAGE_SIZE + 3)

      const page = asListed(await listVaultEntries(db, token, agentId))

      expect(page.entries).toHaveLength(VAULT_PAGE_SIZE)
      expect(page.nextCursor).not.toBeNull()
    })

    it('walks every entry exactly once through the cursor', async () => {
      await storeMany(VAULT_PAGE_SIZE + 3)

      const seen: string[] = []
      let cursor: string | undefined
      do {
        const page = asListed(await listVaultEntries(db, token, agentId, { cursor }))
        seen.push(...page.entries.map((entry) => entry.key))
        cursor = page.nextCursor ?? undefined
      } while (cursor !== undefined)

      expect(seen).toHaveLength(VAULT_PAGE_SIZE + 3)
      expect(new Set(seen).size).toBe(VAULT_PAGE_SIZE + 3)
    })

    it('ends the walk rather than offering a cursor onto nothing', async () => {
      await storeMany(2)

      const page = asListed(await listVaultEntries(db, token, agentId))

      expect(page.entries).toHaveLength(2)
      expect(page.nextCursor).toBeNull()
    })

    it('refuses a cursor it did not write', async () => {
      await storeMany(1)

      expect(await listVaultEntries(db, token, agentId, { cursor: 'not-a-cursor' })).toEqual({
        outcome: 'invalid-cursor',
      })
    })
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
    await fillToQuota()

    expect(await setVaultEntry(db, token, agentId, 'one-too-many', 'value')).toEqual({
      outcome: 'full',
      maxEntries: VAULT_MAX_ENTRIES,
    })
  })

  /**
   * The boundary the raise is about: the last entry is stored and the first
   * refusal comes after it, whatever the ceiling happens to be (`#1872`).
   */
  it('stores the last entry below the quota and refuses only the one past it', async () => {
    await fillToQuota(VAULT_MAX_ENTRIES - 1)

    expect(await vaultEntryCount(db, agentId)).toBe(VAULT_MAX_ENTRIES - 1)
    expect(await setVaultEntry(db, token, agentId, 'the-last-one', 'value')).toMatchObject({
      outcome: 'stored',
      created: true,
    })
    expect(await setVaultEntry(db, token, agentId, 'one-too-many', 'value')).toEqual({
      outcome: 'full',
      maxEntries: VAULT_MAX_ENTRIES,
    })
  })

  it('still lets a full vault replace an entry it already holds', async () => {
    await fillToQuota()

    // An agent whose token expired and cannot rewrite it because the vault is
    // full would be stuck in the worst possible way — so the quota gates new
    // names only.
    const replaced = await setVaultEntry(db, token, agentId, 'key-0000', 'rotated')

    expect(replaced).toMatchObject({ outcome: 'stored', created: false })
    expect(await getVaultEntry(db, token, agentId, 'key-0000')).toMatchObject({
      value: 'rotated',
    })
  })

  it('stores a value at the size an agent is allowed to write', async () => {
    const large = 'x'.repeat(8 * 1024)

    await setVaultEntry(db, token, agentId, 'large', large)

    expect(await getVaultEntry(db, token, agentId, 'large')).toMatchObject({ value: large })
  })
})
