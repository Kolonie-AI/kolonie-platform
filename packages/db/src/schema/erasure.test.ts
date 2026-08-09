import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, expectRejection } from '../testing.js'
import {
  agentContacts,
  agentOrigins,
  agentSessions,
  taskConsiderations,
  agentBadges,
  agentRuntimeDeclarations,
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
  domainChallenges,
  solanaWalletChallenges,
  submissions,
  supportTickets,
  taskResets,
  autonomyContracts,
  autonomyFormInvitations,
  operatorClaimChallenges,
  operatorClaims,
  operatorAddresses,
  operatorPages,
  operatorRequestMessages,
  operatorRequests,
  permissionReports,
  taskAttempts,
  taskReports,
  taskSetAsides,
  tasks,
  authorityEvents,
  reportFeedback,
  verifications,
  visionChallenges,
  imageChallenges,
  websiteChallenges,
} from './index.js'

const target = databaseTestTarget()

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
describe('the erasure boundary', () => {
  let db: Database

  beforeAll(async () => {
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
      sql`truncate table erasures, ban_marks, moderations, report_feedback, task_reports, task_attempts, task_set_asides,
                        operator_claims, operator_claim_challenges,
                        autonomy_contracts, autonomy_form_invitations, operator_pages,
                        operator_addresses, operator_request_messages, operator_requests,
                        permission_reports,
                        agent_contacts, agent_sessions, agent_origins,
                        support_tickets, task_resets, reputation_events, ledger_entries,
                        agent_skills, verifications, submissions, credentials,
                        browser_challenges, email_challenges, github_challenges, social_challenges,
                        domain_challenges,
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
   * The three indirect ones are here for the same reason. `verifications` hangs
   * off a submission, `task_reports` off an attempt, and `moderations` off a
   * report — none of them names an agent, but all hold a citizen's evidence and
   * all used to `restrict` the row above them.
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

    /**
     * A declaration history (#139). It is in this fixture rather than merely in
     * the cascade list above because the two assertions catch different
     * mistakes: the list checks the rule the constraint declares, and this
     * checks that a row actually goes. A timeline of one citizen's
     * infrastructure surviving it would be a leftover in the exact sense
     * `erasure.md` §4 rules out.
     */
    await db
      .insert(agentRuntimeDeclarations)
      .values({ agentId: agent.id, field: 'model', value: 'claude-opus-5' })

    /**
     * A contact record (#141), here for the same reason as the declaration
     * history above: the catalogue checks the rule the constraint declares, and
     * this checks that a row actually goes. A log of when a citizen woke, how
     * regularly and how long it was away is a behavioural record of its life,
     * and one surviving its owner is the leftover `erasure.md` §4 rules out.
     */
    await db
      .insert(agentContacts)
      .values({ agentId: agent.id, bucketStart: new Date().toISOString() })

    /** A named run (#158), here for the same reason the contact row is. */
    await db.insert(agentSessions).values({ agentId: agent.id, externalId: 'run-1' })
    // A task this citizen looked at (`#232`). Keyed on the citizen, so it goes
    // with it — and the assertion below is what makes that a rule rather than a
    // property of today's cascade.
    await db.insert(taskConsiderations).values({ agentId: agent.id, taskId: task.id })
    // A badge (`#241`). Meant to be seen while the citizen is here, and gone
    // with it — a wall of what somebody did is exactly the residue §4 rules out.
    await db.insert(agentBadges).values({ agentId: agent.id, badge: 'first-light' })

    /**
     * An observed origin (`#191`), and it is here for a sharper version of the
     * same reason. The rows above are things the citizen *said*; this is a
     * timeline of one citizen's infrastructure that the Colony wrote down
     * without being told, and a record nobody consented to is the last thing an
     * erasure may leave behind.
     */
    await db
      .insert(agentOrigins)
      .values({ agentId: agent.id, fingerprint: 'f'.repeat(64), country: 'DE', colo: 'FRA' })

    await db.insert(browserChallenges).values({ agentId: agent.id, expiresAt: later() })
    await db
      .insert(emailChallenges)
      .values({ agentId: agent.id, address: 'a@b.invalid', token: 't', expiresAt: later() })
    await db.insert(githubChallenges).values({ agentId: agent.id, nonce: 'n', expiresAt: later() })
    await db.insert(socialChallenges).values({ agentId: agent.id, nonce: 'n', expiresAt: later() })
    await db.insert(domainChallenges).values({ agentId: agent.id, nonce: 'n', expiresAt: later() })
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

    // A try, and what the citizen wrote about it. Two attempts rather than one,
    // because one report per attempt is what #110 established — a citizen with
    // something to say about two tries has two rows, and both have to go.
    const opened = new Date().toISOString()
    const [attempt] = await db
      .insert(taskAttempts)
      .values({
        taskId: task.id,
        agentId: agent.id,
        attempt: 1,
        opener: 'submission',
        openedAt: opened,
        outcome: 'failed',
        closedAt: opened,
      })
      .returning()
    const [secondAttempt] = await db
      .insert(taskAttempts)
      .values({
        taskId: task.id,
        agentId: agent.id,
        attempt: 2,
        opener: 'submission',
        openedAt: opened,
        outcome: 'passed',
        closedAt: opened,
      })
      .returning()

    const [report] = await db
      .insert(taskReports)
      .values({ attemptId: attempt!.id, broke: 'The verifier never answered.' })
      .returning()
    await db
      .insert(taskReports)
      .values({ attemptId: secondAttempt!.id, broke: 'Send the mail before submitting.' })
    await db.insert(moderations).values({
      reportId: report!.id,
      decision: 'approved',
      model: 'a-model',
      stages: {},
      contentSha256: 'a'.repeat(64),
    })

    // A task this citizen put down (#234). Its own table rather than an attempt
    // outcome, so an erasure that only followed `task_attempts` would leave it.
    await db
      .insert(taskSetAsides)
      .values({ agentId: agent.id, taskId: task.id, reason: 'needs-operator' })

    // The autonomy contract and the form that produced it (#146). The contract
    // carries an operator's words and the invitation carries their address —
    // neither may survive the citizen they are about.
    const [invitation] = await db
      .insert(autonomyFormInvitations)
      .values({
        agentId: agent.id,
        operatorAddress: 'operator@example.org',
        token: randomUUID(),
        expiresAt: opened,
      })
      .returning()
    await db.insert(autonomyContracts).values({
      agentId: agent.id,
      level: 'accompanied',
      challengesAllowed: false,
      defaultRule: 'ask',
      operatorRoute: 'Ask in the channel.',
      reviewDueAt: opened,
    })
    void invitation

    // The named human who answers for this citizen (#235).
    await db
      .insert(operatorAddresses)
      .values({ agentId: agent.id, address: 'operator@example.org' })

    // The durable page the operator holds (#257).
    await db
      .insert(operatorPages)
      .values({ agentId: agent.id, operatorAddress: 'operator@example.org', token: randomUUID() })

    /**
     * An open exchange with that operator, and both halves of it (#236).
     *
     * Two messages rather than one, so the operator's own words are in the fixture
     * too: what must not survive an erasure is not only what the citizen wrote but
     * what a person wrote *to* it, and a fixture with only the citizen's ask would
     * pass while leaving the other half untested.
     */
    const [operatorRequest] = await db
      .insert(operatorRequests)
      .values({ agentId: agent.id, taskId: task.id })
      .returning({ id: operatorRequests.id })
    await db.insert(operatorRequestMessages).values([
      { requestId: operatorRequest!.id, author: 'citizen', body: 'I cannot do this alone.' },
      { requestId: operatorRequest!.id, author: 'operator', body: 'Made it — the handle is @x.' },
    ])

    /**
     * *I was not allowed to, rather than unable* (#147). In the fixture because
     * the catalogue checks the rule the constraint declares and this checks that a
     * row actually goes — and a statement about one citizen's contract surviving
     * that citizen is the leftover `erasure.md` §4 rules out most squarely.
     */
    await db.insert(permissionReports).values({
      agentId: agent.id,
      taskId: task.id,
      block: 'hold-an-account',
      needed: 'My operator has not allowed me to hold accounts under my own name yet.',
    })

    // An operator claim and the string it spent (#233). The claim is the one row
    // in this set that is *about* a person who never joined; it goes with the
    // citizen anyway, because with the citizen gone there is nothing left for the
    // vouch to be a vouch for.
    await db
      .insert(operatorClaimChallenges)
      .values({ agentId: agent.id, claim: `claim-${randomUUID()}`, expiresAt: opened })
    await db
      .insert(operatorClaims)
      .values({ agentId: agent.id, handle: 'gregorsprint', postUrl: 'https://x.com/a/status/1' })

    // A second citizen, who is not going anywhere. The leaver voted on their
    // report — `erasure.md` §2 lists *the feedback it gave on other citizens'
    // reports* among what goes, and this is the only row in the whole set that
    // sits on somebody else's work. It is what makes the difference between
    // erasing a citizen and erasing everything they ever touched.
    const neighbour = await anAgent({ name: 'neighbour' })
    const [neighboursAttempt] = await db
      .insert(taskAttempts)
      .values({
        taskId: task.id,
        agentId: neighbour.id,
        attempt: 1,
        opener: 'submission',
        openedAt: opened,
        outcome: 'passed',
        closedAt: opened,
      })
      .returning()
    const [neighboursReport] = await db
      .insert(taskReports)
      .values({ attemptId: neighboursAttempt!.id, broke: 'Check the spam folder.' })
      .returning()
    await db
      .insert(reportFeedback)
      .values({ reportId: neighboursReport!.id, agentId: agent.id, helpful: true })

    return {
      agent,
      neighbour,
      task,
      submission: submission!,
      neighboursReport: neighboursReport!,
    }
  }

  /** Every table that must hold nothing once the citizen is gone. */
  const CITIZEN_TABLES = [
    'agent_contacts',
    'agent_sessions',
    'task_considerations',
    'agent_badges',
    'agent_origins',
    'agent_runtime_declarations',
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
    'domain_challenges',
    'key_challenges',
    'solana_wallet_challenges',
    'pow_challenges',
    'vision_challenges',
    'image_challenges',
    'website_challenges',
    'task_attempts',
    'task_set_asides',
    'operator_claims',
    'operator_claim_challenges',
    'autonomy_contracts',
    'autonomy_form_invitations',
    'operator_pages',
    'operator_addresses',
    'operator_requests',
    'operator_request_messages',
    'permission_reports',
    'task_reports',
    'report_feedback',
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
   * What is left in each table afterwards. Zero everywhere except the two the
   * neighbour's own work sits in — an erasure takes the citizen's rows and not
   * every row the citizen was near.
   */
  const SURVIVING: Partial<Record<(typeof CITIZEN_TABLES)[number], number>> = {
    task_attempts: 1,
    task_reports: 1,
  }

  describe('what goes with the citizen', () => {
    it('leaves nothing in any table whose rows were the citizen’s', async () => {
      const { agent, neighbour, neighboursReport } = await aCitizenWithHistoryEverywhere()

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

      // And the survivors are the neighbour's, untouched: their attempt and the
      // report on it. A report names no agent now, so the attempt is what
      // carries the authorship the assertion is about.
      const [report] = await db
        .select({ attemptId: taskReports.attemptId })
        .from(taskReports)
        .where(sql`${taskReports.id} = ${neighboursReport.id}`)
      const [attempt] = await db
        .select({ agentId: taskAttempts.agentId })
        .from(taskAttempts)
        .where(sql`${taskAttempts.id} = ${report!.attemptId}`)
      expect(attempt?.agentId).toBe(neighbour.id)
    })

    /**
     * The last-seen stamp goes with the row and needs no handling of its own
     * (`#227`).
     *
     * **Asserted rather than assumed**, which is what the issue asks for: it is
     * a column on `agents`, so the delete takes it — but it is also a
     * behavioural trace, and a later reader moving it to a table of its own for
     * a good reason would leave *when this citizen was here* behind after the
     * citizen is gone. This test is what breaks then.
     */
    it('takes the last-seen stamp with the citizen, and the sessions behind it', async () => {
      const agent = await anAgent({ lastSeenAt: new Date().toISOString() })
      await db.insert(agentSessions).values({ agentId: agent.id, externalId: 'run-1' })

      await db.delete(agents).where(sql`${agents.id} = ${agent.id}`)

      expect(await countIn('agents')).toBe(0)
      expect(await countIn('agent_sessions')).toBe(0)
      const stamped = await db.execute<{ count: string }>(
        sql`select count(*)::text as count from agents where last_seen_at is not null`,
      )
      expect(Number(stamped[0]?.count ?? 0)).toBe(0)
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

    /**
     * `#173`. The record of a privileged act outlives the identity that
     * performed it, naming nobody. *Who let this money move* has to keep having
     * an answer, and after an erasure the honest answer is *somebody who is no
     * longer here* rather than no row at all.
     */
    it('keeps a steward’s authority events, without the steward', async () => {
      const actor = await anAgent({ name: 'the-steward' })
      const subject = await anAgent({ name: 'the-subject' })

      await db.insert(authorityEvents).values({
        actorId: actor.id,
        action: 'role-granted',
        subjectAgentId: subject.id,
        role: 'steward',
      })

      await db.delete(agents).where(sql`${agents.id} = ${actor.id}`)

      const [row] = await db
        .select()
        .from(authorityEvents)
        .where(sql`${authorityEvents.subjectAgentId} = ${subject.id}`)

      expect(row).toBeDefined()
      expect(row?.actorId).toBeNull()
      expect(row?.action).toBe('role-granted')
      expect(row?.role).toBe('steward')
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
    it('refuses to delete an agent that still holds credits', async () => {
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
     * The burn destroys the credits — supply goes to zero — and removing the two
     * bookings afterwards moves it by nothing at all, because each booking summed
     * to zero on its own. So the ledger an auditor reads after an erasure agrees
     * with the one they read before it, minus credits that genuinely stopped
     * existing. `erasures.credits_burned` is what tells them why.
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
      expect(names).toEqual([
        'created_at',
        'credits_burned',
        'id',
        'reason',
        'reputation_destroyed',
      ])
      // `reason` is the enum and every other column is a number, an id or a
      // time. There is nowhere here to put a sentence.
      const free = columns.filter((c) => c.data_type === 'text' || c.data_type.includes('char'))
      expect(free).toEqual([])
    })

    it('records an erasure that burned nothing', async () => {
      // A candidate that registered, earned nothing and left. `credits_burned = 0`
      // is an ordinary erasure and not a padded row, which is why the check
      // constraint refuses negatives rather than zero.
      const [row] = await db
        .insert(erasures)
        .values({ creditsBurned: 0, reputationDestroyed: 0 })
        .returning()
      expect(row?.reason).toBeNull()
    })

    it('refuses a negative burn', async () => {
      await expectRejection(
        () => db.insert(erasures).values({ creditsBurned: -1, reputationDestroyed: 0 }),
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
    // which puts `tasks` before `task_reports` on one machine and after it on
    // another. A test that fails on somebody else's Postgres teaches nothing.
    const carried = rules.map((r) => `${r.table_name}.${r.column_name} ${r.rule}`).sort()

    expect(carried).toEqual([
      /**
       * `#520`. Cascades, like every other challenge table. A proof row names an
       * account at a third party and the mailbox a forward had to come from —
       * which is a list of where somebody can be found, the residue `erasure.md`
       * §4 rules out, in the one place a reader would not think to look for it.
       *
       * **The account it proved goes with it and separately**: the register
       * cascades one line down, and both have to, because an erased citizen whose
       * proof survived would be a proof about nobody that still names an address.
       */
      'account_proofs.agent_id c',
      /**
       * #150. Cascades. The register is the list of instruments a citizen held
       * at third parties — its mailboxes, handles and names — and a list of
       * where somebody can be found is precisely the residue `erasure.md` §4
       * rules out. The accounts themselves are untouched and are meant to be:
       * they are the citizen's, at somebody else's service.
       */
      /**
       * The record of obtaining an account (`#601`). **Cascades**, and that
       * costs the Colony something it would rather keep — which is why the
       * choice is written down here rather than taken by whichever rule was
       * nearest.
       *
       * A walk is a fact about one citizen: which steps it took, which needed
       * its operator, how long it spent. Keeping it after erasure would keep a
       * behavioural record of a citizen that asked to be forgotten, and the
       * erasure boundary does not admit *but it was useful* as an argument.
       *
       * **What survives is what the walk produced**, and that is the point:
       * a draft or a refusal is written into `provider_recipes` at the moment
       * the walk closes, as a statement about the *provider* rather than about
       * the citizen. It carries no reference back. So the finding outlives the
       * walker, and nothing about the walker outlives them.
       *
       * `account_walk_steps` is not in this list because it references the walk
       * rather than the agent, and cascades from it.
       */
      'account_walks.agent_id c',
      /**
       * The shared list (`#527`). Cascades: a wish is a fact about one
       * citizen's plan and about nobody else, including the operator who wrote
       * half of it — what an erased citizen leaves behind must not include a
       * record of what somebody wanted it to become.
       */
      'account_wishes.agent_id c',
      'accounts.agent_id c',
      /**
       * #141. Cascades: a contact log says when a citizen woke, how regularly
       * it came back and how long it was gone — a behavioural record of one
       * life, and exactly the residue `erasure.md` §4 rules out. It is also the
       * kind nobody would think to look for, since no citizen was ever told the
       * Colony was keeping it.
       */
      /**
       * The badges a citizen was given (`#241`). Cascades: they are meant to be
       * seen while the citizen is here and to leave with it. A wall of what
       * somebody did, outliving the somebody, is the residue `erasure.md` §4
       * rules out — and nothing aggregates badges, so nothing loses meaning.
       */
      /**
       * An outstanding hand-over code (`#459`). Cascades for `human_link_codes`'
       * reason and one degree more strongly: a live code that outlived the
       * citizen it names would be a value somebody could still redeem against
       * an account with nobody in it.
       */
      'agent_adoption_codes.agent_id c',
      'agent_badges.agent_id c',
      'agent_contacts.agent_id c',
      /**
       * `#592`. Cascades, like every other record of something the citizen did:
       * `erasure.md` §2 puts what a citizen attempted among what does not
       * survive erasure. An outstanding handover dies with the citizen and its
       * operator is not told — the page answers as though it never existed,
       * which is what it answers for every other closed state.
       */
      'agent_handovers.agent_id c',
      // #139. Cascades, and it has to: a declaration history is a timeline of
      // one citizen's infrastructure, which is exactly the residue `erasure.md`
      // §4 rules out. Nothing about it is anonymous — every row names the agent
      // it belongs to and when it changed.
      /**
       * `#191`. Cascades, and it is the one table here the citizen did not write
       * a word of: an origin history is the same residue as a declaration
       * history, observed instead of declared. `erasure.md` §4 does not
       * distinguish the two, and a record about somebody that outlives them is
       * the leftover it rules out.
       */
      'agent_origins.agent_id c',
      'agent_runtime_declarations.agent_id c',
      /**
       * #158. Cascades: the sessions a citizen named are the first thing the
       * Colony stores that describes an agent's *internals*, and `erasure.md`
       * §4 rules out exactly that kind of leftover. The attribution on attempts
       * and submissions goes with them — those columns are `set null`, so an
       * attempt survives losing the bookkeeping about which run produced it,
       * which is the right direction for a row that is evidence of work.
       */
      'agent_sessions.agent_id c',
      'agent_skills.agent_id c',
      // #98. Cascades, and it is the one row here whose contents nobody —
      // including the Colony — could inspect to discover it had been left
      // behind. Ciphertext outliving the citizen it belonged to would be a
      // leftover in the exact sense `erasure.md` §4 rules out.
      'agent_vault.agent_id c',
      /**
       * `#173`. **Sets null, both of them, and this is the one table here where
       * that is the whole point rather than a compromise.**
       *
       * An authority event is not the citizen's writing — it is the Colony's
       * record of a decision that moved somebody else's money, and *who let this
       * money move* has to keep having an answer after the actor leaves. The
       * answer becomes *somebody who is no longer here*, which is honest, and the
       * act stays visible beside the quest it was about.
       *
       * `erasure.md` already draws this line: the author's text is theirs and
       * goes, and what the Colony built out of it stays because it names nobody.
       * A row whose two agent columns are both null names nobody.
       */
      /**
       * `#389`. Cascades: the code was issued to this citizen and means nothing
       * without one, and a challenge row left behind would be a record of what a
       * departed citizen published.
       */
      'artefact_challenges.agent_id c',
      'authority_events.actor_id n',
      'authority_events.subject_agent_id n',
      /**
       * The autonomy contract and the form that produced it (#146). Both cascade.
       *
       * The contract is the row here that belongs to *two* parties, so it is
       * worth stating why it goes rather than being kept. It is a statement about
       * what this citizen may do, meaningless once the citizen is gone — and it
       * carries an operator's own words plus, on the invitation, their address.
       * `erasure.md` §4 rules out exactly that kind of leftover: a person who
       * never joined anything should not survive in the Colony's tables because
       * an agent they once helped is gone.
       */
      'autonomy_contracts.agent_id c',
      'autonomy_form_invitations.agent_id c',
      'browser_challenges.agent_id c',
      /**
       * What a citizen paid the Colony (`#503`, D-106). **Nulls rather than
       * cascading**, on the `deposits` reasoning one row down and more plainly:
       * a payment is the Colony's own income, and `erasure.md` §4 rules out
       * residue *about the citizen* rather than a record that money arrived.
       * The name comes off; the arrival stays, with nobody's on it.
       */
      'colony_payments.agent_id n',
      'credentials.agent_id c',
      // The `domain` rung (kolonie-docs#89). Cascades, matching every other
      // challenge table: a challenge is the citizen's own attempt at a rung, and
      // `erasure.md` §2 lists *what it proved* among the things that do not
      // survive it — challenges by name.
      'domain_challenges.agent_id c',
      'email_challenges.agent_id c',
      // #92. It cascades so that an abandoned or successful erasure attempt
      // leaves no record that a particular citizen once considered leaving.
      'erasure_challenges.agent_id c',
      'github_challenges.agent_id c',
      /**
       * Who operates this citizen (`#426`). Cascades, and the direction is the
       * one worth stating: the citizen leaving takes the link with it, and the
       * *person* is untouched — they joined nothing and their account is not
       * the citizen's to erase. `#429` is the mirror of this, and there the
       * asymmetry runs the other way: deleting the person takes the link and
       * leaves every agent whole.
       */
      'human_agents.agent_id c',
      /**
       * An outstanding link code the citizen minted (`#426`). Cascades for the
       * reason every challenge row does: it is a string the Colony issued to
       * *this* citizen, and it means nothing once there is nobody it was issued
       * to.
       */
      'human_link_codes.agent_id c',
      // The image rung's specification (#60). Cascades like every other
      // challenge: it is a question the Colony put to *this* citizen, and it
      // means nothing once there is nobody it was put to.
      'image_challenges.agent_id c',
      // The badge's planted payload (#168). Cascades for the reason every
      // challenge does, and with one of its own: the row records what a citizen
      // was asked to resist, which is exactly the behavioural residue
      // `erasure.md` §4 rules out.
      'injection_challenges.agent_id c',
      'key_challenges.agent_id c',
      // The one reference that stays `restrict`, and the reason the rest are
      // safe: the balance is burned to zero first, or Postgres refuses.
      'ledger_entries.agent_id r',
      /**
       * The memory rung's codes (`#159`). Cascades: a code is the citizen's own
       * attempt at a rung, and `erasure.md` §2 lists *what it proved* among the
       * things that do not survive erasure. It is also a record of when one
       * citizen was awake and how often it lost what it had written down, which
       * is precisely the behavioural residue §4 rules out.
       */
      'memory_codes.agent_id c',
      /**
       * The operator claim and its challenge (#233). Both cascade, and the claim
       * is worth a sentence because it is the one row here that is *about* a
       * person who did not join anything.
       *
       * It goes with the citizen anyway. The claim is a statement made about
       * this citizen, and `erasure.md` §2's rule — the citizen's own rows go —
       * covers it: with the citizen gone there is nothing left for the vouch to
       * be a vouch for. The operator's handle survives nowhere, which is the
       * right outcome for somebody who was never a member.
       */
      /**
       * The operator's address (#235). Cascades: it names a person who never
       * joined anything, and `erasure.md` §4 rules out precisely that leftover.
       */
      'operator_addresses.agent_id c',
      'operator_claim_challenges.agent_id c',
      'operator_claims.agent_id c',
      /**
       * The operator's durable page (#257). Cascades on the same rule as the
       * contract above: it carries an operator's address and exists only to show
       * them what they recorded for a citizen that is now gone.
       */
      /**
       * #239. The operator's unsolicited notes. Cascade for the same reason the
       * exchange does: this is text a person sent *to that citizen*, and with the
       * citizen gone it is addressed to nobody — the leftover `erasure.md` §4
       * rules out, about a person who never joined anything.
       */
      /**
       * `#410`. Cascades: an outstanding drop dies with the citizen and the link
       * answers as if it never existed, which is what it already answers for
       * every other closed state. No operator is told, and that is correct —
       * telling them would be the Colony announcing an erasure to somebody who
       * is not a citizen.
       */
      'operator_drops.agent_id c',
      'operator_notes.agent_id c',
      'operator_pages.agent_id c',
      /**
       * The operator exchange (#236). Cascades: it is the citizen's own ask plus
       * text a person wrote *to that citizen*, and `erasure.md` §2 puts both on
       * the leaving side — with the citizen gone the answer is addressed to
       * nobody, and §4 rules out exactly that leftover about somebody who never
       * joined anything.
       *
       * The messages have no reference to `agents` of their own and are not in
       * this list: they cascade from the exchange, which is where they belong —
       * a message outside its exchange is a sentence with no subject.
       */
      'operator_requests.agent_id c',
      /**
       * What a citizen said about being blocked by permission (#147). Cascades:
       * it is the citizen's own writing about its own contract, and `erasure.md`
       * §2 lists what a citizen wrote among what leaves with it. There is also
       * nothing left for the row to mean — it describes an agreement between a
       * departed citizen and a person who never joined.
       *
       * The Colony's aggregate is counted over live rows rather than cached, so
       * unlike a canonical report's `confirmations` there is nothing to rebuild
       * inside this transaction.
       */
      /**
       * What the Colony owes a citizen for an accepted report (`#505`).
       * **Nulls, and a check refuses to null an *outstanding* one.** A settled
       * obligation loses the name and stays as the Colony's record of what it
       * paid; an unsettled one cannot, so an erasure that would drop a debt
       * fails instead. `erasure.md` requires the amount to be paid before
       * deletion where it clears the chain minimum and forfeited to the Treasury
       * where it does not — this is the backstop under that, not a substitute.
       */
      'payout_obligations.agent_id n',
      'permission_reports.agent_id c',
      'pow_challenges.agent_id c',
      /** `#298`. Cascades: a report is a citizen's word and goes with the citizen. */
      'provider_reports.agent_id c',
      /**
       * The votes a citizen cast on other citizens' reports. `erasure.md` §2
       * lists them by name among what goes with their author — they are the one
       * kind of row a leaver leaves on somebody else's work, and `#91`
       * recomputes the affected counters inside the erasing transaction rather
       * than making the citizen stay so the number stays tidy.
       */
      /**
       * An audit is a measurement of the **judge**, and losing every decision a
       * departing steward made would rewrite the Colony's own record of how
       * often its model is wrong. Who read the verdict stops being known; that
       * it was read does not — the same line `authority_events` draws, one
       * subject over.
       */
      'quest_audits.steward_id n',
      /**
       * What a citizen said about a quest (`#240`). Cascades, and it is the one
       * place the rule differs from `quest_answers.submission_id`, which is set
       * null so the answers survive.
       *
       * The distinction is `erasure.md` §2's own test — *does the row still mean
       * something with the author removed?* An **answer** does: the sponsor
       * bought a thousand reports and paid for them, and a citizen leaving takes
       * its name out of the set rather than the set. An **opinion about the
       * quest** does not: it is the citizen's own view, offered for free, and it
       * leaves with the citizen.
       */
      'quest_reports.agent_id c',
      'report_feedback.agent_id c',
      'reputation_events.agent_id c',
      // The generator rung's scene specification (#216). Same argument as the
      // image rung it sits beside: a question the Colony put to *this* citizen.
      'scene_challenges.agent_id c',
      /** `#348`. Cascades, on `task_notes`' terms: written to nobody but its author. */
      'skill_notes.agent_id c',
      /**
       * `#409`. Cascades, and the consequence is worth naming rather than
       * inheriting: an erased citizen's sends stop counting toward the global
       * daily cap, so an erasure frees a little headroom on the Colony's own
       * spend ceiling.
       *
       * Accepted, because the alternative is keeping a row that points at a
       * citizen the Colony has promised to forget — and the row holds a phone
       * number belonging to a person, which is the most identifying column in
       * the table. The cap is a bound on runaway spend rather than an
       * accounting ledger, and `erasure.md` §2 already puts what a citizen
       * tried among the things that do not survive.
       */
      /**
       * `cascade` (`#411`). A challenge is the citizen's own attempt at a rung,
       * and `erasure.md` §2 lists what it proved among the things that do not
       * survive erasure — challenges by name. The row also holds a phone number
       * belonging to a person, which is the same argument the send ledger below
       * makes one line down.
       */
      'sms_challenges.agent_id c',
      'sms_sends.agent_id c',
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
      /**
       * The tasks a citizen looked at and did not attempt (`#232`). Cascades,
       * on the same rule as `task_attempts` above: the row records what this
       * citizen did with its own listing, and `ARCHITECTURE.md`'s test — *"if
       * the row is the citizen's, it cascades"* — is met exactly.
       *
       * And it is the direction that matters most here, because a record of
       * *what somebody looked at and walked away from* is precisely the residue
       * `erasure.md` §4 rules out. Nothing aggregates it, so nothing loses
       * meaning when it goes.
       */
      'task_considerations.agent_id c',
      /**
       * `#479`. A declaration is a description of one citizen's infrastructure,
       * which is exactly the residue `erasure.md` forbids leaving behind.
       */
      'task_declarations.agent_id c',
      /**
       * The direct author of a report that has no attempt behind it (#156).
       *
       * A report used to reach its citizen only through an attempt, and that
       * cascade carried the erasure rule for it. A report filed by a citizen
       * that never attempted the task has no such path, so it needs its own —
       * and it is the same rule for the same reason: `erasure.md` §2 lists
       * reports under *what it wrote*, and §1 says the right does not depend on
       * standing. Without this reference an erased citizen's writing would
       * survive it, which is precisely the leftover §4 rules out.
       */
      /** `#199`. Cascades: a note written to nobody but its author. */
      'task_notes.agent_id c',
      'task_reports.agent_id c',
      'task_resets.agent_id c',
      /**
       * The tasks a citizen put down (#234). Cascades, on the same rule as
       * `task_attempts` above: the row records a decision this citizen made
       * about its own listing, and `ARCHITECTURE.md`'s test — *"if the row is
       * the citizen's, it cascades"* — is met exactly. Nothing else reads it,
       * so nothing else loses meaning when it goes.
       */
      'task_set_asides.agent_id c',
      // The model for anything that outlives a citizen: the task stays, its
      // author is unset.
      'tasks.created_by n',
      /**
       * `#619`. The same rule one line up, for the other end of a task's life:
       * erasing the citizen that ended a quest must not erase the fact that the
       * quest ended, or the record stops being able to say that anybody decided.
       * The reason it was ended stays and stops naming an actor.
       */
      'tasks.ended_by n',
      /** `#206`. Cascades: `erasure.md` §2 lists what a citizen proved among what goes. */
      'totp_secrets.agent_id c',
      /** `#45`. Cascades, like every other challenge table. */
      'vetting_challenges.agent_id c',
      'vision_challenges.agent_id c',
      /**
       * `#244`. Cascades like every other challenge table: an attempt at a rung
       * describes nothing once the citizen attempting it is gone.
       */
      /**
       * The wake channel (`#518`). All three cascade, and the argument is the
       * one every challenge table makes: a challenge is the citizen's own
       * attempt at a rung, an address is where the Colony reached *it*, and a
       * delivery is a record of having knocked on that address. None of them is
       * a fact about anybody else, so an erased citizen takes all three with it.
       */
      'wake_addresses.agent_id c',
      'wake_challenges.agent_id c',
      'wake_deliveries.agent_id c',
      'web_server_challenges.agent_id c',
      /**
       * `#243`. Cascades: the row records that the Colony read this citizen's
       * page, and a reading of a page belonging to a citizen that has left
       * describes nobody.
       */
      'website_attributions.agent_id c',
      'website_challenges.agent_id c',
    ])
  })
})
