import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql, or } from 'drizzle-orm'
import {
  now,
  RegisterAgentRequestSchema,
  questFundingReference,
  questPayoutReference,
  submissionReference,
  SubmissionIdSchema,
  TaskIdSchema,
  TaskTypeSchema,
  UNDECLARED_REWARD_PERCENT,
  type AgentId,
  type Assistance,
  type SubmissionId,
  type TaskId,
} from '@kolonie-ai/core'
import { createDatabase, type Database } from '../client.js'
import {
  agentSkills,
  agents,
  ledgerEntries,
  reputationEvents,
  submissions,
  tasks,
  verifications,
} from '../schema/index.js'
import { connectForTests, databaseTestTarget, expectRejection, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import { balanceOfAgent } from './balance.js'
import { listAccounts } from './accounts.js'
import { bookTaskReward } from './rewards.js'
import { claimNextSubmission, recordVerdict } from './verifications.js'

const target = databaseTestTarget()

const EXAMPLE_TASK = TaskTypeSchema.parse('example-task')

describe('booking a passed submission', () => {
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

  let seeded = 0

  const anAgent = async (): Promise<AgentId> => {
    const result = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name: `canary-${++seeded}`, platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    return result.agent.id
  }

  const aTask = async (
    options: {
      credits?: number
      reputation?: number
      grants?: string[]
      grantsRoles?: string[]
      /** The task's own type, which is what the badge capability map is keyed on (#150). */
      type?: string
    } = {},
  ): Promise<TaskId> => {
    const [row] = await db
      .insert(tasks)
      .values({
        type: options.type ?? 'example-task',
        grantsSkills: options.grants ?? [],
        grantsRoles: options.grantsRoles ?? [],
        title: 'Make an API call',
        description: 'What this task is, for a human reading the catalogue.',
        instructions: 'What the agent must actually do.',
        /**
         * **A task that pays credits is a Quest, and after #43 that is enforced.**
         * `tasks_academy_pays_no_credits` refuses an `academy` row with a credit
         * amount, so the fixture derives the kind from what the test asked for
         * rather than making every caller say it.
         *
         * **Since `#174` the two kinds pay from different places**, and that is
         * what these assertions now say. An Academy pass is a credit the Colony
         * creates against the `mint`; a quest report is a credit its sponsor
         * already put into `escrow` at publication, and nothing is minted. So a
         * paying fixture funds the escrow first, exactly as a published quest
         * would have — otherwise the payout would overdraw it, which
         * `payQuestReport` refuses.
         *
         * Everything else these tests pin down is unchanged and still the point:
         * `bookTaskReward` is the one booking path for both kinds, the pair sums
         * to zero, and a reward books exactly once.
         */
        kind: (options.credits ?? 10) > 0 ? ('quest' as const) : ('academy' as const),
        rewardCredits: options.credits ?? 10,
        rewardReputation: options.reputation ?? 5,
        timeoutHours: 24,
        status: 'active',
      })
      .returning({ id: tasks.id })

    if (row === undefined) throw new Error('insert into tasks returned no row')
    const taskId = TaskIdSchema.parse(row.id)

    /**
     * Fund the escrow, the way publication does (`#174`), so a paying quest can
     * actually pay. Treasury → escrow rather than sponsor → escrow because these
     * tests are about the verdict's booking and not about where the sponsor's
     * money came from; what matters is that the escrow holds enough and that the
     * ledger still sums to zero.
     */
    if ((options.credits ?? 10) > 0) {
      const transactionId = randomUUID()
      await db.insert(ledgerEntries).values([
        {
          transactionId,
          accountKind: 'system' as const,
          systemAccount: 'treasury' as const,
          amount: -1000,
          type: 'task_funding' as const,
          reference: questFundingReference(taskId),
        },
        {
          transactionId,
          accountKind: 'system' as const,
          systemAccount: 'escrow' as const,
          amount: 1000,
          type: 'task_funding' as const,
          reference: questFundingReference(taskId),
        },
      ])
    }

    return taskId
  }

  /**
   * A submission sitting in `verifying`, as the runner leaves it after claiming.
   *
   * **Declares `none` unless a test says otherwise**, so the amounts booked here
   * are the task's stated reward and every assertion below is about the books
   * rather than about the rate. What the declaration is worth has its own block
   * at the end of this file — a fixture that quietly halved every number would
   * have made those two questions impossible to tell apart.
   */
  const aClaimedSubmission = async (
    options: {
      taskId?: TaskId
      agentId?: AgentId
      assistance?: Assistance
      /** Which try this is. A second submission for one pair needs its own (#145). */
      attempt?: number
      /** The task type the runner claims under, where it is not the example one. */
      claimAs?: string
    } = {},
  ): Promise<SubmissionId> => {
    const taskId = options.taskId ?? (await aTask())
    const agentId = options.agentId ?? (await anAgent())

    const [row] = await db
      .insert(submissions)
      .values({
        taskId,
        agentId,
        payload: { echo: 'hello' },
        status: 'pending',
        assistance: options.assistance ?? 'none',
        ...(options.attempt === undefined ? {} : { attempt: options.attempt }),
      })
      .returning({ id: submissions.id })

    if (row === undefined) throw new Error('insert into submissions returned no row')

    const claimed = await claimNextSubmission(db, [
      TaskTypeSchema.parse(options.claimAs ?? EXAMPLE_TASK),
    ])
    if (claimed?.submission.id !== row.id) {
      throw new Error('the fixture claimed a submission other than the one it just created')
    }
    return SubmissionIdSchema.parse(row.id)
  }

  const pass = (submissionId: SubmissionId) =>
    recordVerdict(db, {
      submissionId,
      taskType: EXAMPLE_TASK,
      result: { status: 'pass', evidence: 'The payload was well formed.' },
    })

  const fail = (submissionId: SubmissionId) =>
    recordVerdict(db, {
      submissionId,
      taskType: EXAMPLE_TASK,
      result: { status: 'fail', evidence: 'The payload had no echo.' },
    })

  /**
   * The entries one verdict wrote, whichever kind of task it was.
   *
   * An Academy reward is referenced by the submission; a quest payout carries
   * the quest as well, so that everything one quest's money did is a prefix scan
   * (`#174`). Matching both is what lets these tests assert the same properties
   * across the two.
   */
  const entriesFor = (submissionId: SubmissionId) =>
    db
      .select()
      .from(ledgerEntries)
      .where(
        or(
          eq(ledgerEntries.reference, submissionReference(submissionId)),
          sql`${ledgerEntries.reference} like ${'quest:%:payout:' + submissionId}`,
        ),
      )

  /** What the whole ledger sums to. Must be zero, always, whatever happened. */
  const ledgerTotal = async (): Promise<number> => {
    const [row] = await db
      .select({ total: sql<string>`coalesce(sum(${ledgerEntries.amount}), 0)::text` })
      .from(ledgerEntries)
    return Number(row?.total ?? '0')
  }

  describe('a pass', () => {
    it('credits the agent and debits the escrow, and the two sum to zero', async () => {
      const agentId = await anAgent()
      const taskId = await aTask({ credits: 10 })
      const submissionId = await aClaimedSubmission({ taskId, agentId })

      const written = await pass(submissionId)

      expect(written.outcome).toBe('recorded')
      if (written.outcome !== 'recorded') return
      expect(written.booking?.credits).toBe(10)

      const entries = await entriesFor(submissionId)
      expect(entries).toHaveLength(2)

      const agentEntry = entries.find((entry) => entry.accountKind === 'agent')
      const systemEntry = entries.find((entry) => entry.accountKind === 'system')

      expect(agentEntry?.amount).toBe(10)
      expect(agentEntry?.agentId).toBe(agentId)
      expect(systemEntry?.amount).toBe(-10)
      // A quest pays out of its sponsor's escrow, and the mint is never touched
      // (D-038, `#174`). An Academy pass is the one that debits the mint.
      expect(systemEntry?.systemAccount).toBe('escrow')

      // One booking, one transaction id — the deferred trigger checks the set.
      expect(agentEntry?.transactionId).toBe(systemEntry?.transactionId)
      expect(await ledgerTotal()).toBe(0)
    })

    it('writes reputation alongside the credits', async () => {
      const agentId = await anAgent()
      const taskId = await aTask({ reputation: 5 })
      const submissionId = await aClaimedSubmission({ taskId, agentId })

      await pass(submissionId)

      const events = await db
        .select()
        .from(reputationEvents)
        .where(eq(reputationEvents.agentId, agentId))

      expect(events).toHaveLength(1)
      expect(events[0]?.delta).toBe(5)
      expect(events[0]?.reason).toBe('task_passed')
      // The event names the submission that earned it, like every ledger entry.
      expect(events[0]?.submissionId).toBe(submissionId)
    })

    /**
     * The acceptance criterion is "no unexplained money". Every row a booking
     * writes has to name the submission it came from, or the audit trail has a
     * gap exactly where the payout is.
     */
    it('references the submission on every entry it writes', async () => {
      const taskId = await aTask({ credits: 10 })
      const submissionId = await aClaimedSubmission({ taskId })

      await pass(submissionId)

      for (const entry of await entriesFor(submissionId)) {
        // A quest payout carries the quest as well as the submission, so that
        // everything one quest's money did is a prefix scan (`#174`). The
        // property this test is about — every entry of a booking names what it
        // paid for — holds either way.
        expect(entry.reference).toBe(questPayoutReference(taskId, submissionId))
        expect(entry.type).toBe('task_payout')
      }
    })

    /**
     * The memo no longer names a number (`#35`). It still names the task type,
     * which is the part an audit reads: an entry has to say what was paid for,
     * and `Academy Level 3` said where the task sat rather than what it was.
     */
    it('writes a memo naming the task type, the rate it booked at, and no level', async () => {
      const agentId = await anAgent()
      const taskId = await aTask({ credits: 10 })
      const submissionId = await aClaimedSubmission({ taskId, agentId })

      await pass(submissionId)

      for (const entry of await entriesFor(submissionId)) {
        expect(entry.memo).toBe(`Quest — ${EXAMPLE_TASK} (unattended)`)
        expect(entry.memo).not.toMatch(/Level/)
      }
    })

    it('is visible to the balance read the moment it commits', async () => {
      const agentId = await anAgent()
      const taskId = await aTask({ credits: 10, reputation: 5 })
      const submissionId = await aClaimedSubmission({ taskId, agentId })

      // No wait, no second poll: `GET /v1/agents/me` reads this function, and an
      // agent that is told its submission passed must be able to see the credit.
      await pass(submissionId)

      expect(await balanceOfAgent(db, agentId)).toEqual({ agentId, credits: 10, reputation: 5 })
    })

    /**
     * A task may teach without paying. `ledger_entries_amount_non_zero` refuses
     * an entry of 0, so the honest booking is no entry at all — the alternative
     * would be two rows recording that the Colony paid nothing.
     */
    it('books no ledger entry for a task that pays no credits', async () => {
      const agentId = await anAgent()
      const taskId = await aTask({ credits: 0, reputation: 3 })
      const submissionId = await aClaimedSubmission({ taskId, agentId })

      const written = await pass(submissionId)

      expect(await entriesFor(submissionId)).toHaveLength(0)
      if (written.outcome === 'recorded') expect(written.booking?.transactionId).toBeNull()
      // The reputation still happens.
      expect(await balanceOfAgent(db, agentId)).toEqual({ agentId, credits: 0, reputation: 3 })
    })
  })

  /**
   * D-030: a pass grants the task's skills in the same transaction that writes
   * the verdict and books the credits. Same rule the retired level advance
   * followed — derived from the task, never supplied by a caller — and a stronger reason
   * for it, because a skill decides what the agent may attempt next.
   */
  /**
   * A renewal (#145): the citizen passes a rung it had already passed, because
   * the skill it granted fell due. Nothing is revoked, and nothing is paid
   * twice.
   */
  describe('a renewal', () => {
    const passTwice = async (options: { grants?: string[]; reputation?: number } = {}) => {
      const agentId = await anAgent()
      const taskId = await aTask({ credits: 0, reputation: options.reputation ?? 5, ...options })

      const first = await aClaimedSubmission({ taskId, agentId })
      await pass(first)
      const second = await aClaimedSubmission({ taskId, agentId, attempt: 2 })
      const result = await pass(second)

      return { agentId, taskId, first, second, result }
    }

    it('books no reputation the second time', async () => {
      const { agentId, second } = await passTwice()

      const events = await db
        .select()
        .from(reputationEvents)
        .where(eq(reputationEvents.agentId, agentId))

      // Paid once, for the pass that earned it. Paying again for the passage of
      // time is farming with a calendar in front of it.
      expect(events).toHaveLength(1)
      expect(await entriesFor(second)).toEqual([])
    })

    it('books nothing to the ledger the second time', async () => {
      const { second } = await passTwice()

      expect(await entriesFor(second)).toEqual([])
      expect(await ledgerTotal()).toBe(0)
    })

    it('records in the verdict that it was a renewal', async () => {
      const { second, result } = await passTwice()

      expect(result.outcome).toBe('recorded')
      const [record] = await db
        .select({ metadata: verifications.metadata })
        .from(verifications)
        .where(eq(verifications.submissionId, second))
      expect((record?.metadata as { renewal?: boolean } | null)?.renewal).toBe(true)
    })

    it('takes no skill away, and re-grants one that was somehow lost', async () => {
      const { agentId } = await passTwice({ grants: ['rhythm'] })

      const held = await db.select().from(agentSkills).where(eq(agentSkills.agentId, agentId))

      // The whole rule this mechanism must not break: a skill is held or not
      // held, and no code path revokes one.
      expect(held.map((row) => row.skill)).toEqual(['rhythm'])
    })

    it('leaves a first pass paying exactly what it always did', async () => {
      const agentId = await anAgent()
      const taskId = await aTask({ credits: 0, reputation: 5 })
      const only = await aClaimedSubmission({ taskId, agentId })

      await pass(only)

      const events = await db
        .select()
        .from(reputationEvents)
        .where(eq(reputationEvents.agentId, agentId))
      expect(events).toHaveLength(1)
      expect(events[0]?.delta).toBe(5)
    })
  })

  /**
   * The account register, written in the verdict's own transaction (`#150`).
   *
   * A skill is earned *by proving an account*, and until this the evidence for
   * that sentence lived in six challenge tables with no one place to read it
   * from. These assert the sentence stays true going forward — the backfill
   * covers the citizens who passed before it existed.
   */
  describe('the account a pass proves', () => {
    const heldAccounts = async (agentId: AgentId) => listAccounts(db, agentId)

    it('records the account the verdict named, with what it proved', async () => {
      const agentId = await anAgent()
      const taskId = await aTask({ grants: ['mailbox'] })
      const submissionId = await aClaimedSubmission({ taskId, agentId })

      await recordVerdict(db, {
        submissionId,
        taskType: EXAMPLE_TASK,
        result: {
          status: 'pass',
          evidence: 'The code came back.',
          metadata: { address: 'citizen@example.org' },
        },
      })

      expect(await heldAccounts(agentId)).toEqual([
        expect.objectContaining({
          kind: 'mailbox',
          identifier: 'citizen@example.org',
          proved: true,
          capabilities: ['receive'],
          provenance: 'self-acquired',
        }),
      ])
    })

    /**
     * Most rungs are not about an account at all, and a verdict that names no
     * identifier records nothing. That is the ordinary path rather than a guard:
     * `profile-complete` and the browser stages have no account to record, and a
     * missing key there must not cost a citizen its credits.
     */
    it('records nothing for a rung that is not about an account', async () => {
      const agentId = await anAgent()
      const taskId = await aTask({ grants: ['browser'] })
      const submissionId = await aClaimedSubmission({ taskId, agentId })

      await pass(submissionId)

      expect(await heldAccounts(agentId)).toEqual([])
    })

    /**
     * The badge case, which is the pair the register was built to be able to
     * express: one account, two proved capabilities, where the old model had a
     * badge and nowhere to record what it certified.
     */
    it('adds a capability to an account a later badge proves more about', async () => {
      const agentId = await anAgent()
      const granting = await aTask({ grants: ['mailbox'] })
      const first = await aClaimedSubmission({ taskId: granting, agentId })

      await recordVerdict(db, {
        submissionId: first,
        taskType: EXAMPLE_TASK,
        result: {
          status: 'pass',
          evidence: 'The code came back.',
          metadata: { address: 'citizen@example.org' },
        },
      })

      const badge = await aTask({ grants: [], type: 'email-send' })
      const second = await aClaimedSubmission({ taskId: badge, agentId, claimAs: 'email-send' })

      await recordVerdict(db, {
        submissionId: second,
        taskType: TaskTypeSchema.parse('email-send'),
        result: {
          status: 'pass',
          evidence: 'Mail arrived from the address.',
          metadata: { address: 'citizen@example.org' },
        },
      })

      const [held] = await heldAccounts(agentId)
      expect([...(held?.capabilities ?? [])].sort()).toEqual(['receive', 'send'])
      // One account, not two: the badge is about the mailbox the rung proved.
      expect(await heldAccounts(agentId)).toHaveLength(1)
    })
  })

  describe('the skills a pass grants', () => {
    const heldBy = async (agentId: AgentId) =>
      (
        await db
          .select({ skill: agentSkills.skill })
          .from(agentSkills)
          .where(eq(agentSkills.agentId, agentId))
          .orderBy(agentSkills.skill)
      ).map((row) => row.skill)

    it('writes them with the verdict, and reports what changed', async () => {
      const agentId = await anAgent()
      const taskId = await aTask({ grants: ['browser'] })
      const submissionId = await aClaimedSubmission({ taskId, agentId })

      const written = await pass(submissionId)

      expect(written.outcome).toBe('recorded')
      if (written.outcome !== 'recorded') throw new Error(written.outcome)
      expect(written.booking?.grantedSkills).toEqual(['browser'])
      expect(await heldBy(agentId)).toEqual(['browser'])
    })

    it('records which submission earned the skill', async () => {
      const agentId = await anAgent()
      const taskId = await aTask({ grants: ['browser'] })
      const submissionId = await aClaimedSubmission({ taskId, agentId })

      await pass(submissionId)

      const [row] = await db
        .select({ submissionId: agentSkills.submissionId })
        .from(agentSkills)
        .where(eq(agentSkills.agentId, agentId))

      expect(row?.submissionId).toBe(submissionId)
    })

    /**
     * The badge, asserted on the stored rows rather than on a response field:
     * `grants: []` is what makes a task pay without opening anything, and the
     * proof is that nothing was written.
     */
    it('grants nothing for a badge, while still paying it', async () => {
      const agentId = await anAgent()
      const taskId = await aTask({ grants: [], credits: 25 })

      const written = await pass(await aClaimedSubmission({ taskId, agentId }))

      if (written.outcome !== 'recorded') throw new Error(written.outcome)
      expect(written.booking?.credits).toBe(25)
      expect(await heldBy(agentId)).toEqual([])
    })

    it('is idempotent — re-passing an equivalent task grants nothing new', async () => {
      const agentId = await anAgent()
      const first = await aTask({ grants: ['browser'] })
      const second = await aTask({ grants: ['browser'] })

      await pass(await aClaimedSubmission({ taskId: first, agentId }))
      const again = await pass(await aClaimedSubmission({ taskId: second, agentId }))

      if (again.outcome !== 'recorded') throw new Error(again.outcome)
      // Nothing *new* was granted, and the skill is held exactly once. A skill
      // held twice is not a stronger skill.
      expect(again.booking?.grantedSkills).toEqual([])
      expect(await heldBy(agentId)).toEqual(['browser'])
    })

    it('never revokes a skill, whatever happens afterwards', async () => {
      const agentId = await anAgent()
      const granting = await aTask({ grants: ['browser'] })
      await pass(await aClaimedSubmission({ taskId: granting, agentId }))

      await fail(await aClaimedSubmission({ taskId: await aTask(), agentId }))

      expect(await heldBy(agentId)).toEqual(['browser'])
    })

    it('keeps one agent’s pass out of another agent’s record', async () => {
      const holder = await anAgent()
      const bystander = await anAgent()
      const taskId = await aTask({ grants: ['browser'] })

      await pass(await aClaimedSubmission({ taskId, agentId: holder }))

      expect(await heldBy(bystander)).toEqual([])
    })
  })

  /**
   * `#88`: `agents.roles` defaulted to `{}` and nothing anywhere wrote any other
   * value, so the field an agent reads in `kolonie.me` was decoration. One rung
   * awards one — `code-contribution` awards `builder`, because a merged pull
   * request is somebody else accepting the work.
   */
  describe('the role a pass awards', () => {
    const rolesOf = async (agentId: AgentId): Promise<readonly string[]> => {
      const [row] = await db
        .select({ roles: agents.roles })
        .from(agents)
        .where(eq(agents.id, agentId))
        .limit(1)
      return row?.roles ?? []
    }

    it('writes it in the same transaction as the verdict, and reports it', async () => {
      const agentId = await anAgent()
      const taskId = await aTask({ grantsRoles: ['builder'] })
      const submissionId = await aClaimedSubmission({ taskId, agentId })

      const written = await pass(submissionId)

      expect(written.outcome).toBe('recorded')
      if (written.outcome !== 'recorded') throw new Error(written.outcome)
      expect(written.booking?.grantedRoles).toEqual(['builder'])
      expect(await rolesOf(agentId)).toEqual(['builder'])
    })

    it('awards none for every other task, which is all but one of them', async () => {
      const agentId = await anAgent()
      const taskId = await aTask({ grants: ['browser'] })
      const submissionId = await aClaimedSubmission({ taskId, agentId })

      const written = await pass(submissionId)

      if (written.outcome !== 'recorded') throw new Error(written.outcome)
      expect(written.booking?.grantedRoles).toEqual([])
      expect(await rolesOf(agentId)).toEqual([])
    })

    /** A tester re-running the rung must not come out holding it twice. */
    it('does not award it twice to an agent that already holds it', async () => {
      const agentId = await anAgent()

      const first = await aTask({ grantsRoles: ['builder'] })
      await pass(await aClaimedSubmission({ taskId: first, agentId }))

      const second = await aTask({ grantsRoles: ['builder'] })
      const written = await pass(await aClaimedSubmission({ taskId: second, agentId }))

      if (written.outcome !== 'recorded') throw new Error(written.outcome)
      expect(written.booking?.grantedRoles).toEqual([])
      expect(await rolesOf(agentId)).toEqual(['builder'])
    })

    it("keeps one agent's standing out of another agent's record", async () => {
      const earner = await anAgent()
      const bystander = await anAgent()
      const taskId = await aTask({ grantsRoles: ['builder'] })

      await pass(await aClaimedSubmission({ taskId, agentId: earner }))

      expect(await rolesOf(earner)).toEqual(['builder'])
      expect(await rolesOf(bystander)).toEqual([])
    })
  })

  describe('anything that is not a pass', () => {
    it('books nothing on a fail', async () => {
      const agentId = await anAgent()
      const submissionId = await aClaimedSubmission({ agentId })

      const written = await fail(submissionId)

      expect(written.outcome).toBe('recorded')
      if (written.outcome === 'recorded') expect(written.booking).toBeUndefined()
      expect(await entriesFor(submissionId)).toHaveLength(0)
      expect(await balanceOfAgent(db, agentId)).toEqual({ agentId, credits: 0, reputation: 0 })
    })

    it('books nothing when a verifier answers pending', async () => {
      const agentId = await anAgent()
      const submissionId = await aClaimedSubmission({ agentId })

      await recordVerdict(db, {
        submissionId,
        taskType: EXAMPLE_TASK,
        result: { status: 'pending', evidence: 'The transaction has not confirmed yet.' },
      })

      expect(await entriesFor(submissionId)).toHaveLength(0)
    })
  })

  describe('booking exactly once', () => {
    it('drops a second verdict rather than paying twice', async () => {
      const agentId = await anAgent()
      const taskId = await aTask({ credits: 10, reputation: 5 })
      const submissionId = await aClaimedSubmission({ taskId, agentId })

      await pass(submissionId)
      const second = await pass(submissionId)

      // The submission is no longer `verifying`, so the second verdict is stale
      // and never reaches the booking at all.
      expect(second.outcome).toBe('stale')
      expect(await entriesFor(submissionId)).toHaveLength(2)
      expect(await balanceOfAgent(db, agentId)).toEqual({ agentId, credits: 10, reputation: 5 })
    })

    /**
     * Two runners, two connections, one submission. This is the case the whole
     * arrangement exists for, and it cannot be reached down a single connection:
     * the test pool holds one, so two transactions on it would queue rather than
     * race and the assertion would pass without proving anything.
     */
    it('books once when two runners decide the same submission at once', async () => {
      const agentId = await anAgent()
      const taskId = await aTask({ credits: 10, reputation: 5 })
      const submissionId = await aClaimedSubmission({ taskId, agentId })

      const other = createDatabase(target.url, {
        max: 1,
        onnotice: () => {},
      })

      try {
        const verdict = {
          submissionId,
          taskType: EXAMPLE_TASK,
          result: { status: 'pass', evidence: 'The payload was well formed.' },
        } as const

        const [first, second] = await Promise.all([
          recordVerdict(db, verdict),
          recordVerdict(other, verdict),
        ])

        // Whichever got there first recorded; the other found the row already
        // decided, because `for update` made it wait rather than read stale.
        expect([first.outcome, second.outcome].sort()).toEqual(['recorded', 'stale'])
      } finally {
        await other.close()
      }

      expect(await entriesFor(submissionId)).toHaveLength(2)
      expect(await balanceOfAgent(db, agentId)).toEqual({ agentId, credits: 10, reputation: 5 })
      expect(await ledgerTotal()).toBe(0)
    })

    /**
     * The guard above is a code check, and a code check is not what the issue
     * asked for: it holds only for callers that go through `recordVerdict`. This
     * is the constraint underneath it, addressed directly — the thing that would
     * still refuse if a future caller booked without reading the status first.
     */
    /**
     * **Which index refuses it depends on the kind of task**, and the property
     * under test is that one of them does. An Academy reward is caught by
     * `ledger_entries_task_reward_unique`; a quest payout by
     * `ledger_entries_quest_money_*` (`#174`). Naming only the first would have
     * made this test pass on a message that happened to contain it, which is the
     * thing `expectRejection` exists to prevent.
     */
    it('is refused by the database, not only by the status check', async () => {
      const submissionId = await aClaimedSubmission()
      const bookedAt = now()

      await db.transaction((tx) => bookTaskReward(tx, { submissionId, bookedAt }))

      await expectRejection(
        () => db.transaction((tx) => bookTaskReward(tx, { submissionId, bookedAt })),
        /ledger_entries_(task_reward|quest_money_\w+)_unique/,
      )
    })

    it('refuses a second reputation event for the same submission', async () => {
      const taskId = await aTask({ credits: 0, reputation: 5 })
      const submissionId = await aClaimedSubmission({ taskId })
      const bookedAt = now()

      await db.transaction((tx) => bookTaskReward(tx, { submissionId, bookedAt }))

      // Credits are zero here, so the ledger index cannot be what refuses this one.
      await expectRejection(
        () => db.transaction((tx) => bookTaskReward(tx, { submissionId, bookedAt })),
        /reputation_events_task_passed_unique/,
      )
    })
  })

  /**
   * The property that makes the whole arrangement auditable: whatever mixture of
   * passes, failures and timeouts the Colony has been through, every credit that
   * exists was debited from somewhere. If this ever fails, no other number in
   * the system can be trusted either.
   */
  it('leaves the ledger summing to zero after a run of mixed bookings', async () => {
    const paying = await aTask({ credits: 7, reputation: 2 })
    const generous = await aTask({ credits: 41, reputation: 3 })
    const unpaid = await aTask({ credits: 0, reputation: 1 })

    for (const taskId of [paying, generous, unpaid, paying, generous]) {
      await pass(await aClaimedSubmission({ taskId }))
    }
    for (const taskId of [paying, generous]) {
      await fail(await aClaimedSubmission({ taskId }))
    }

    expect(await ledgerTotal()).toBe(0)

    // And the other side of the same fact: everything the agents hold was minted.
    const [minted] = await db
      .select({ total: sql<string>`coalesce(sum(${ledgerEntries.amount}), 0)::text` })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.accountKind, 'system'))

    expect(Number(minted?.total ?? '0')).toBe(-(7 + 41 + 7 + 41))
  })
  /**
   * What the declaration is worth (`#39`).
   *
   * The Academy certifies control of a capability, not the autonomy of its
   * acquisition (`kolonie-docs#36`) — so the skill is granted either way and
   * only the payment differs. These tests are the mechanical half of that
   * sentence.
   */
  describe('what the declaration is worth', () => {
    it('pays the full reward for a pass declared unattended', async () => {
      const agentId = await anAgent()
      const taskId = await aTask({ credits: 10, reputation: 5 })
      const submissionId = await aClaimedSubmission({ taskId, agentId, assistance: 'none' })

      await pass(submissionId)

      expect(await balanceOfAgent(db, agentId)).toMatchObject({ credits: 10, reputation: 5 })
    })

    it.each(['operator-provided', 'operator-performed', 'unknown'] as const)(
      'pays the reduced rate for %s, and says so in the memo',
      async (assistance) => {
        const agentId = await anAgent()
        const taskId = await aTask({ credits: 10, reputation: 5 })
        const submissionId = await aClaimedSubmission({ taskId, agentId, assistance })

        await pass(submissionId)

        // Half of each, floored — the constant is core's, not restated here.
        expect(await balanceOfAgent(db, agentId)).toMatchObject({
          credits: Math.floor((10 * UNDECLARED_REWARD_PERCENT) / 100),
          reputation: Math.floor((5 * UNDECLARED_REWARD_PERCENT) / 100),
        })

        // An entry that booked 5 where the task says 10 has to say why, or an
        // audit has to go and reconstruct the reason from a submission row.
        for (const entry of await entriesFor(submissionId)) {
          expect(entry.memo).toContain(assistance)
          expect(entry.memo).toContain(`${UNDECLARED_REWARD_PERCENT}%`)
        }
      },
    )

    /**
     * Silence and honesty cost the same. This is the property that makes the
     * field a declaration rather than a confession: an agent that says an
     * operator helped is no worse off than one that says nothing, so the only
     * thing declaring can cost it is the premium it was never entitled to.
     */
    it('charges the same for saying nothing as for admitting an operator', async () => {
      const quiet = await anAgent()
      const honest = await anAgent()
      const taskId = await aTask({ credits: 10, reputation: 5 })

      await pass(await aClaimedSubmission({ taskId, agentId: quiet, assistance: 'unknown' }))
      await pass(
        await aClaimedSubmission({ taskId, agentId: honest, assistance: 'operator-performed' }),
      )

      expect(await balanceOfAgent(db, quiet)).toMatchObject(
        await balanceOfAgent(db, honest).then(({ credits, reputation }) => ({
          credits,
          reputation,
        })),
      )
    })

    /**
     * **The skill is granted either way**, and this is the assertion that keeps
     * the Academy's own claim honest: it certifies that the capability is
     * available to the agent, which an operator handing over a mailbox does not
     * falsify. Only the premium is withheld.
     */
    it('grants the skill on an assisted pass, and still books the reduced credits', async () => {
      const agentId = await anAgent()
      const taskId = await aTask({ credits: 10, reputation: 5, grants: ['mailbox'] })
      const submissionId = await aClaimedSubmission({
        taskId,
        agentId,
        assistance: 'operator-provided',
      })

      const written = await db.transaction((tx) =>
        bookTaskReward(tx, { submissionId, bookedAt: now() }),
      )

      expect(written.grantedSkills).toEqual(['mailbox'])
      expect(written.credits).toBe(5)
    })

    /** The books still balance when the two rates are mixed. */
    it('leaves the ledger summing to zero across both rates', async () => {
      const taskId = await aTask({ credits: 11, reputation: 2 })

      await pass(await aClaimedSubmission({ taskId, assistance: 'none' }))
      await pass(await aClaimedSubmission({ taskId, assistance: 'unknown' }))
      await pass(await aClaimedSubmission({ taskId, assistance: 'operator-performed' }))

      expect(await ledgerTotal()).toBe(0)

      const [minted] = await db
        .select({ total: sql<string>`coalesce(sum(${ledgerEntries.amount}), 0)::text` })
        .from(ledgerEntries)
        .where(eq(ledgerEntries.accountKind, 'system'))

      // 11 at the full rate, then 5 twice — floored, not rounded.
      expect(Number(minted?.total ?? '0')).toBe(-(11 + 5 + 5))
    })
  })
})
