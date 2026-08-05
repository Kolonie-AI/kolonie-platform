import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { MAX_DROP_ATTEMPTS, VAULT_MAX_ENTRIES, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agentVault, agents, operatorDrops, tasks } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { openVaultValue } from '../vault-crypto.js'
import { listDrops, openDrop, submitDrop, takeDrop, viewDrop } from './operator-drops.js'

const target = databaseTestTarget()

/** Not a real key and not shaped like one. Nothing here reaches a vendor. */
const SEALING_KEY = 'test-sealing-key-that-is-long-enough-0123456789'
const AGENT_KEY = 'test-agent-api-key-0123456789abcdefghijklmnop'

/**
 * The value the whole file is about.
 *
 * Distinctive on purpose: the last test searches everything that was persisted
 * for it, and a value like `secret` would collide with the word in a column name.
 */
const SECRET = 'correct-horse-battery-staple-9f3a1c'

describe('the operator drop', () => {
  let db: Database
  let agentId: AgentId

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
    const [row] = await db
      .insert(agents)
      .values({ name: 'colette', platform: 'openclaw' })
      .returning({ id: agents.id })
    if (row === undefined) throw new Error('inserting an agent returned no row')
    agentId = row.id as AgentId
  })

  const aCredentialDrop = async (vaultKey = 'mailbox-password') =>
    openDrop(db, { agentId, kind: 'credential', prompt: 'The mailbox password', vaultKey })

  describe('what the operator can see', () => {
    it('shows the citizen’s name and what it asked for, and nothing else', async () => {
      const drop = await aCredentialDrop()

      expect(await viewDrop(db, drop.token)).toEqual({
        agentName: 'colette',
        kind: 'credential',
        prompt: 'The mailbox password',
      })
    })

    it('answers nothing for a token that never named anything', async () => {
      expect(await viewDrop(db, 'not-a-token')).toBeNull()
    })

    it('answers nothing once it has been answered', async () => {
      const drop = await aCredentialDrop()
      await submitDrop(db, drop.token, SECRET, SEALING_KEY)

      expect(await viewDrop(db, drop.token)).toBeNull()
    })

    it('answers nothing after it expires', async () => {
      const drop = await aCredentialDrop()
      await db
        .update(operatorDrops)
        .set({ expiresAt: sql`now() - interval '1 minute'` })
        .where(eq(operatorDrops.id, drop.id))

      expect(await viewDrop(db, drop.token)).toBeNull()
    })

    it('stores no token, only its hash — a dump yields no working link', async () => {
      const drop = await aCredentialDrop()
      const [row] = await db.select().from(operatorDrops).where(eq(operatorDrops.id, drop.id))

      expect(row?.tokenHash).not.toBe(drop.token)
      expect(JSON.stringify(row)).not.toContain(drop.token)
    })
  })

  describe('submitting', () => {
    it('accepts once and refuses the second time', async () => {
      const drop = await aCredentialDrop()

      expect(await submitDrop(db, drop.token, SECRET, SEALING_KEY)).toEqual({ outcome: 'accepted' })
      expect(await submitDrop(db, drop.token, 'a-second-value', SEALING_KEY)).toEqual({
        outcome: 'closed',
      })
    })

    it('refuses after expiry', async () => {
      const drop = await aCredentialDrop()
      await db
        .update(operatorDrops)
        .set({ expiresAt: sql`now() - interval '1 minute'` })
        .where(eq(operatorDrops.id, drop.id))

      expect(await submitDrop(db, drop.token, SECRET, SEALING_KEY)).toEqual({ outcome: 'closed' })
    })

    it('stops listening after the attempt limit, so the field is not an oracle', async () => {
      const drop = await aCredentialDrop()
      await db
        .update(operatorDrops)
        .set({ attempts: MAX_DROP_ATTEMPTS })
        .where(eq(operatorDrops.id, drop.id))

      expect(await submitDrop(db, drop.token, SECRET, SEALING_KEY)).toEqual({ outcome: 'closed' })
    })

    it('counts the attempt even when the value is refused', async () => {
      const drop = await aCredentialDrop()
      await db.insert(agentVault).values({
        agentId,
        key: 'mailbox-password',
        encryptedValue: 'k1.whatever',
      })

      await submitDrop(db, drop.token, SECRET, SEALING_KEY)

      const [row] = await db.select().from(operatorDrops).where(eq(operatorDrops.id, drop.id))
      expect(row?.attempts).toBe(1)
    })

    it('refuses an occupied vault key rather than overwriting it', async () => {
      await db.insert(agentVault).values({
        agentId,
        key: 'mailbox-password',
        encryptedValue: 'k1.something-the-agent-relies-on',
      })
      const drop = await aCredentialDrop()

      expect(await submitDrop(db, drop.token, SECRET, SEALING_KEY)).toEqual({
        outcome: 'key-taken',
        vaultKey: 'mailbox-password',
      })

      const [held] = await db.select().from(agentVault).where(eq(agentVault.agentId, agentId))
      expect(held?.encryptedValue).toBe('k1.something-the-agent-relies-on')
    })

    it('refuses when the citizen’s vault is full, before anything is kept', async () => {
      await db.insert(agentVault).values(
        Array.from({ length: VAULT_MAX_ENTRIES }, (_, index) => ({
          agentId,
          key: `entry-${index}`,
          encryptedValue: 'k1.filler',
        })),
      )
      const drop = await aCredentialDrop()

      expect(await submitDrop(db, drop.token, SECRET, SEALING_KEY)).toEqual({
        outcome: 'vault-full',
        maxEntries: VAULT_MAX_ENTRIES,
      })

      const [row] = await db.select().from(operatorDrops).where(eq(operatorDrops.id, drop.id))
      expect(row?.sealedValue).toBeNull()
    })

    it('lets exactly one of two concurrent submissions win', async () => {
      const drop = await aCredentialDrop()

      const results = await Promise.all([
        submitDrop(db, drop.token, SECRET, SEALING_KEY),
        submitDrop(db, drop.token, 'the-other-one', SEALING_KEY),
      ])

      expect(results.filter((result) => result.outcome === 'accepted')).toHaveLength(1)
      expect(results.filter((result) => result.outcome === 'closed')).toHaveLength(1)
    })
  })

  describe('taking it', () => {
    it('hands a code back once and then holds nothing', async () => {
      const [task] = await db
        .insert(tasks)
        .values({
          type: 'sms-receive',
          title: 'A code',
          kind: 'academy',
          description: 'Whatever this rung is for.',
          instructions: 'What the agent must actually do.',
          rewardCredits: 0,
          rewardReputation: 1,
          timeoutHours: 24,
        })
        .returning({ id: tasks.id })
      const drop = await openDrop(db, {
        agentId,
        kind: 'code',
        prompt: 'The code we just sent you',
        taskId: task?.id as never,
      })
      await submitDrop(db, drop.token, '481920', SEALING_KEY)

      const taken = await takeDrop(db, agentId, drop.id, SEALING_KEY, AGENT_KEY)

      expect(taken).toMatchObject({ outcome: 'taken', kind: 'code', code: '481920' })
      expect(await takeDrop(db, agentId, drop.id, SEALING_KEY, AGENT_KEY)).toEqual({
        outcome: 'nothing',
      })
    })

    it('puts a credential in the vault sealed with the agent’s own key, and answers without it', async () => {
      const drop = await aCredentialDrop()
      await submitDrop(db, drop.token, SECRET, SEALING_KEY)

      const taken = await takeDrop(db, agentId, drop.id, SEALING_KEY, AGENT_KEY)

      expect(taken).toMatchObject({
        outcome: 'taken',
        kind: 'credential',
        code: null,
        vaultKey: 'mailbox-password',
      })

      const [entry] = await db.select().from(agentVault).where(eq(agentVault.agentId, agentId))
      expect(
        openVaultValue(AGENT_KEY, String(agentId), 'mailbox-password', entry?.encryptedValue ?? ''),
      ).toBe(SECRET)
      // And the Colony's own key does not open the vault row. The value moved
      // from one sealing to the other rather than being copied into both.
      expect(
        openVaultValue(
          SEALING_KEY,
          String(agentId),
          'mailbox-password',
          entry?.encryptedValue ?? '',
        ),
      ).toBeNull()
    })

    it('answers nothing for another citizen’s drop', async () => {
      const [other] = await db
        .insert(agents)
        .values({ name: 'somebody-else', platform: 'openclaw' })
        .returning({ id: agents.id })
      const drop = await aCredentialDrop()
      await submitDrop(db, drop.token, SECRET, SEALING_KEY)

      expect(await takeDrop(db, other?.id as AgentId, drop.id, SEALING_KEY, AGENT_KEY)).toEqual({
        outcome: 'nothing',
      })
    })

    it('answers nothing while the operator has not answered', async () => {
      const drop = await aCredentialDrop()

      expect(await takeDrop(db, agentId, drop.id, SEALING_KEY, AGENT_KEY)).toEqual({
        outcome: 'nothing',
      })
    })

    it('says unreadable — not nothing — when the deployment’s key changed', async () => {
      const drop = await aCredentialDrop()
      await submitDrop(db, drop.token, SECRET, SEALING_KEY)

      const taken = await takeDrop(
        db,
        agentId,
        drop.id,
        'a-different-key-entirely-0123456789abcdefgh',
        AGENT_KEY,
      )

      expect(taken).toEqual({ outcome: 'unreadable' })
    })

    it('refuses if the agent occupied the key itself after the operator answered', async () => {
      const drop = await aCredentialDrop()
      await submitDrop(db, drop.token, SECRET, SEALING_KEY)
      await db.insert(agentVault).values({
        agentId,
        key: 'mailbox-password',
        encryptedValue: 'k1.the-agent-got-there-first',
      })

      expect(await takeDrop(db, agentId, drop.id, SEALING_KEY, AGENT_KEY)).toEqual({
        outcome: 'nothing',
      })
    })

    it('lets exactly one of two concurrent reads win', async () => {
      const drop = await aCredentialDrop()
      await submitDrop(db, drop.token, SECRET, SEALING_KEY)

      const results = await Promise.all([
        takeDrop(db, agentId, drop.id, SEALING_KEY, AGENT_KEY),
        takeDrop(db, agentId, drop.id, SEALING_KEY, AGENT_KEY),
      ])

      expect(results.filter((result) => result.outcome === 'taken')).toHaveLength(1)
    })
  })

  describe('listing', () => {
    it('says what is waiting and never what is in it', async () => {
      const drop = await aCredentialDrop()
      await submitDrop(db, drop.token, SECRET, SEALING_KEY)

      const listed = await listDrops(db, agentId)

      expect(listed).toHaveLength(1)
      expect(listed[0]?.submittedAt).not.toBeNull()
      expect(JSON.stringify(listed)).not.toContain(SECRET)
    })

    it('drops a taken one out of the listing', async () => {
      const drop = await aCredentialDrop()
      await submitDrop(db, drop.token, SECRET, SEALING_KEY)
      await takeDrop(db, agentId, drop.id, SEALING_KEY, AGENT_KEY)

      expect(await listDrops(db, agentId)).toHaveLength(0)
    })
  })

  describe('what a database dump would yield', () => {
    /**
     * **The assertion this whole channel rests on**, and it is made by searching
     * what was written rather than by reading the code — which is the acceptance
     * criterion `#410` states, and the only version of this test that keeps being
     * true after somebody adds a column.
     */
    it('has the value in plaintext in no column of any table, at any point', async () => {
      const drop = await aCredentialDrop()

      const dumps: string[] = []
      const dump = async (): Promise<void> => {
        const tables = await db.execute<{ table_name: string }>(sql`
          select table_name from information_schema.tables
          where table_schema = 'public' and table_type = 'BASE TABLE'
        `)
        for (const { table_name: name } of tables) {
          const rows = await db.execute(sql.raw(`select * from "${name}"`))
          dumps.push(JSON.stringify(rows))
        }
      }

      await dump()
      await submitDrop(db, drop.token, SECRET, SEALING_KEY)
      await dump()
      await takeDrop(db, agentId, drop.id, SEALING_KEY, AGENT_KEY)
      await dump()

      expect(dumps.join('\n')).not.toContain(SECRET)
    })

    it('clears the ciphertext once it has been taken', async () => {
      const drop = await aCredentialDrop()
      await submitDrop(db, drop.token, SECRET, SEALING_KEY)
      await takeDrop(db, agentId, drop.id, SEALING_KEY, AGENT_KEY)

      const [row] = await db.select().from(operatorDrops).where(eq(operatorDrops.id, drop.id))
      expect(row?.sealedValue).toBeNull()
      // The record that it happened stays. A row without its value names nothing.
      expect(row?.readAt).not.toBeNull()
    })
  })
})
