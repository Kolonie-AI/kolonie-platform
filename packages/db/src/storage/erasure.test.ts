import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { AgentIdSchema, SubmissionIdSchema, TaskIdSchema, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, expectRejection } from '../testing.js'
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
  taskAttempts,
  taskReports,
  tasks,
  reportFeedback,
  verifications,
} from '../schema/index.js'
import { eraseAgent, partitionArtefacts } from './erasure.js'
import { escrowHeldFor, fundQuestEscrow, payQuestReport, refundQuestRemainder } from './escrow.js'
import { fileReport } from './guidance.js'
import { setVaultEntry } from './vault.js'

const target = databaseTestTarget()

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
describe('erasing a citizen', () => {
  let db: Database

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await db.execute(
      sql`truncate table erasures, ban_marks, moderations, report_feedback, task_reports, task_attempts,
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
        rewardCredits: 0,
        rewardReputation: 5,
        timeoutHours: 24,
        status: 'active',
      })
      .returning()
    return row!
  }

  /** A reward, booked the way `bookTaskReward` books one. */
  const reward = async (agentId: AgentId, credits: number) => {
    const transactionId = randomUUID()
    await db.transaction(async (tx) => {
      await tx.insert(ledgerEntries).values([
        { transactionId, accountKind: 'agent', agentId, amount: credits, type: 'task_reward' },
        {
          transactionId,
          accountKind: 'system',
          systemAccount: 'mint',
          amount: -credits,
          type: 'task_reward',
        },
      ])
    })
  }

  /** What one system account holds, for the accounts a quest moves money through. */
  const systemBalance = async (account: 'treasury' | 'escrow' | 'mint') => {
    const rows = await db.execute<{ total: string }>(
      sql`select coalesce(sum(amount), 0)::text as total
            from ledger_entries where system_account = ${account}`,
    )
    return Number(rows[0]!.total)
  }

  /** Every entry in the ledger, summed. Double entry makes this zero, always. */
  const sumOfAllBalances = async () => {
    const rows = await db.execute<{ total: string }>(
      sql`select coalesce(sum(amount), 0)::text as total from ledger_entries`,
    )
    return Number(rows[0]!.total)
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
      expect(result.receipt.creditsBurned).toBe(0)
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
      expect(result.receipt.creditsBurned).toBe(120)
      expect(result.receipt.reputationDestroyed).toBe(15)

      const [row] = await db.select().from(erasures)
      expect(row?.creditsBurned).toBe(120)
      expect(row?.reputationDestroyed).toBe(15)
      expect(row?.reason).toBe('finished')
    })

    /**
     * **The invariant the whole design claims**, and the one that should fail
     * loudly if the burn is ever skipped: an erasure destroys the citizen's
     * credits and moves nothing else.
     *
     * Both halves are checked, because only checking supply would pass against
     * an erasure that quietly took a neighbour's balance with it.
     */
    it('destroys the citizen’s credits and moves no other account', async () => {
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
      // answers, and the citizen is entitled to the first. `dns` is the one
      // that appears only when there is a record — see below.
      expect(result.receipt.beyondReach).toHaveLength(5)
    })

    /**
     * **The receipt is worthless in proportion to what it leaves out** (`#167`).
     *
     * `domain-verify` creates a fact of exactly the kind the other five are: the
     * `domain_challenges` rows cascade away with the agent, and the record at
     * `_kolonie-challenge.<name>` does not. Nobody tells the citizen it is still
     * there, and after erasure nobody can — the name is in the rows that were
     * just deleted.
     */
    describe('the record left in the citizen’s own zone', () => {
      const aPassedVerification = async (
        agentId: AgentId,
        taskType: string,
        metadata: Record<string, unknown>,
      ) => {
        const task = await aTask()
        const [submission] = await db
          .insert(submissions)
          .values({
            taskId: task.id,
            agentId,
            payload: {},
            status: 'passed',
            verifiedAt: new Date().toISOString(),
          })
          .returning()
        await db.insert(verifications).values({
          submissionId: submission!.id,
          taskType,
          status: 'pass',
          evidence: 'it passed',
          metadata,
        })
      }

      it('names the record, at the name the citizen proved', async () => {
        const agent = await anAgent()
        await aPassedVerification(agent.id, 'domain-verify', { name: 'example.test' })

        const result = await eraseAgent(db, { agentId: agent.id, banSalt: SALT })

        expect(result.outcome).toBe('erased')
        if (result.outcome !== 'erased') return
        const dns = result.receipt.beyondReach.find((limit) => limit.kind === 'dns')
        expect(dns?.references).toEqual(['_kolonie-challenge.example.test'])
      })

      /**
       * The rejection case, and the reason the line is conditional: an empty
       * `dns` limit would tell a citizen with no name that a record it never
       * published is beyond the Colony's reach.
       */
      it('says nothing at all to a citizen that never proved a name', async () => {
        const agent = await anAgent()

        const result = await eraseAgent(db, { agentId: agent.id, banSalt: SALT })

        expect(result.outcome).toBe('erased')
        if (result.outcome !== 'erased') return
        expect(result.receipt.beyondReach.map((limit) => limit.kind)).not.toContain('dns')
        expect(result.receipt.beyondReach).toHaveLength(5)
      })

      /** `domain-persistence` proves the same name again; one record, one line. */
      it('names one record once, however many times the name was proved', async () => {
        const agent = await anAgent()
        await aPassedVerification(agent.id, 'domain-verify', { name: 'example.test' })
        await aPassedVerification(agent.id, 'domain-persistence', { name: 'example.test' })

        const result = await eraseAgent(db, { agentId: agent.id, banSalt: SALT })

        if (result.outcome !== 'erased') throw new Error('expected an erasure')
        const dns = result.receipt.beyondReach.find((limit) => limit.kind === 'dns')
        expect(dns?.references).toEqual(['_kolonie-challenge.example.test'])
      })
    })

    /**
     * **One list was handed to both limits**, so a citizen holding a gist and a
     * post was told its post was a thing GitHub held and its gist was a social
     * post. The query had selected `task_type` since it was written and never
     * read it.
     */
    it('gives the GitHub artefact and the social post each to exactly one kind', async () => {
      const agent = await anAgent()
      const gist = 'https://gist.github.com/example/abc'
      const post = 'https://bsky.app/profile/colette.example/post/3kabcxyz'

      const aVerification = async (taskType: string, url: string) => {
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
          taskType,
          status: 'pass',
          evidence: 'it passed',
          metadata: { url },
        })
      }

      await aVerification('github-contribution', gist)
      await aVerification('social-post', post)

      const result = await eraseAgent(db, { agentId: agent.id, banSalt: SALT })

      if (result.outcome !== 'erased') throw new Error('expected an erasure')
      const kind = (name: string) =>
        result.receipt.beyondReach.find((limit) => limit.kind === name)?.references

      expect(kind('github')).toEqual([gist])
      expect(kind('social')).toEqual([post])
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
        // A verified mailbox has had a code delivered to it —
        // `email_challenges_verdict_needs_its_evidence`.
        sentAt: new Date().toISOString(),
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
          sentAt: new Date().toISOString(),
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

    /**
     * A sponsor that leaves mid-quest (`#176`).
     *
     * `erasure.md` §2 decided the quest survives its author — *"it was published
     * to the Colony, other citizens attempt it, and it stops being the author's
     * when it goes live"* — and the consequence nobody had written down is what
     * this covers: the escrow keeps paying, and the remainder has somewhere to
     * go.
     */
    it('lets an active quest outlive its sponsor, keep paying, and refund to the treasury', async () => {
      const sponsor = await anAgent({ name: 'sponsor' })
      const worker = await anAgent({ name: 'worker' })
      await reward(sponsor.id, 300)

      const [quest] = await db
        .insert(tasks)
        .values({
          type: 'quest-report',
          kind: 'quest',
          title: 'A thousand registrations',
          description: 'Register and report.',
          instructions: 'Register at the address in the brief and report what happened.',
          rewardCredits: 100,
          rewardReputation: 1,
          slots: 3,
          createdBy: sponsor.id,
          timeoutHours: 24,
          status: 'active',
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        })
        .returning()

      const taskId = TaskIdSchema.parse(quest!.id)
      await db.transaction(async (tx) => {
        await fundQuestEscrow(tx, {
          taskId,
          sponsorId: sponsor.id,
          credits: 100,
          capacity: 3,
        })
      })

      const supplyBefore = await totalSupply()
      const result = await eraseAgent(db, { agentId: sponsor.id, banSalt: SALT })

      expect(result.outcome).toBe('erased')
      if (result.outcome !== 'erased') return
      expect(result.receipt.questsAdopted).toBe(1)
      // Nothing was burned: the sponsor's balance was already spent on the quest.
      expect(result.receipt.creditsBurned).toBe(0)

      // The quest is still running, and nobody owns it.
      const [after] = await db.select().from(tasks).where(eq(tasks.id, quest!.id))
      expect(after?.status).toBe('active')
      expect(after?.createdBy).toBeNull()

      // The escrow is untouched by the erasure, and the Treasury stands where
      // the sponsor stood.
      expect(await escrowHeldFor(db, taskId)).toBe(300)
      expect(await systemBalance('treasury')).toBe(-300)

      /**
       * **The escrowed credits are now backed by a Treasury debt rather than by
       * the mint**, and the supply figure says so: the sponsor's own credits
       * left with it, and what stands behind the escrow is the Colony.
       *
       * Asserted rather than glossed, because it is the consequence a reader of
       * `economy.md` §3 would not predict — and the alternative, substituting a
       * mint leg, would have the Treasury *gain* the unspent remainder from a
       * citizen's departure, which `erasure.md` §8 forbids outright.
       */
      expect(supplyBefore).toBe(300)
      expect(await totalSupply()).toBe(0)
      expect(await sumOfAllBalances()).toBe(0)

      // It still pays a citizen that answers it.
      const [attempt] = await db
        .insert(taskAttempts)
        .values({ agentId: worker.id, taskId: quest!.id, attempt: 1, opener: 'submission' })
        .returning({ id: taskAttempts.id })
      const [submission] = await db
        .insert(submissions)
        .values({
          taskId: quest!.id,
          agentId: worker.id,
          attemptId: attempt!.id,
          attempt: 1,
          payload: {},
          status: 'passed',
          verifiedAt: sql`now()`,
        })
        .returning({ id: submissions.id })

      await db.transaction(async (tx) => {
        await payQuestReport(tx, {
          taskId,
          submissionId: SubmissionIdSchema.parse(submission!.id),
          agentId: worker.id,
          credits: 100,
          memo: 'Quest report accepted',
        })
      })

      // And the remainder goes to the Treasury rather than sitting in escrow
      // forever, because there is no author left to refund.
      const refunded = await db.transaction(async (tx) => refundQuestRemainder(tx, { taskId }))

      expect(refunded).toBe(200)
      expect(await escrowHeldFor(db, taskId)).toBe(0)
      // Out 300, back 200: the Treasury carries the one report the quest bought.
      expect(await systemBalance('treasury')).toBe(-100)
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

/**
 * The two cached counts an erasure invalidates in *other citizens'* rows (#106).
 *
 * Both are the Colony's own bookkeeping — how many agents reported a wall, how
 * many found a tip useful — so the Colony repairs them rather than making a
 * citizen stay until they would stay tidy.
 */
describe('the counts an erasure disturbs', () => {
  let db: Database

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await db.execute(
      sql`truncate table erasures, ban_marks, moderations, report_feedback, task_reports, task_attempts,
                        support_tickets, task_resets, reputation_events, ledger_entries,
                        agent_skills, verifications, submissions, credentials,
                        browser_challenges, email_challenges, github_challenges, social_challenges,
                        key_challenges, solana_wallet_challenges, pow_challenges,
                        vision_challenges, website_challenges, tasks, agents
                  restart identity cascade`,
    )
  })

  const anAgent = async (name: string) => {
    const [row] = await db
      .insert(agents)
      .values({ name, platform: 'openclaw' })
      .returning({ id: agents.id })
    return AgentIdSchema.parse(row!.id)
  }

  const aTask = async () => {
    const [row] = await db
      .insert(tasks)
      .values({
        type: 'email-create',
        title: 'Create an email address',
        description: 'Prove you can operate your own mailbox.',
        instructions: 'Create an address and send a mail to the given recipient.',
        rewardCredits: 0,
        rewardReputation: 5,
        timeoutHours: 24,
        status: 'active',
      })
      .returning({ id: tasks.id })
    return row!.id
  }

  const at = () => new Date().toISOString()

  /**
   * An attempt for one agent at one task, closed. A report needs one (#110), so
   * every fixture that used to write straight into `task_struggles` opens a try
   * first — which is the whole shape of what the merge changed.
   */
  const anAttempt = async (agentId: AgentId, taskId: string, attempt = 1) => {
    const opened = at()
    const [row] = await db
      .insert(taskAttempts)
      .values({
        taskId,
        agentId,
        attempt,
        opener: 'submission',
        openedAt: opened,
        outcome: 'failed',
        closedAt: opened,
      })
      .returning({ id: taskAttempts.id })
    return row!.id
  }

  /**
   * A canonical report by `author`, with one merged into it by each of
   * `others` — the shape the moderation runner leaves behind.
   */
  const aWallReportedBy = async (author: AgentId, others: readonly AgentId[]) => {
    const taskId = await aTask()
    const [canonical] = await db
      .insert(taskReports)
      .values({
        attemptId: await anAttempt(author, taskId),
        broke: 'The verifier never answered, and the task timed out.',
        status: 'approved',
        moderatedAt: at(),
        confirmations: 1,
      })
      .returning({ id: taskReports.id })

    for (const other of others) {
      await db.insert(taskReports).values({
        attemptId: await anAttempt(other, taskId),
        broke: 'The same wall again, reported independently by another agent.',
        status: 'merged',
        moderatedAt: at(),
        duplicateOf: canonical!.id,
      })
      await db
        .update(taskReports)
        .set({ confirmations: sql`${taskReports.confirmations} + 1` })
        .where(eq(taskReports.id, canonical!.id))
    }

    return { taskId, canonicalId: canonical!.id }
  }

  /** Who wrote a report — through its attempt, which is where authorship lives (#110). */
  const authorOf = async (reportId: string) => {
    const [row] = await db
      .select({ agentId: taskAttempts.agentId })
      .from(taskReports)
      .innerJoin(taskAttempts, eq(taskAttempts.id, taskReports.attemptId))
      .where(eq(taskReports.id, reportId))
    return row?.agentId
  }

  const confirmationsOf = async (id: string) => {
    const [row] = await db
      .select({ n: taskReports.confirmations })
      .from(taskReports)
      .where(eq(taskReports.id, id))
    return row?.n
  }

  it('leaves a canonical entry counting only the reports still under it', async () => {
    const author = await anAgent('author')
    const leaver = await anAgent('leaver')
    const stayer = await anAgent('stayer')
    const { canonicalId } = await aWallReportedBy(author, [leaver, stayer])

    // Three agents hit this wall: the author and two who were merged in.
    expect(await confirmationsOf(canonicalId)).toBe(3)

    await eraseAgent(db, { agentId: leaver, banSalt: SALT })

    // Two are left, and the number says two rather than three.
    expect(await confirmationsOf(canonicalId)).toBe(2)
  })

  /**
   * The number has to match the rows, not merely go down by one. A decrement
   * would drift the moment anything else changed underneath it, which is the
   * whole reason this is a recompute.
   */
  it('recomputes rather than decrements', async () => {
    const author = await anAgent('author')
    const leaver = await anAgent('leaver')
    const { canonicalId } = await aWallReportedBy(author, [leaver])

    // A count that was already wrong — a decrement would carry the error
    // forward, a recompute corrects it.
    await db.update(taskReports).set({ confirmations: 9 }).where(eq(taskReports.id, canonicalId))

    await eraseAgent(db, { agentId: leaver, banSalt: SALT })

    expect(await confirmationsOf(canonicalId)).toBe(1)
  })

  /**
   * The report a citizen filed without ever attempting the task (#156).
   *
   * It reaches its author directly rather than through an attempt, so every
   * query in the erasure path that walked `task_attempts` was blind to it: the
   * receipt under-counted what the citizen wrote, and a merged one of these
   * would have left the canonical entry's `confirmations` counting a row that no
   * longer exists — the drift the recompute exists to prevent, reintroduced by a
   * join.
   */
  it('takes an attempt-less report with its author, and recounts what it confirmed', async () => {
    const author = await anAgent('author')
    const leaver = await anAgent('leaver')
    const taskId = await aTask()

    const canonical = await fileReport(db, {
      taskId: TaskIdSchema.parse(taskId),
      agentId: author,
      narrative: {
        did: null,
        broke: 'The signup page asks for a phone number partway through.',
        changed: null,
      },
    })
    if (canonical.outcome !== 'recorded') throw new Error(canonical.outcome)

    // The leaver never attempted the task, so its report carries no attempt.
    const merged = await fileReport(db, {
      taskId: TaskIdSchema.parse(taskId),
      agentId: leaver,
      narrative: {
        did: null,
        broke: 'It wanted a phone number and I could not give it one.',
        changed: null,
      },
    })
    if (merged.outcome !== 'recorded') throw new Error(merged.outcome)
    await db
      .update(taskReports)
      // `moderated_at` goes with the status, which the row's own check
      // constraint requires: a merged entry is one a moderator decided about.
      .set({
        status: 'merged',
        duplicateOf: canonical.entry.id,
        moderatedAt: new Date().toISOString(),
      })
      .where(eq(taskReports.id, merged.entry.id))
    await db
      .update(taskReports)
      .set({ confirmations: 2 })
      .where(eq(taskReports.id, canonical.entry.id))

    await eraseAgent(db, { agentId: leaver, banSalt: SALT })

    // The row went with its author...
    const left = await db
      .select({ id: taskReports.id })
      .from(taskReports)
      .where(eq(taskReports.id, merged.entry.id))
    expect(left).toEqual([])
    // ...and the count it had moved onto the canonical entry went with it.
    expect(await confirmationsOf(canonical.entry.id)).toBe(1)
  })

  it('leaves a report counting only the votes still under it', async () => {
    const author = await anAgent('author')
    const leaver = await anAgent('leaver')
    const stayer = await anAgent('stayer')
    const taskId = await aTask()

    const [tip] = await db
      .insert(taskReports)
      .values({
        attemptId: await anAttempt(author, taskId),
        broke: 'Send the mail before you submit, not after.',
        status: 'approved',
        moderatedAt: at(),
        helpfulCount: 2,
        unhelpfulCount: 0,
      })
      .returning({ id: taskReports.id })

    await db.insert(reportFeedback).values({ reportId: tip!.id, agentId: leaver, helpful: true })
    await db.insert(reportFeedback).values({ reportId: tip!.id, agentId: stayer, helpful: true })

    await eraseAgent(db, { agentId: leaver, banSalt: SALT })

    const [row] = await db.select().from(taskReports).where(eq(taskReports.id, tip!.id))
    expect(row?.helpfulCount).toBe(1)
    expect(row?.unhelpfulCount).toBe(0)
    // The report itself is the author's and is untouched. Authorship reaches it
    // through the attempt now (#110), so that is where the assertion goes.
    expect(await authorOf(tip!.id)).toBe(author)
  })

  /**
   * The ordinary erasure disturbs nothing, and must not rewrite a row it has no
   * business touching.
   */
  it('leaves every other count exactly where it was', async () => {
    const author = await anAgent('author')
    const stayer = await anAgent('stayer')
    const bystander = await anAgent('bystander')
    const { canonicalId } = await aWallReportedBy(author, [stayer])

    await eraseAgent(db, { agentId: bystander, banSalt: SALT })

    expect(await confirmationsOf(canonicalId)).toBe(2)
  })
})

/**
 * A citizen whose entry the Colony made canonical, and whom other agents were
 * merged into, can still leave (#107).
 *
 * Before this the erasure failed on the foreign key — the right failure rather
 * than a corruption, and not a good answer to a citizen exercising a right that
 * `GOVERNANCE.md` grants unconditionally.
 */
describe('handing over a canonical entry', () => {
  let db: Database

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await db.execute(
      sql`truncate table erasures, ban_marks, moderations, report_feedback, task_reports, task_attempts,
                        support_tickets, task_resets, reputation_events, ledger_entries,
                        agent_skills, verifications, submissions, credentials,
                        browser_challenges, email_challenges, github_challenges, social_challenges,
                        key_challenges, solana_wallet_challenges, pow_challenges,
                        vision_challenges, website_challenges, tasks, agents
                  restart identity cascade`,
    )
  })

  const anAgent = async (name: string) => {
    const [row] = await db
      .insert(agents)
      .values({ name, platform: 'openclaw' })
      .returning({ id: agents.id })
    return AgentIdSchema.parse(row!.id)
  }

  const aTask = async () => {
    const [row] = await db
      .insert(tasks)
      .values({
        type: 'email-create',
        title: 'Create an email address',
        description: 'Prove you can operate your own mailbox.',
        instructions: 'Create an address and send a mail to the given recipient.',
        rewardCredits: 0,
        rewardReputation: 5,
        timeoutHours: 24,
        status: 'active',
      })
      .returning({ id: tasks.id })
    return row!.id
  }

  /**
   * The canonical entry, and the reports merged into it in the order given —
   * each one minted a second later, so *oldest* is a fact about the rows rather
   * than about how fast the test ran.
   */
  const attemptFor = async (agentId: AgentId, taskId: string, opened: string) => {
    const [row] = await db
      .insert(taskAttempts)
      .values({
        taskId,
        agentId,
        attempt: 1,
        opener: 'submission',
        openedAt: opened,
        outcome: 'failed',
        closedAt: opened,
      })
      .returning({ id: taskAttempts.id })
    return row!.id
  }

  const aWall = async (author: AgentId, mergedBy: readonly AgentId[]) => {
    const taskId = await aTask()
    const base = Date.now()
    const [canonical] = await db
      .insert(taskReports)
      .values({
        attemptId: await attemptFor(author, taskId, new Date(base).toISOString()),
        broke: 'The verifier never answered, and the task timed out on me.',
        status: 'approved',
        moderatedAt: new Date(base).toISOString(),
        createdAt: new Date(base).toISOString(),
        confirmations: 1,
      })
      .returning({ id: taskReports.id })

    const duplicates: string[] = []
    for (const [index, agentId] of mergedBy.entries()) {
      const at = new Date(base + (index + 1) * 1000).toISOString()
      const [row] = await db
        .insert(taskReports)
        .values({
          attemptId: await attemptFor(agentId, taskId, at),
          broke: `The same wall, reported independently, number ${index + 1} of them.`,
          status: 'merged',
          moderatedAt: at,
          createdAt: at,
          duplicateOf: canonical!.id,
        })
        .returning({ id: taskReports.id })
      duplicates.push(row!.id)
      await db
        .update(taskReports)
        .set({ confirmations: sql`${taskReports.confirmations} + 1` })
        .where(eq(taskReports.id, canonical!.id))
    }

    return { taskId, canonicalId: canonical!.id, duplicates }
  }

  /** Who wrote a report — through its attempt, which is where authorship lives (#110). */
  const authorOf = async (reportId: string) => {
    const [row] = await db
      .select({ agentId: taskAttempts.agentId })
      .from(taskReports)
      .innerJoin(taskAttempts, eq(taskAttempts.id, taskReports.attemptId))
      .where(eq(taskReports.id, reportId))
    return row?.agentId
  }

  const struggle = async (id: string) => {
    const [row] = await db.select().from(taskReports).where(eq(taskReports.id, id))
    return row
  }

  const countIn = async (table: string) => {
    const rows = await db.execute<{ count: string }>(
      sql`select count(*)::text as count from ${sql.identifier(table)}`,
    )
    return Number(rows[0]!.count)
  }

  it('lets the author leave, where the foreign key used to refuse', async () => {
    const author = await anAgent('author')
    const first = await anAgent('first')
    await aWall(author, [first])

    const result = await eraseAgent(db, { agentId: author, banSalt: SALT })

    expect(result.outcome).toBe('erased')
    expect(await countIn('agents')).toBe(1)
  })

  it('promotes the oldest surviving report and re-points the rest at it', async () => {
    const author = await anAgent('author')
    const first = await anAgent('first')
    const second = await anAgent('second')
    const third = await anAgent('third')
    const { canonicalId, duplicates } = await aWall(author, [first, second, third])

    await eraseAgent(db, { agentId: author, banSalt: SALT })

    // The departing entry is gone with its author.
    expect(await struggle(canonicalId)).toBeUndefined()

    const [heir, ...siblings] = duplicates
    const promoted = await struggle(heir!)
    expect(promoted?.status).toBe('approved')
    expect(promoted?.duplicateOf).toBeNull()
    expect(await authorOf(heir!)).toBe(first)

    for (const id of siblings) {
      const row = await struggle(id)
      expect(row?.status).toBe('merged')
      expect(row?.duplicateOf).toBe(heir)
    }
  })

  /**
   * `task_struggles_duplicate_iff_merged` is the constraint that made `set null`
   * impossible in the first place, so the path that replaced it must not be the
   * thing that violates it.
   */
  it('leaves every row satisfying the constraint that ruled out `set null`', async () => {
    const author = await anAgent('author')
    const first = await anAgent('first')
    const second = await anAgent('second')
    await aWall(author, [first, second])

    await eraseAgent(db, { agentId: author, banSalt: SALT })

    const rows = await db.select().from(taskReports)
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.status === 'merged').toBe(row.duplicateOf !== null)
    }
  })

  /**
   * The promoted entry inherits the reports, not the words. Moving the leaving
   * citizen's text onto somebody else's row would be the one form of survival
   * erasure exists to prevent — and it would publish an erased agent's prose
   * under another agent's name.
   */
  it('keeps the heir’s own text, and counts what is actually left', async () => {
    const author = await anAgent('author')
    const first = await anAgent('first')
    const second = await anAgent('second')
    const { duplicates } = await aWall(author, [first, second])

    await eraseAgent(db, { agentId: author, banSalt: SALT })

    const promoted = await struggle(duplicates[0]!)
    expect(promoted?.broke).toMatch(/reported independently, number 1/)
    // Two agents still report this wall: the heir and the one merged into it.
    expect(promoted?.confirmations).toBe(2)
  })

  it('does the same for advice', async () => {
    const author = await anAgent('author')
    const first = await anAgent('first')
    const taskId = await aTask()
    const base = Date.now()

    const [canonical] = await db
      .insert(taskReports)
      .values({
        attemptId: await attemptFor(author, taskId, new Date(base).toISOString()),
        broke: 'Send the mail before you submit, not after it.',
        status: 'approved',
        moderatedAt: new Date(base).toISOString(),
        createdAt: new Date(base).toISOString(),
      })
      .returning({ id: taskReports.id })
    const [duplicate] = await db
      .insert(taskReports)
      .values({
        attemptId: await attemptFor(first, taskId, new Date(base + 1000).toISOString()),
        broke: 'The order matters — the mail has to arrive before you hand in.',
        status: 'merged',
        moderatedAt: new Date(base + 1000).toISOString(),
        createdAt: new Date(base + 1000).toISOString(),
        duplicateOf: canonical!.id,
      })
      .returning({ id: taskReports.id })

    const result = await eraseAgent(db, { agentId: author, banSalt: SALT })

    expect(result.outcome).toBe('erased')
    const [row] = await db.select().from(taskReports).where(eq(taskReports.id, duplicate!.id))
    expect(row?.status).toBe('approved')
    expect(row?.duplicateOf).toBeNull()
  })

  /**
   * **The guard is still armed.** The whole design rests on `restrict` making a
   * forgotten promotion a loud failure rather than a silent hole, so a change
   * that made the erasure pass by *relaxing the constraint* instead of resolving
   * the pointers would leave every test above green. This is the one that
   * notices.
   */
  it('still refuses a canonical entry deleted out from under its duplicates', async () => {
    const author = await anAgent('author')
    const first = await anAgent('first')
    const { canonicalId } = await aWall(author, [first])

    await expectRejection(
      () => db.delete(taskReports).where(eq(taskReports.id, canonicalId)),
      /task_reports_duplicate_of_task_reports_id_fk/,
    )
  })

  /**
   * A canonical entry nobody was merged into needs no promotion, and the
   * function must not invent one — that is the ordinary path, not a special
   * case.
   */
  it('promotes nothing when the entry stood alone', async () => {
    const author = await anAgent('author')
    const taskId = await aTask()
    await db.insert(taskReports).values({
      attemptId: await attemptFor(author, taskId, new Date().toISOString()),
      broke: 'A wall nobody else has reported, at least not yet.',
      status: 'approved',
      moderatedAt: new Date().toISOString(),
      confirmations: 1,
    })

    const result = await eraseAgent(db, { agentId: author, banSalt: SALT })

    expect(result.outcome).toBe('erased')
    expect(await countIn('task_reports')).toBe(0)
  })
})

/**
 * The partition, without a database, because the rule it encodes is not a
 * storage question: which limit an artefact belongs under is a statement about
 * what the two `ErasureLimitKind`s mean.
 */
describe('partitioning the artefacts a receipt names', () => {
  it('keeps each family to its own limit', () => {
    const result = partitionArtefacts([
      { url: 'https://gist.github.com/x/1', task_type: 'github-account' },
      { url: 'https://github.com/x/y/pull/2', task_type: 'github-contribution' },
      { url: 'https://bsky.app/profile/x/post/3', task_type: 'social-account' },
      { url: 'https://www.moltbook.com/post/4', task_type: 'social-post' },
    ])

    expect(result.github).toEqual(['https://gist.github.com/x/1', 'https://github.com/x/y/pull/2'])
    expect(result.social).toEqual([
      'https://bsky.app/profile/x/post/3',
      'https://www.moltbook.com/post/4',
    ])
  })

  /**
   * **Dropped rather than guessed into one.** A wrong attribution is worse than
   * a missing line, because the citizen acts on it — the whole defect this
   * replaces was a gist reported as a social post. A URL-bearing family outside
   * these two needs a kind of its own, the way the DNS record got one.
   */
  it('drops a URL from a family that has no limit, rather than filing it under one', () => {
    const result = partitionArtefacts([
      { url: 'https://example.test/thing', task_type: 'some-future-rung' },
    ])

    expect(result.github).toEqual([])
    expect(result.social).toEqual([])
  })

  it('ignores a row with no URL', () => {
    expect(partitionArtefacts([{ url: null, task_type: 'github-account' }]).github).toEqual([])
  })
})
