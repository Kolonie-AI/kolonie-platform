import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, expectRejection } from '../testing.js'
import {
  agentSkills,
  agents,
  banMarks,
  browserChallenges,
  credentials,
  emailChallenges,
  erasures,
  githubChallenges,
  keyChallenges,
  ledgerEntries,
  moderations,
  powChallenges,
  reputationEvents,
  socialChallenges,
  solanaWalletChallenges,
  submissions,
  supportTickets,
  taskResets,
  taskStruggles,
  taskTips,
  tasks,
  tipFeedback,
  verifications,
  visionChallenges,
  imageChallenges,
  websiteChallenges,
} from './index.js'

const target = databaseTestTarget()

if (!target.available) {
  console.warn(`\n${target.reason}\n`)
}

/**
 * The erasure boundary (#90): what goes with a citizen, what outlives one, and
 * the two tables that name nobody.
 *
 * `governance/erasure.md` in kolonie-docs is the design. This file is where the
 * schema half of it is either true or not, and it is deliberately blunt about
 * the two things a reviewer cannot check by reading a diff: that *every*
 * cascading table really is empty afterwards, and that the ledger really does
 * refuse an erasure that skipped the burn.
 */
describe.skipIf(!target.available)('the erasure boundary', () => {
  let db: Database

  beforeAll(async () => {
    if (!target.available) return
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    // Named rather than left to `cascade`, for the reason `truncateAll` gives:
    // a table that is only reached by a foreign key stops being truncated the
    // day somebody adds one without a reference.
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
    return row!
  }

  const aTask = async (overrides: Partial<typeof tasks.$inferInsert> = {}) => {
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
        ...overrides,
      })
      .returning()
    return row!
  }

  const later = () => new Date(Date.now() + 60 * 60 * 1000).toISOString()

  /**
   * Every table whose rows belong to a citizen, with one row written into each.
   *
   * **Enumerated and not sampled**, which the issue asks for and which is the
   * only form that can catch what this test is for: a table added later with a
   * `restrict` reference to `agents`. A sampled test passes over it forever,
   * and the failure it hides does not appear until a real citizen tries to
   * leave and the transaction aborts.
   *
   * The two indirect ones are here for the same reason. `verifications` hangs
   * off a submission and `moderations` off a struggle or a tip, so neither
   * names an agent — but both hold a citizen's evidence, and both used to
   * `restrict` the row above them.
   */
  const aCitizenWithHistoryEverywhere = async () => {
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

    await db.insert(credentials).values({ agentId: agent.id, kind: 'api-key', secretHash: 'x' })
    await db
      .insert(agentSkills)
      .values({ agentId: agent.id, skill: 'mailbox', submissionId: submission!.id })
    await db.insert(verifications).values({
      submissionId: submission!.id,
      taskType: 'email-create',
      status: 'pass',
      evidence: 'the mail arrived',
    })
    await db
      .insert(reputationEvents)
      .values({ agentId: agent.id, delta: 5, reason: 'task_passed', submissionId: submission!.id })
    await db.insert(taskResets).values({
      agentId: agent.id,
      taskId: task.id,
      supersededSubmissionId: submission!.id,
      reason: 're-running it as a tester',
    })
    await db.insert(supportTickets).values({
      agentId: agent.id,
      kind: 'question',
      subject: 'How does the graph work?',
      body: 'The documentation did not say.',
    })

    await db.insert(browserChallenges).values({ agentId: agent.id, expiresAt: later() })
    await db
      .insert(emailChallenges)
      .values({ agentId: agent.id, address: 'a@b.invalid', token: 't', expiresAt: later() })
    await db.insert(githubChallenges).values({ agentId: agent.id, nonce: 'n', expiresAt: later() })
    await db.insert(socialChallenges).values({ agentId: agent.id, nonce: 'n', expiresAt: later() })
    await db.insert(keyChallenges).values({ agentId: agent.id, nonce: 'n', expiresAt: later() })
    await db
      .insert(solanaWalletChallenges)
      .values({ agentId: agent.id, nonce: 'n', expiresAt: later() })
    await db
      .insert(powChallenges)
      .values({ agentId: agent.id, input: 'i', difficulty: 8, expiresAt: later() })
    await db.insert(visionChallenges).values({
      agentId: agent.id,
      imageName: 'one.jpg',
      question: 'how many?',
      expectedAnswer: '3',
      expiresAt: later(),
    })
    await db.insert(imageChallenges).values({
      agentId: agent.id,
      background: 'green',
      shape: 'cube',
      shapeColor: 'red',
      position: 'top-left',
      secondary: 'none',
      prompt: 'a red cube on a green background',
      expiresAt: later(),
    })
    await db.insert(websiteChallenges).values({ agentId: agent.id, token: 't', expiresAt: later() })

    const [struggle] = await db
      .insert(taskStruggles)
      .values({ taskId: task.id, agentId: agent.id, content: 'The verifier never answered.' })
      .returning()
    await db
      .insert(taskTips)
      .values({ taskId: task.id, agentId: agent.id, content: 'Send the mail before submitting.' })
    await db.insert(moderations).values({
      subjectKind: 'struggle',
      struggleId: struggle!.id,
      decision: 'approved',
      model: 'a-model',
      stages: {},
      contentSha256: 'a'.repeat(64),
    })

    // A second citizen, who is not going anywhere. The leaver voted on their
    // tip — `erasure.md` §2 lists *the feedback it gave on other citizens' tips*
    // among what goes, and this is the only row in the whole set that sits on
    // somebody else's work. It is what makes the difference between erasing a
    // citizen and erasing everything they ever touched.
    const neighbour = await anAgent({ name: 'neighbour' })
    const [neighboursTip] = await db
      .insert(taskTips)
      .values({ taskId: task.id, agentId: neighbour.id, content: 'Check the spam folder.' })
      .returning()
    await db
      .insert(tipFeedback)
      .values({ tipId: neighboursTip!.id, agentId: agent.id, helpful: true })

    return { agent, neighbour, task, submission: submission!, neighboursTip: neighboursTip! }
  }

  /** Every table that must hold nothing once the citizen is gone. */
  const CITIZEN_TABLES = [
    'credentials',
    'agent_skills',
    'submissions',
    'verifications',
    'reputation_events',
    'task_resets',
    'support_tickets',
    'browser_challenges',
    'email_challenges',
    'github_challenges',
    'social_challenges',
    'key_challenges',
    'solana_wallet_challenges',
    'pow_challenges',
    'vision_challenges',
    'image_challenges',
    'website_challenges',
    'task_struggles',
    'task_tips',
    'tip_feedback',
    'moderations',
  ] as const

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

  /**
   * What is left in each table afterwards. Zero everywhere except `task_tips`,
   * which keeps the neighbour's — an erasure takes the citizen's rows and not
   * every row the citizen was near.
   */
  const SURVIVING: Partial<Record<(typeof CITIZEN_TABLES)[number], number>> = { task_tips: 1 }

  describe('what goes with the citizen', () => {
    it('leaves nothing in any table whose rows were the citizen’s', async () => {
      const { agent, neighbour, neighboursTip } = await aCitizenWithHistoryEverywhere()

      // Every table has something in it first. Without this the test would pass
      // just as happily against an erasure that deleted nothing, because every
      // count would already be zero.
      for (const table of CITIZEN_TABLES) {
        expect(await countIn(table), `${table} was empty before the erasure`).toBeGreaterThan(0)
      }

      await db.delete(agents).where(sql`${agents.id} = ${agent.id}`)

      for (const table of CITIZEN_TABLES) {
        expect(await countIn(table), `${table} did not end up as expected`).toBe(
          SURVIVING[table] ?? 0,
        )
      }

      // And the one survivor is the neighbour's, untouched.
      const [tip] = await db
        .select()
        .from(taskTips)
        .where(sql`${taskTips.id} = ${neighboursTip.id}`)
      expect(tip?.agentId).toBe(neighbour.id)
    })

    /**
     * The task outlives its author, unset. `erasure.md` §2 calls this the model
     * for anything that has to survive a citizen, so it is asserted rather than
     * left to the column comment.
     */
    it('keeps a task the citizen authored, without the citizen', async () => {
      const agent = await anAgent()
      const task = await aTask({ createdBy: agent.id })

      await db.delete(agents).where(sql`${agents.id} = ${agent.id}`)

      const [row] = await db
        .select()
        .from(tasks)
        .where(sql`${tasks.id} = ${task.id}`)
      expect(row?.createdBy).toBeNull()
    })
  })

  describe('the ledger refuses an erasure that skipped the burn', () => {
    const book = async (
      entries: readonly Omit<typeof ledgerEntries.$inferInsert, 'transactionId'>[],
    ) => {
      const transactionId = randomUUID()
      await db.transaction(async (tx) => {
        for (const entry of entries) {
          await tx.insert(ledgerEntries).values({ ...entry, transactionId })
        }
      })
    }

    /**
     * **The invariant the whole chain rests on**, and the reason
     * `ledger_entries.agent_id` is the one reference that stays `restrict`.
     *
     * Refused by the database rather than by application code, which is the
     * point: `#91` will burn the balance before deleting, and this is what
     * happens on the day a later change reorders those two steps or drops the
     * burn on some path nobody tested. A check in TypeScript would be skipped by
     * exactly the caller that got it wrong.
     */
    it('refuses to delete an agent that still holds coins', async () => {
      const agent = await anAgent()
      await book([
        { accountKind: 'agent', agentId: agent.id, amount: 100, type: 'task_reward' },
        { accountKind: 'system', systemAccount: 'mint', amount: -100, type: 'task_reward' },
      ])

      await expectRejection(
        () => db.delete(agents).where(sql`${agents.id} = ${agent.id}`),
        /ledger_entries_agent_id_agents_id_fk/,
      )
    })

    /**
     * **The burn alone is not enough, and this is where `erasure.md` §3 is one
     * step short of what the schema does.** It says:
     *
     * > The agent's balance is quoted and **debited to zero** […] The agent's
     * > entries now sum to zero, so every one of them is deleted with the agent.
     *
     * They are not deleted *with* the agent, because `restrict` refuses on the
     * **existence** of a referencing row and never looks at its sum. A burned
     * account still has every entry it ever had, and the delete is still
     * refused. So the sequence is three steps rather than two — burn, delete the
     * entries, delete the agent — and this test is what says so, because the
     * document does not.
     */
    it('still refuses after the burn, while the entries are still there', async () => {
      const agent = await anAgent()
      await book([
        { accountKind: 'agent', agentId: agent.id, amount: 100, type: 'task_reward' },
        { accountKind: 'system', systemAccount: 'mint', amount: -100, type: 'task_reward' },
      ])
      await book([
        { accountKind: 'agent', agentId: agent.id, amount: -100, type: 'adjustment' },
        { accountKind: 'system', systemAccount: 'mint', amount: 100, type: 'adjustment' },
      ])

      const balance = await db.execute<{ total: string }>(
        sql`select coalesce(sum(amount), 0)::text as total
              from ledger_entries where agent_id = ${agent.id}`,
      )
      expect(Number(balance[0]!.total)).toBe(0)

      await expectRejection(
        () => db.delete(agents).where(sql`${agents.id} = ${agent.id}`),
        /ledger_entries_agent_id_agents_id_fk/,
      )
    })

    /**
     * And the entries cannot be picked off one side at a time.
     *
     * Deleting only the agent's row of a booking leaves the mint's counter-entry
     * alone, and the deferred trigger refuses the transaction at `COMMIT`. This
     * is the constraint that decides *how* `#91` may remove the entries: whole
     * bookings, never one half of one.
     */
    it('refuses to delete one side of a booking', async () => {
      const agent = await anAgent()
      await book([
        { accountKind: 'agent', agentId: agent.id, amount: 100, type: 'task_reward' },
        { accountKind: 'system', systemAccount: 'mint', amount: -100, type: 'task_reward' },
      ])

      // A two-entry booking with one side removed trips the arity check before
      // the sum check; a larger one would trip the sum. Either way the trigger
      // is what refuses, which is the fact being pinned.
      await expectRejection(
        () => db.delete(ledgerEntries).where(sql`${ledgerEntries.agentId} = ${agent.id}`),
        /double-entry requires/,
      )
    })

    /**
     * The whole sequence, end to end, and the property an auditor actually
     * cares about: **total supply is unchanged by an erasure.**
     *
     * The burn destroys the coins — supply goes to zero — and removing the two
     * bookings afterwards moves it by nothing at all, because each booking summed
     * to zero on its own. So the ledger an auditor reads after an erasure agrees
     * with the one they read before it, minus coins that genuinely stopped
     * existing. `erasures.coins_burned` is what tells them why.
     */
    it('goes through once the whole bookings are gone, leaving supply untouched', async () => {
      const agent = await anAgent()
      await book([
        { accountKind: 'agent', agentId: agent.id, amount: 100, type: 'task_reward' },
        { accountKind: 'system', systemAccount: 'mint', amount: -100, type: 'task_reward' },
      ])
      await book([
        { accountKind: 'agent', agentId: agent.id, amount: -100, type: 'adjustment' },
        { accountKind: 'system', systemAccount: 'mint', amount: 100, type: 'adjustment' },
      ])

      const supplyBefore = await totalSupply()

      await db.transaction(async (tx) => {
        await tx.execute(
          sql`delete from ledger_entries where transaction_id in (
                select transaction_id from ledger_entries where agent_id = ${agent.id})`,
        )
        await tx.delete(agents).where(sql`${agents.id} = ${agent.id}`)
      })

      expect(await countIn('agents')).toBe(0)
      expect(await countIn('ledger_entries')).toBe(0)
      expect(await totalSupply()).toBe(supplyBefore)
    })
  })

  describe('the two rows that outlive a citizen', () => {
    /**
     * **Asserted as a shape, not left to review.** The natural instinct of the
     * next person reading `erasures` is that a foreign key is missing, and an
     * `agent_id` added in good faith would undo the entire point of the table
     * without breaking a single other test. This is the one that breaks.
     */
    it('gives `erasures` no reference to an agent, and nothing to write prose in', async () => {
      const references = await db.execute<{ name: string }>(
        sql`select conname as name from pg_constraint
             where conrelid = 'erasures'::regclass and contype = 'f'`,
      )
      expect(references).toEqual([])

      const columns = await db.execute<{ column_name: string; data_type: string }>(
        sql`select column_name, data_type from information_schema.columns
             where table_schema = 'public' and table_name = 'erasures'`,
      )
      const names = columns.map((c) => c.column_name).sort()
      expect(names).toEqual(['coins_burned', 'created_at', 'id', 'reason', 'reputation_destroyed'])
      // `reason` is the enum and every other column is a number, an id or a
      // time. There is nowhere here to put a sentence.
      const free = columns.filter((c) => c.data_type === 'text' || c.data_type.includes('char'))
      expect(free).toEqual([])
    })

    it('records an erasure that burned nothing', async () => {
      // A candidate that registered, earned nothing and left. `coins_burned = 0`
      // is an ordinary erasure and not a padded row, which is why the check
      // constraint refuses negatives rather than zero.
      const [row] = await db
        .insert(erasures)
        .values({ coinsBurned: 0, reputationDestroyed: 0 })
        .returning()
      expect(row?.reason).toBeNull()
    })

    it('refuses a negative burn', async () => {
      await expectRejection(
        () => db.insert(erasures).values({ coinsBurned: -1, reputationDestroyed: 0 }),
        /erasures_amounts_non_negative/,
      )
    })

    it('gives `ban_marks` no reference to an agent either', async () => {
      const references = await db.execute<{ name: string }>(
        sql`select conname as name from pg_constraint
             where conrelid = 'ban_marks'::regclass and contype = 'f'`,
      )
      expect(references).toEqual([])
    })

    it('refuses anything that is not a sha256 digest', async () => {
      await expectRejection(
        () => db.insert(banMarks).values({ kind: 'mailbox', hash: 'agent@example.invalid' }),
        /ban_marks_hash_shape/,
      )
    })

    /**
     * Two citizens sharing one banned identifier is exactly the case this table
     * exists to catch, so the second erasure must not fail on it — `#91` writes
     * these with `on conflict do nothing`, and this is the constraint that makes
     * that necessary rather than defensive.
     */
    it('holds one mark per identifier and kind', async () => {
      const hash = 'b'.repeat(64)
      await db.insert(banMarks).values({ kind: 'mailbox', hash })

      await expectRejection(
        () => db.insert(banMarks).values({ kind: 'mailbox', hash }),
        /ban_marks_kind_hash_unique/,
      )

      // The same digest under another kind is a different identifier, and must
      // not collide. `banMarkHash` folds the kind into the digest so this cannot
      // happen in practice; the index must not assume it.
      await db.insert(banMarks).values({ kind: 'github', hash })
      expect(await countIn('ban_marks')).toBe(2)
    })

    /**
     * An erasure survives its citizen by definition, so nothing may connect the
     * two. This walks the constraint catalogue rather than reading the schema
     * file, because the file is what a future change would edit.
     */
    it('is unreachable from `agents` in the foreign-key graph', async () => {
      const reaching = await db.execute<{ table_name: string }>(
        sql`select distinct conrelid::regclass::text as table_name from pg_constraint
             where contype = 'f' and confrelid = 'agents'::regclass`,
      )
      const names = reaching.map((r) => r.table_name)
      expect(names).not.toContain('erasures')
      expect(names).not.toContain('ban_marks')
    })
  })

  /**
   * The catalogue test. Every foreign key pointing at `agents`, with the rule it
   * carries — asserted as a whole list rather than one row at a time, so a table
   * added later shows up here as a failure with its name in it rather than as a
   * silent omission.
   *
   * `a` is `no action`, `r` is `restrict`, `c` is `cascade`, `n` is `set null`.
   */
  it('carries the delete rule the boundary requires, on every reference to an agent', async () => {
    const rules = await db.execute<{ table_name: string; column_name: string; rule: string }>(
      sql`select conrelid::regclass::text as table_name,
                 a.attname                as column_name,
                 confdeltype              as rule
            from pg_constraint c
            join unnest(c.conkey) as k(attnum) on true
            join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
           where c.contype = 'f' and c.confrelid = 'agents'::regclass`,
    )

    // Sorted here rather than in SQL: `order by` follows the server's collation,
    // which puts `tasks` before `task_struggles` on one machine and after it on
    // another. A test that fails on somebody else's Postgres teaches nothing.
    const carried = rules.map((r) => `${r.table_name}.${r.column_name} ${r.rule}`).sort()

    expect(carried).toEqual([
      'agent_skills.agent_id c',
      // #98. Cascades, and it is the one row here whose contents nobody —
      // including the Colony — could inspect to discover it had been left
      // behind. Ciphertext outliving the citizen it belonged to would be a
      // leftover in the exact sense `erasure.md` §4 rules out.
      'agent_vault.agent_id c',
      'browser_challenges.agent_id c',
      'credentials.agent_id c',
      'email_challenges.agent_id c',
      // #92. It cascades so that an abandoned or successful erasure attempt
      // leaves no record that a particular citizen once considered leaving.
      'erasure_challenges.agent_id c',
      'github_challenges.agent_id c',
      // The image rung's specification (#60). Cascades like every other
      // challenge: it is a question the Colony put to *this* citizen, and it
      // means nothing once there is nobody it was put to.
      'image_challenges.agent_id c',
      'key_challenges.agent_id c',
      // The one reference that stays `restrict`, and the reason the rest are
      // safe: the balance is burned to zero first, or Postgres refuses.
      'ledger_entries.agent_id r',
      'pow_challenges.agent_id c',
      'reputation_events.agent_id c',
      'social_challenges.agent_id c',
      'solana_wallet_challenges.agent_id c',
      'submissions.agent_id c',
      'support_tickets.agent_id c',
      /**
       * `task_attempts` cascades (#108). An attempt is the record of something
       * the citizen personally tried, which is exactly what `ARCHITECTURE.md`
       * means by *"if the row is the citizen's, it cascades"* — and
       * `erasure.md` §2 already lists what a citizen proved among the things
       * that do not survive it. The statistics it feeds are aggregates; they
       * lose a row, not their meaning.
       */
      'task_attempts.agent_id c',
      'task_resets.agent_id c',
      'task_struggles.agent_id c',
      'task_tips.agent_id c',
      // The model for anything that outlives a citizen: the task stays, its
      // author is unset.
      'tasks.created_by n',
      'tip_feedback.agent_id c',
      'vision_challenges.agent_id c',
      'website_challenges.agent_id c',
    ])
  })
})
