import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import {
  AgentPlatformSchema,
  CitizenshipStatusSchema,
  CredentialKindSchema,
  LedgerEntryTypeSchema,
  ReputationReasonSchema,
  RoleSchema,
  SubmissionStatusSchema,
  SystemAccountSchema,
  TaskStatusSchema,
  TASK_TYPE_PATTERN,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, expectRejection, truncateAll } from '../testing.js'
import { agents, credentials, ledgerEntries, submissions, tasks } from './index.js'

const target = databaseTestTarget()

if (!target.available) {
  // Deliberately console, and deliberately at module scope: this has to be
  // visible before the reporter prints a tidy "skipped".
  console.warn(`\n${target.reason}\n`)
}

describe.skipIf(!target.available)('schema', () => {
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

  const anAgent = async (overrides: Partial<typeof agents.$inferInsert> = {}) => {
    const [row] = await db
      .insert(agents)
      .values({ name: 'canary', platform: 'openclaw', ...overrides })
      .returning()
    return row!
  }

  const aTask = async (overrides: Partial<typeof tasks.$inferInsert> = {}) => {
    const [row] = await db
      .insert(tasks)
      .values({
        type: 'email-create',
        level: 3,
        title: 'Create an email address',
        description: 'Prove you can operate your own mailbox.',
        instructions: 'Create an address and send a mail to the given recipient.',
        rewardCoins: 50,
        rewardReputation: 5,
        timeoutHours: 24,
        status: 'active',
        ...overrides,
      })
      .returning()
    return row!
  }

  /**
   * Booking helper. Every ledger write goes through a database transaction,
   * because the double-entry invariant is only checked at COMMIT.
   */
  const book = async (
    entries: readonly Omit<typeof ledgerEntries.$inferInsert, 'transactionId'>[],
    transactionId = randomUUID(),
  ) => {
    await db.transaction(async (tx) => {
      for (const entry of entries) {
        await tx.insert(ledgerEntries).values({ ...entry, transactionId })
      }
    })
    return transactionId
  }

  describe('the migration', () => {
    it('creates exactly the ten tables the MVP loop needs', async () => {
      const rows = await db.execute<{ table_name: string }>(
        sql`select table_name from information_schema.tables
             where table_schema = 'public' and table_type = 'BASE TABLE'
             order by table_name`,
      )
      expect(rows.map((r) => r.table_name)).toEqual([
        // `agent_skills` joined the list with D-030: what an agent may attempt
        // stopped being a number on the agent row and became a set of rows with
        // provenance.
        'agent_skills',
        'agents',
        'browser_challenges',
        'credentials',
        'email_challenges',
        'ledger_entries',
        'reputation_events',
        'submissions',
        'tasks',
        'verifications',
      ])
    })

    /**
     * D-002. This is the assertion that fails on the day somebody adds a balance
     * column "just for performance". That is the whole reason it exists.
     */
    it('keeps no balance on the agent row', async () => {
      const rows = await db.execute<{ column_name: string }>(
        sql`select column_name from information_schema.columns
             where table_schema = 'public' and table_name = 'agents'`,
      )
      const columns = rows.map((r) => r.column_name)
      expect(columns).not.toContain('coins')
      expect(columns).not.toContain('reputation')
    })
  })

  describe('enums match packages/core', () => {
    const pgEnumValues = async (name: string) => {
      const rows = await db.execute<{ value: string }>(
        sql`select e.enumlabel as value from pg_enum e
              join pg_type t on t.oid = e.enumtypid
             where t.typname = ${name}
             order by e.enumsortorder`,
      )
      return rows.map((r) => r.value)
    }

    /**
     * The database enums are generated from the Zod enums, so these cannot
     * disagree today. They assert that nobody replaces the derivation with a
     * hand-written list later — which is how the two would start to drift.
     */
    it.each([
      ['agent_platform', AgentPlatformSchema.options],
      ['citizenship_status', CitizenshipStatusSchema.options],
      ['role', RoleSchema.options],
      ['credential_kind', CredentialKindSchema.options],
      ['task_status', TaskStatusSchema.options],
      ['submission_status', SubmissionStatusSchema.options],
      ['system_account', SystemAccountSchema.options],
      ['ledger_entry_type', LedgerEntryTypeSchema.options],
      ['reputation_reason', ReputationReasonSchema.options],
    ])('%s', async (name, expected) => {
      expect(await pgEnumValues(name)).toEqual([...expected])
    })

    /** D-001: `candidate` and `citizen` are statuses, never roles. */
    it('cannot store a citizenship status in the roles column', async () => {
      await expectRejection(
        () =>
          db.execute(
            sql`insert into agents (name, platform, roles)
                values ('impostor', 'openclaw', array['citizen']::role[])`,
          ),
        /invalid input value for enum role/i,
      )
    })
  })

  describe('agents', () => {
    it('stores an agent with no coins, no roles and level 0', async () => {
      const agent = await anAgent()
      expect(agent.status).toBe('candidate')
      expect(agent.roles).toEqual([])
      expect(agent.level).toBe(0)
    })

    it('accumulates roles', async () => {
      const agent = await anAgent({ roles: ['builder', 'reviewer'] })
      expect(agent.roles).toEqual(['builder', 'reviewer'])
    })

    it.each([-1, 14])('rejects level %i', async (level) => {
      await expectRejection(() => anAgent({ level }), /agents_level_range/)
    })

    it('rejects a name shorter than two characters', async () => {
      await expectRejection(() => anAgent({ name: 'x' }), /agents_name_min_length/)
    })

    it('rejects two agents claiming the same wallet', async () => {
      await anAgent({ name: 'first', wallet: '0xabc' })
      await expectRejection(
        () => anAgent({ name: 'second', wallet: '0xabc' }),
        /agents_wallet_unique/,
      )
    })

    it('lets many agents have no wallet at all', async () => {
      await anAgent({ name: 'first' })
      await expect(anAgent({ name: 'second' })).resolves.toBeDefined()
    })
  })

  describe('credentials', () => {
    it('stores an api key as a hash and nothing else', async () => {
      const agent = await anAgent()
      const [credential] = await db
        .insert(credentials)
        .values({ agentId: agent.id, kind: 'api-key', secretHash: 'sha256:deadbeef' })
        .returning()

      expect(credential!.lastUsedAt).toBeNull()
      expect(credential!.revokedAt).toBeNull()
      // There is nowhere for a plaintext key to live, by construction.
      expect(Object.keys(credential!)).not.toContain('secret')
      expect(Object.keys(credential!)).not.toContain('apiKey')
    })

    it('rejects an api key with no hash', async () => {
      const agent = await anAgent()
      await expectRejection(
        () => db.insert(credentials).values({ agentId: agent.id, kind: 'api-key' }),
        /credentials_api_key_requires_hash/,
      )
    })

    it('allows a wallet credential with no hash', async () => {
      const agent = await anAgent()
      await expect(
        db.insert(credentials).values({ agentId: agent.id, kind: 'wallet-signature' }),
      ).resolves.toBeDefined()
    })

    it('rejects two credentials with the same hash', async () => {
      const agent = await anAgent()
      await db
        .insert(credentials)
        .values({ agentId: agent.id, kind: 'api-key', secretHash: 'sha256:same' })
      await expectRejection(
        () =>
          db
            .insert(credentials)
            .values({ agentId: agent.id, kind: 'api-key', secretHash: 'sha256:same' }),
        /credentials_secret_hash_unique/,
      )
    })

    it('lets an agent hold several credentials over time', async () => {
      const agent = await anAgent()
      await db.insert(credentials).values([
        { agentId: agent.id, kind: 'api-key', secretHash: 'sha256:one', label: null },
        { agentId: agent.id, kind: 'api-key', secretHash: 'sha256:two', label: 'ci runner' },
      ])
      expect(await db.$count(credentials)).toBe(2)
    })
  })

  describe('tasks', () => {
    it('rejects a type that is not a kebab-case slug', async () => {
      await expectRejection(() => aTask({ type: 'Email Create' }), /tasks_type_slug/)
    })

    /**
     * The slug rule exists twice — as `TASK_TYPE_PATTERN` in core and as a regex
     * in the check constraint — because a check constraint cannot call
     * TypeScript. This asserts the two agree on the same inputs.
     */
    it.each(['email-create', 'github-issue', 'x1', 'Email-Create', 'trailing-'])(
      'agrees with TASK_TYPE_PATTERN about %s',
      async (candidate) => {
        const coreAccepts = TASK_TYPE_PATTERN.test(candidate) && candidate.length >= 3
        const dbAccepts = await aTask({ type: candidate }).then(
          () => true,
          () => false,
        )
        expect(dbAccepts).toBe(coreAccepts)
      },
    )

    it('rejects a negative reward', async () => {
      await expectRejection(() => aTask({ rewardCoins: -1 }), /tasks_reward_non_negative/)
    })

    it.each([0, 721])('rejects a timeout of %i hours', async (timeoutHours) => {
      await expectRejection(() => aTask({ timeoutHours }), /tasks_timeout_hours_range/)
    })

    it('keeps a task when its author is deleted', async () => {
      const author = await anAgent({ name: 'author' })
      const task = await aTask({ createdBy: author.id })
      await db.delete(agents).where(sql`${agents.id} = ${author.id}`)

      const [kept] = await db
        .select()
        .from(tasks)
        .where(sql`${tasks.id} = ${task.id}`)
      expect(kept?.createdBy).toBeNull()
    })
  })

  describe('submissions', () => {
    it('starts pending with no verdict time', async () => {
      const agent = await anAgent()
      const task = await aTask()
      const [submission] = await db
        .insert(submissions)
        .values({ taskId: task.id, agentId: agent.id, payload: { address: 'a@example.test' } })
        .returning()

      expect(submission!.status).toBe('pending')
      expect(submission!.attempt).toBe(1)
      expect(submission!.verifiedAt).toBeNull()
    })

    it.each(SubmissionStatusSchema.options.filter((s) => s !== 'pending' && s !== 'verifying'))(
      'rejects %s without a verdict time',
      async (status) => {
        const agent = await anAgent()
        const task = await aTask()
        await expectRejection(
          () =>
            db
              .insert(submissions)
              .values({ taskId: task.id, agentId: agent.id, payload: {}, status }),
          /submissions_verified_at_matches_status/,
        )
      },
    )

    it('rejects a verdict time on a submission still being verified', async () => {
      const agent = await anAgent()
      const task = await aTask()
      await expectRejection(
        () =>
          db.insert(submissions).values({
            taskId: task.id,
            agentId: agent.id,
            payload: {},
            status: 'verifying',
            verifiedAt: new Date().toISOString(),
          }),
        /submissions_verified_at_matches_status/,
      )
    })

    it('rejects a second row for the same attempt', async () => {
      const agent = await anAgent()
      const task = await aTask()
      const row = { taskId: task.id, agentId: agent.id, payload: {}, attempt: 1 }
      await db.insert(submissions).values(row)
      await expectRejection(
        () => db.insert(submissions).values(row),
        /submissions_task_agent_attempt_unique/,
      )
    })

    it('allows a retry as a new attempt', async () => {
      const agent = await anAgent()
      const task = await aTask()
      await db.insert(submissions).values({
        taskId: task.id,
        agentId: agent.id,
        payload: {},
        attempt: 1,
        status: 'failed',
        verifiedAt: new Date().toISOString(),
      })
      await expect(
        db
          .insert(submissions)
          .values({ taskId: task.id, agentId: agent.id, payload: {}, attempt: 2 }),
      ).resolves.toBeDefined()
    })

    it('refuses to delete a task that has submissions', async () => {
      const agent = await anAgent()
      const task = await aTask()
      await db.insert(submissions).values({ taskId: task.id, agentId: agent.id, payload: {} })

      await expectRejection(
        () => db.delete(tasks).where(sql`${tasks.id} = ${task.id}`),
        /submissions_task_id_tasks_id_fk/,
      )
    })
  })

  describe('the ledger', () => {
    it('books a balanced reward', async () => {
      const agent = await anAgent()
      await book([
        { accountKind: 'system', systemAccount: 'mint', amount: -50, type: 'task_reward' },
        { accountKind: 'agent', agentId: agent.id, amount: 50, type: 'task_reward' },
      ])

      const [row] = await db.execute<{ total: string }>(
        sql`select coalesce(sum(amount), 0)::text as total from ledger_entries`,
      )
      expect(row!.total).toBe('0')
    })

    /**
     * The rejection case the definition of done requires. This is the single
     * most important assertion in the package: if it ever stops holding, every
     * balance the Colony reports becomes unverifiable.
     */
    it('rejects a transaction that does not sum to zero', async () => {
      const agent = await anAgent()
      await expectRejection(
        () =>
          book([
            { accountKind: 'system', systemAccount: 'mint', amount: -50, type: 'task_reward' },
            { accountKind: 'agent', agentId: agent.id, amount: 60, type: 'task_reward' },
          ]),
        /sums to 10, but double-entry requires 0/,
      )
    })

    it('rejects a single-sided transaction', async () => {
      const agent = await anAgent()
      await expectRejection(
        () => book([{ accountKind: 'agent', agentId: agent.id, amount: 50, type: 'task_reward' }]),
        /requires at least 2/,
      )
    })

    it('rejects a zero-amount entry padding a transaction', async () => {
      const agent = await anAgent()
      await expectRejection(
        () =>
          book([
            { accountKind: 'agent', agentId: agent.id, amount: 0, type: 'adjustment' },
            { accountKind: 'system', systemAccount: 'mint', amount: 0, type: 'adjustment' },
          ]),
        /ledger_entries_amount_non_zero/,
      )
    })

    it('rejects an entry belonging to both an agent and a system account', async () => {
      const agent = await anAgent()
      await expectRejection(
        () =>
          book([
            {
              accountKind: 'agent',
              agentId: agent.id,
              systemAccount: 'mint',
              amount: -50,
              type: 'task_reward',
            },
            { accountKind: 'agent', agentId: agent.id, amount: 50, type: 'task_reward' },
          ]),
        /ledger_entries_account_exclusive/,
      )
    })

    it('rejects an entry belonging to neither', async () => {
      await expectRejection(
        () =>
          book([
            { accountKind: 'agent', amount: -50, type: 'task_reward' },
            { accountKind: 'system', systemAccount: 'mint', amount: 50, type: 'task_reward' },
          ]),
        /ledger_entries_account_exclusive/,
      )
    })

    it('rejects entries of one transaction disagreeing about the reference', async () => {
      const agent = await anAgent()
      await expectRejection(
        () =>
          book([
            {
              accountKind: 'system',
              systemAccount: 'mint',
              amount: -50,
              type: 'task_reward',
              reference: 'submission:1',
            },
            {
              accountKind: 'agent',
              agentId: agent.id,
              amount: 50,
              type: 'task_reward',
              reference: 'submission:2',
            },
          ]),
        /different references/,
      )
    })

    it('rejects deleting one side of a booked transaction', async () => {
      const agent = await anAgent()
      const transactionId = await book([
        { accountKind: 'system', systemAccount: 'mint', amount: -50, type: 'task_reward' },
        { accountKind: 'agent', agentId: agent.id, amount: 50, type: 'task_reward' },
      ])

      await expectRejection(
        () =>
          db.delete(ledgerEntries).where(
            sql`${ledgerEntries.transactionId} = ${transactionId}
                and ${ledgerEntries.accountKind} = 'agent'`,
          ),
        /requires at least 2/,
      )
    })

    it('refuses to delete an agent that has been paid', async () => {
      const agent = await anAgent()
      await book([
        { accountKind: 'system', systemAccount: 'mint', amount: -50, type: 'task_reward' },
        { accountKind: 'agent', agentId: agent.id, amount: 50, type: 'task_reward' },
      ])

      await expectRejection(
        () => db.delete(agents).where(sql`${agents.id} = ${agent.id}`),
        /ledger_entries_agent_id_agents_id_fk/,
      )
    })

    /** D-003's payoff: total supply is auditable without trusting any counter. */
    it('derives total supply as the negative of the mint balance', async () => {
      const one = await anAgent({ name: 'one' })
      const two = await anAgent({ name: 'two' })
      await book([
        { accountKind: 'system', systemAccount: 'mint', amount: -50, type: 'task_reward' },
        { accountKind: 'agent', agentId: one.id, amount: 50, type: 'task_reward' },
      ])
      await book([
        { accountKind: 'system', systemAccount: 'mint', amount: -30, type: 'task_reward' },
        { accountKind: 'agent', agentId: two.id, amount: 30, type: 'task_reward' },
      ])
      // A transfer moves coins without creating any.
      await book([
        { accountKind: 'agent', agentId: one.id, amount: -20, type: 'transfer' },
        { accountKind: 'agent', agentId: two.id, amount: 20, type: 'transfer' },
      ])

      const [mint] = await db.execute<{ balance: string }>(
        sql`select coalesce(sum(amount), 0)::text as balance
              from ledger_entries where system_account = 'mint'`,
      )
      const [held] = await db.execute<{ balance: string }>(
        sql`select coalesce(sum(amount), 0)::text as balance
              from ledger_entries where account_kind = 'agent'`,
      )
      expect(mint!.balance).toBe('-80')
      expect(held!.balance).toBe('80')
    })
  })
})
