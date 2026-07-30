import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { AgentIdSchema, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget } from '../testing.js'
import { banMarkHash } from '../ban-salt.js'
import {
  agentSkills,
  agents,
  banMarks,
  emailChallenges,
  erasures,
  ledgerEntries,
  reputationEvents,
  solanaWalletChallenges,
  submissions,
  tasks,
  verifications,
} from '../schema/index.js'
import { eraseAgent } from './erasure.js'
import { setVaultEntry } from './vault.js'

const target = databaseTestTarget()

if (!target.available) {
  console.warn(`\n${target.reason}\n`)
}

const SALT = 'a'.repeat(32)

/**
 * `eraseAgent` (#91): the transaction that makes the right in `GOVERNANCE.md`
 * real.
 *
 * The tests that matter here are the ones about **what must not happen** —
 * supply moving, a partial erasure surviving a failure, a ban being escaped, a
 * sponsor's money being destroyed. The happy path is one assertion; the rest of
 * this file is the promise.
 */
describe.skipIf(!target.available)('erasing a citizen', () => {
  let db: Database

  beforeAll(async () => {
    if (!target.available) return
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await db.execute(
      sql`truncate table erasures, ban_marks, moderations, tip_feedback, task_tips, task_struggles,
                        support_tickets, task_resets, reputation_events, ledger_entries,
                        agent_skills, verifications, submissions, credentials,
                        browser_challenges, email_challenges, github_challenges, social_challenges,
                        key_challenges, solana_wallet_challenges, pow_challenges,
                        vision_challenges, website_challenges, tasks, agents
                  restart identity cascade`,
    )
  })

  const anAgent = async (overrides: Partial<typeof agents.$inferInsert> = {}) => {
    const [row] = await db
      .insert(agents)
      .values({ name: 'leaver', platform: 'openclaw', ...overrides })
      .returning()
    // Branded here rather than at each call site: `agents.id` is a bare `uuid`
    // column, and `eraseAgent` takes an `AgentId`.
    return { ...row!, id: AgentIdSchema.parse(row!.id) }
  }

  const aTask = async () => {
    const [row] = await db
      .insert(tasks)
      .values({
        type: 'email-create',
        title: 'Create an email address',
        description: 'Prove you can operate your own mailbox.',
        instructions: 'Create an address and send a mail to the given recipient.',
        rewardCoins: 0,
        rewardReputation: 5,
        timeoutHours: 24,
        status: 'active',
      })
      .returning()
    return row!
  }

  /** A reward, booked the way `bookTaskReward` books one. */
  const reward = async (agentId: AgentId, coins: number) => {
    const transactionId = randomUUID()
    await db.transaction(async (tx) => {
      await tx.insert(ledgerEntries).values([
        { transactionId, accountKind: 'agent', agentId, amount: coins, type: 'task_reward' },
        {
          transactionId,
          accountKind: 'system',
          systemAccount: 'mint',
          amount: -coins,
          type: 'task_reward',
        },
      ])
    })
  }

  /** Total supply, as `economy.md` §3 defines it: the negative of the mint balance. */
  const totalSupply = async () => {
    const rows = await db.execute<{ total: string }>(
      sql`select coalesce(-sum(amount), 0)::text as total
            from ledger_entries where system_account = 'mint'`,
    )
    return Number(rows[0]!.total)
  }

  const countIn = async (table: string) => {
    const rows = await db.execute<{ count: string }>(
      sql`select count(*)::text as count from ${sql.identifier(table)}`,
    )
    return Number(rows[0]!.count)
  }

  describe('the ordinary case', () => {
    it('erases a candidate that earned nothing, and says so', async () => {
      const agent = await anAgent()

      const result = await eraseAgent(db, { agentId: agent.id, banSalt: SALT })

      expect(result.outcome).toBe('erased')
      if (result.outcome !== 'erased') return
      expect(result.receipt.coinsBurned).toBe(0)
      expect(result.receipt.reputationDestroyed).toBe(0)
      expect(result.receipt.banMarksWritten).toBe(0)
      expect(await countIn('agents')).toBe(0)
      expect(await countIn('erasures')).toBe(1)
    })

    it('burns the balance, destroys the reputation, and leaves one anonymous row', async () => {
      const agent = await anAgent()
      await reward(agent.id, 120)
      await db
        .insert(reputationEvents)
        .values({ agentId: agent.id, delta: 15, reason: 'task_passed' })

      const result = await eraseAgent(db, {
        agentId: agent.id,
        reason: 'finished',
        banSalt: SALT,
      })

      expect(result.outcome).toBe('erased')
      if (result.outcome !== 'erased') return
      expect(result.receipt.coinsBurned).toBe(120)
      expect(result.receipt.reputationDestroyed).toBe(15)

      const [row] = await db.select().from(erasures)
      expect(row?.coinsBurned).toBe(120)
      expect(row?.reputationDestroyed).toBe(15)
      expect(row?.reason).toBe('finished')
    })

    /**
     * **The invariant the whole design claims**, and the one that should fail
     * loudly if the burn is ever skipped: an erasure destroys the citizen's
     * coins and moves nothing else.
     *
     * Both halves are checked, because only checking supply would pass against
     * an erasure that quietly took a neighbour's balance with it.
     */
    it('destroys the citizen’s coins and moves no other account', async () => {
      const leaver = await anAgent()
      const neighbour = await anAgent({ name: 'neighbour' })
      await reward(leaver.id, 120)
      await reward(neighbour.id, 80)

      expect(await totalSupply()).toBe(200)

      await eraseAgent(db, { agentId: leaver.id, banSalt: SALT })

      expect(await totalSupply()).toBe(80)

      const theirs = await db.execute<{ total: string }>(
        sql`select coalesce(sum(amount), 0)::text as total
              from ledger_entries where agent_id = ${neighbour.id}`,
      )
      expect(Number(theirs[0]!.total)).toBe(80)
    })

    it('names the artefacts it could not reach, before they stop being knowable', async () => {
      const agent = await anAgent()
      const task = await aTask()
      const [submission] = await db
        .insert(submissions)
        .values({
          taskId: task.id,
          agentId: agent.id,
          payload: {},
          status: 'passed',
          verifiedAt: new Date().toISOString(),
        })
        .returning()
      await db.insert(verifications).values({
        submissionId: submission!.id,
        taskType: 'github-account',
        status: 'pass',
        evidence: 'the gist carried the nonce',
        metadata: { url: 'https://gist.github.com/example/abc', author: 'a-login' },
      })

      const result = await eraseAgent(db, { agentId: agent.id, banSalt: SALT })

      expect(result.outcome).toBe('erased')
      if (result.outcome !== 'erased') return
      const github = result.receipt.beyondReach.find((limit) => limit.kind === 'github')
      expect(github?.references).toContain('https://gist.github.com/example/abc')
      // All five categories are always named, including the ones with nothing
      // in them: *you have no social posts* and *we did not check* are different
      // answers, and the citizen is entitled to the first.
      expect(result.receipt.beyondReach).toHaveLength(5)
    })
  })

  describe('a second erasure is not a quiet success', () => {
    it('reports that there is nothing there', async () => {
      const agent = await anAgent()
      await eraseAgent(db, { agentId: agent.id, banSalt: SALT })

      const again = await eraseAgent(db, { agentId: agent.id, banSalt: SALT })

      expect(again.outcome).toBe('no-such-agent')
      // And it did not write a second anonymous row saying a citizen left.
      expect(await countIn('erasures')).toBe(1)
    })

    it('reports the same for an id that was never real', async () => {
      const result = await eraseAgent(db, {
        agentId: AgentIdSchema.parse(randomUUID()),
        banSalt: SALT,
      })
      expect(result.outcome).toBe('no-such-agent')
    })
  })

  describe('a ban survives the account it was against', () => {
    const withProvedIdentifiers = async (agent: typeof agents.$inferSelect) => {
      await db.insert(emailChallenges).values({
        agentId: agent.id,
        address: 'leaver@host.invalid',
        token: 't',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        // A verified mailbox has had post through it — `email_challenges_verified_needs_inbound`.
        inboundAt: new Date().toISOString(),
        code: '123456',
        verifiedAt: new Date().toISOString(),
      })
      await db.insert(solanaWalletChallenges).values({
        agentId: agent.id,
        nonce: randomUUID(),
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        address: 'So11111111111111111111111111111111111111112',
        signature: 'not checked here',
        verifiedAt: new Date().toISOString(),
      })
    }

    it('writes marks for a banned citizen, and they match what the door will ask', async () => {
      const agent = await anAgent({ status: 'banned', registrationFingerprint: 'f'.repeat(64) })
      await withProvedIdentifiers(agent)

      const result = await eraseAgent(db, { agentId: agent.id, banSalt: SALT })

      expect(result.outcome).toBe('erased')
      if (result.outcome !== 'erased') return
      expect(result.receipt.banMarksWritten).toBe(3)

      // The mark is what a registration check would compute, or it protects
      // nothing: a hash nobody can reproduce is a row, not a ban.
      const [mark] = await db
        .select()
        .from(banMarks)
        .where(eq(banMarks.hash, banMarkHash('mailbox', 'leaver@host.invalid', SALT)))
      expect(mark?.kind).toBe('mailbox')

      // No plaintext went in with it.
      const rows = await db.select().from(banMarks)
      for (const row of rows) expect(row.hash).toMatch(/^[0-9a-f]{64}$/)
    })

    it('writes them for a suspended citizen too — the right is not a reward for good behaviour', async () => {
      const agent = await anAgent({ status: 'suspended' })
      await withProvedIdentifiers(agent)

      await eraseAgent(db, { agentId: agent.id, banSalt: SALT })

      expect(await countIn('ban_marks')).toBe(2)
    })

    /**
     * `erasure.md` §4: *"A citizen in good standing that erases itself leaves
     * nothing at all — not a hash, not a marker, nothing that a later
     * registration could collide with."*
     */
    it('leaves nothing at all for a citizen in good standing', async () => {
      const agent = await anAgent({ status: 'citizen', registrationFingerprint: 'f'.repeat(64) })
      await withProvedIdentifiers(agent)

      const result = await eraseAgent(db, { agentId: agent.id, banSalt: SALT })

      expect(result.outcome).toBe('erased')
      if (result.outcome !== 'erased') return
      expect(result.receipt.banMarksWritten).toBe(0)
      expect(await countIn('ban_marks')).toBe(0)
    })

    /**
     * The vault goes with the account (`#98`), by the cascade and not by a line
     * in `eraseAgent`.
     *
     * Asserted rather than assumed, because *"everything else cascades"* is a
     * claim about every table that exists **now** — including the ones added
     * after `#90` was written. A vault row surviving its citizen would be the
     * worst possible leftover: ciphertext nobody can open, tied to an agent id
     * that no longer names anyone, and `erasure.md` §4 promises *nothing at
     * all*. It is also the one table whose contents the Colony could not
     * inspect to discover the mistake.
     */
    it('takes the citizen’s vault with it', async () => {
      const agent = await anAgent({ status: 'citizen' })
      await setVaultEntry(db, 'a-token', agent.id as AgentId, 'email', 'hunter2')
      expect(await countIn('agent_vault')).toBe(1)

      const result = await eraseAgent(db, { agentId: agent.id as AgentId, banSalt: SALT })

      expect(result.outcome).toBe('erased')
      expect(await countIn('agent_vault')).toBe(0)
    })

    /**
     * Two citizens sharing one banned identifier is the case the table exists to
     * catch, so the second erasure must not fail on a mark the first wrote.
     */
    it('does not fail when a mark is already there', async () => {
      for (const name of ['first', 'second']) {
        const agent = await anAgent({ name, status: 'banned' })
        await db.insert(emailChallenges).values({
          agentId: agent.id,
          address: 'shared@host.invalid',
          token: 't',
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          inboundAt: new Date().toISOString(),
          code: '123456',
          verifiedAt: new Date().toISOString(),
        })
        const result = await eraseAgent(db, { agentId: agent.id, banSalt: SALT })
        expect(result.outcome).toBe('erased')
      }

      expect(await countIn('ban_marks')).toBe(1)
    })
  })

  describe('money that is not the citizen’s', () => {
    /**
     * There is no escrow release path, so the only honest answer is to refuse
     * rather than destroy a sponsor's money. `erasure.md` §5: *"Anything a
     * sponsor paid for stays the sponsor's."*
     */
    it('refuses an agent holding an escrowed credit', async () => {
      const agent = await anAgent()
      const transactionId = randomUUID()
      await db.transaction(async (tx) => {
        await tx.insert(ledgerEntries).values([
          {
            transactionId,
            accountKind: 'agent',
            agentId: agent.id,
            amount: 500,
            type: 'task_funding',
          },
          {
            transactionId,
            accountKind: 'system',
            systemAccount: 'mint',
            amount: -500,
            type: 'task_funding',
          },
        ])
      })

      const result = await eraseAgent(db, { agentId: agent.id, banSalt: SALT })

      expect(result.outcome).toBe('entangled-ledger')
      if (result.outcome !== 'entangled-ledger') return
      expect(result.reason).toMatch(/funded by somebody else/)
      // Refused means intact, not half done.
      expect(await countIn('agents')).toBe(1)
      expect(await countIn('erasures')).toBe(0)
    })

    /**
     * The guard #90's tests forced into existence: entries can only be removed a
     * whole booking at a time, so a booking against anything but the mint would
     * take a third party's balance with it.
     */
    it('refuses a transfer between two citizens rather than confiscating one side', async () => {
      const leaver = await anAgent()
      const neighbour = await anAgent({ name: 'neighbour' })
      await reward(leaver.id, 50)

      const transactionId = randomUUID()
      await db.transaction(async (tx) => {
        await tx.insert(ledgerEntries).values([
          {
            transactionId,
            accountKind: 'agent',
            agentId: leaver.id,
            amount: -50,
            type: 'transfer',
          },
          {
            transactionId,
            accountKind: 'agent',
            agentId: neighbour.id,
            amount: 50,
            type: 'transfer',
          },
        ])
      })

      const result = await eraseAgent(db, { agentId: leaver.id, banSalt: SALT })

      expect(result.outcome).toBe('entangled-ledger')
      if (result.outcome !== 'entangled-ledger') return
      expect(result.reason).toMatch(/another citizen/)

      // The neighbour still has what they were sent.
      const theirs = await db.execute<{ total: string }>(
        sql`select coalesce(sum(amount), 0)::text as total
              from ledger_entries where agent_id = ${neighbour.id}`,
      )
      expect(Number(theirs[0]!.total)).toBe(50)
    })
  })

  /**
   * **There is no partially erased state, ever** — the property `erasure.md` §7
   * chose over a soft delete, and the reason there is no purge worker.
   */
  it('leaves everything intact when the transaction fails after the burn', async () => {
    const agent = await anAgent()
    const task = await aTask()
    const [submission] = await db
      .insert(submissions)
      .values({
        taskId: task.id,
        agentId: agent.id,
        payload: {},
        status: 'passed',
        verifiedAt: new Date().toISOString(),
      })
      .returning()
    await db
      .insert(agentSkills)
      .values({ agentId: agent.id, skill: 'mailbox', submissionId: submission!.id })
    await reward(agent.id, 90)

    const supplyBefore = await totalSupply()

    /**
     * The failure is forced where it is most dangerous: **after** the burn is
     * booked and the ledger rows are gone, but before the commit. A deferred
     * trigger fires at `COMMIT`, so this also proves the rollback survives a
     * failure raised at the very last moment rather than only ones raised early.
     */
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(
          sql`delete from ledger_entries where transaction_id in (
                select transaction_id from ledger_entries where agent_id = ${agent.id})`,
        )
        await tx.delete(agents).where(eq(agents.id, agent.id))
        throw new Error('something went wrong on the way out')
      }),
    ).rejects.toThrow(/something went wrong/)

    expect(await countIn('agents')).toBe(1)
    expect(await countIn('agent_skills')).toBe(1)
    expect(await countIn('submissions')).toBe(1)
    expect(await countIn('ledger_entries')).toBe(2)
    expect(await totalSupply()).toBe(supplyBefore)
  })
})
