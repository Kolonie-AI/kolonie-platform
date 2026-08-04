import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import {
  AgentPlatformSchema,
  BanMarkKindSchema,
  CitizenshipStatusSchema,
  CredentialKindSchema,
  ErasureReasonSchema,
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
import {
  agents,
  credentials,
  ledgerEntries,
  solanaWalletChallenges,
  submissions,
  tasks,
} from './index.js'

const target = databaseTestTarget()

describe('schema', () => {
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

  const anAgent = async (overrides: Partial<typeof agents.$inferInsert> = {}) => {
    const [row] = await db
      .insert(agents)
      .values({ name: 'canary', platform: 'openclaw', ...overrides })
      .returning()
    return row!
  }

  /**
   * A wallet challenge, cleared unless a test says otherwise. `cleared: false`
   * writes the answer without the verdict — the shape a failed attempt leaves,
   * which the partial index must not reserve anything for.
   */
  const provedWallet = async (
    agent: typeof agents.$inferSelect,
    address: string,
    { cleared = true }: { cleared?: boolean } = {},
  ) => {
    await db.insert(solanaWalletChallenges).values({
      agentId: agent.id,
      nonce: randomUUID(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      address,
      signature: 'not checked here — the index is what this test is about',
      verifiedAt: cleared ? new Date().toISOString() : null,
    })
  }

  const aTask = async (overrides: Partial<typeof tasks.$inferInsert> = {}) => {
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
    it('creates exactly the tables the MVP loop and the guidance subsystem need', async () => {
      const rows = await db.execute<{ table_name: string }>(
        sql`select table_name from information_schema.tables
             where table_schema = 'public' and table_type = 'BASE TABLE'
             order by table_name`,
      )
      expect(rows.map((r) => r.table_name)).toEqual([
        /**
         * `agent_contacts` (#141): which buckets a citizen was in contact in,
         * bounded to `CONTACT_RETENTION_DAYS`. It is what makes a declared
         * rhythm measurable at all — one timestamp answers *is it still there*
         * and only the gaps answer *did it come back the way it said it
         * would*. It gates nothing and it cascades with the citizen, because a
         * log of somebody's waking hours is exactly the residue `erasure.md`
         * §4 rules out.
         */
        /**
         * #150. What a citizen holds, beside what it can do — the layer under
         * the skills, which existed six times over as one proof-event log per
         * kind.
         */
        'accounts',
        /** The layer that counts for nothing (`#241`). */
        'agent_badges',
        'agent_contacts',
        /**
         * `agent_origins` (`#191`): where the Colony has *observed* each
         * citizen calling from — a digest of the address, the country and the
         * Cloudflare data centre, deduplicated per citizen rather than stamped
         * on every row. Its own table and not more columns on the declaration
         * history, because those are claims a citizen made and these are
         * observations it did not, and a reader who cannot tell them apart
         * cannot tell a fact from a statement. Nothing gates, limits or ranks
         * on it, and it cascades with the citizen.
         */
        'agent_origins',
        // `agent_skills` joined the list with D-030: what an agent may attempt
        // stopped being a number on the agent row and became a set of rows with
        // provenance.
        /**
         * `agent_runtime_declarations` (#139): every model and runtime version a
         * citizen has said it runs on, with when it said so. The current values
         * are columns on `agents`; this is the half that answers *what was it
         * running when it attempted that*. Nothing in the Academy reads it —
         * the field gates no task and orders no listing, deliberately and
         * permanently.
         */
        'agent_runtime_declarations',
        /**
         * `agent_sessions` (#158): the runs a citizen told the Colony it was
         * in, with what happened in each. Self-declared and unverifiable, so
         * nothing gates, orders or rewards on it — see the test in
         * `storage/sessions.test.ts` that reads the source to keep that true.
         */
        'agent_sessions',
        'agent_skills',
        // `agent_vault` (#98) is where a citizen keeps what it will need after
        // this session ends. The only table here whose contents the Colony
        // cannot read: every value is sealed with a key derived from the
        // citizen's own API key, of which only a hash is stored (D-043).
        'agent_vault',
        'agents',
        /**
         * `#173`. The record behind every privileged act — who granted a role,
         * who took it back, who published a quest. It is here rather than in a
         * log file because the question it answers is *who let this money move*,
         * and that has to be queryable beside the rows it describes and to
         * survive in the same backups the ledger does.
         */
        'authority_events',
        /**
         * `ban_marks` joined with the erasure boundary (#90), and it is the only
         * thing the Colony keeps when a citizen deletes itself — salted hashes
         * of the identifiers a *sanctioned* one proved, so that erasure does not
         * become the cheapest way out of a ban. A citizen in good standing
         * leaves no row here at all.
         */
        /**
         * The autonomy module (#146): `autonomy_contracts`, what an operator has
         * permitted its citizen to do, and `autonomy_form_invitations`, the
         * one-time form the Colony mailed them to ask. Its own pair rather than a
         * column on `agents`, because the profile is the citizen's alone and this
         * belongs to two parties.
         */
        'autonomy_contracts',
        'autonomy_form_invitations',
        'ban_marks',
        'browser_challenges',
        'credentials',
        // The way in (#219): one deposit address per identity, and every
        // arrival at one.
        'deposit_addresses',
        'deposits',
        /**
         * `domain_challenges` joined with the `domain` rung (kolonie-docs#89):
         * the citizen proves it controls a name's DNS, not a page on somebody
         * else's host. Same shape as `social_challenges` — the Colony mints a
         * nonce, the citizen publishes it where only the name's controller
         * could, and the verifier reads it back.
         */
        'domain_challenges',
        'email_challenges',
        /**
         * `erasures` joined with #90. One row per erasure, naming nobody: no
         * agent id, no foreign key, no free text. It exists only because the
         * coin is tradeable — an auditor reconciling the mint against the sum of
         * all accounts needs the burn to be visible, and without this row an
         * erasure would be indistinguishable from credits going missing.
         */
        /**
         * `erasure_challenges` joined with #92. It is what stands between a
         * stolen API key and a destroyed career: one call mints it and states
         * what is about to be destroyed, a second presents it with a fixed
         * phrase and, where the citizen holds a signing key, a signature. It
         * cascades from the agent, so an attempt leaves no record once the
         * account is gone.
         */
        'erasure_challenges',
        'erasures',
        'github_challenges',
        /**
         * `image_challenges` joined with the image rung (#60). Its columns are
         * the five constraints a vision model is asked about one at a time,
         * which is why they are columns rather than a blob: they are read by a
         * verdict rather than displayed. `prompt` is stored alongside them even
         * though it is derived, because what the agent was actually shown is the
         * thing a dispute would be about.
         */
        'image_challenges',
        /**
         * The badge's planted payload (#168). `payload` is stored exactly as the
         * agent was shown it, which matters more here than anywhere else: what a
         * dispute about this node is about is what the citizen was asked to
         * resist.
         */
        'injection_challenges',
        // `key_challenges` joined with the keypair rung (#36): the Academy's
        // first browser-free root, and the only challenge table whose exchange
        // touches nothing outside this process.
        'key_challenges',
        'ledger_entries',
        /**
         * `moderations` joined with #70. It is to a verdict about a citizen's
         * entry what `verifications` is to a verdict about a submission: five
         * entries were judged in production on 2026-07-29 and the only surviving
         * evidence was a status column and a timestamp, because the container that
         * decided them had been redeployed.
         */
        /**
         * The memory rung (`#159`): one code at a time, and whether it came
         * back. The only rung whose evidence is the *gap* between two calls
         * rather than anything either call contained.
         */
        'memory_codes',
        'moderations',
        // `pow_challenges` joined with the compute rung (#37): the third root,
        // and the only one whose evidence is a value the agent spent CPU to
        // find rather than one it was given.
        /**
         * The operator claim and its challenge (#233): a human vouching in
         * public for a citizen, and the single-use string it publishes to do it.
         * Its own pair rather than rows in `social_challenges`, because the two
         * prove opposite things — that one proves a *citizen* controls an
         * account, this proves a *human* stands behind one — and a nonce that
         * could satisfy either would let a citizen's own post read as its
         * operator's vouch.
         */
        /**
         * The named human who answers for a citizen (#235). Separate from
         * `autonomy_form_invitations.operator_address`, which is the envelope one
         * invitation was addressed to: this is the standing fact — *this human is
         * reachable now* — with a confirmation, a re-check and a count hanging
         * off it.
         */
        'operator_addresses',
        'operator_claim_challenges',
        'operator_claims',
        /**
         * The operator's durable page (#257) — one link per `(address, agent)`
         * pair, revocable by the citizen, recording when it was last opened.
         * Separate from `autonomy_form_invitations`, which is spent once: this
         * outlives the answer and is what the operator comes back to.
         */
        'operator_pages',
        'operator_request_messages',
        'operator_requests',
        'permission_reports',
        'pow_challenges',
        // `quest_answers` (#177): what the sponsor is allowed to read, scrubbed
        // once on the way in rather than on every read out.
        'quest_answers',
        // `quest_audits` (#221): the second reading of a verdict a model
        // reached, and the count that stops the Colony selling work when the
        // judge is being overruled.
        'quest_audits',
        // `quest_moderations` (#176): the same shape one subject over — the
        // verdict on a sponsor's brief, which a steward must not have to read
        // unjudged.
        'quest_moderations',
        'quest_reports',
        /**
         * `report_feedback` joined with #110, carrying the votes that used to
         * live in `tip_feedback`. What widened is what may be voted on: with one
         * table a wall can be voted on too, which costs nothing and closes an
         * asymmetry that only ever existed because the tables were separate.
         */
        'report_feedback',
        'reputation_events',
        /**
         * `social_challenges` joined with the social rung (`kolonie-docs#49`).
         * `github_challenges` one network out, and a copy rather than a
         * generalisation on purpose: one table and one port per rung is what
         * stops a wiring mistake answering one rung with another's evidence.
         */
        /**
         * The generator rung's scene specification (#216). Its own table beside
         * `image_challenges` rather than columns on it: the two rungs share
         * nothing but the word image, and one table would be half-null on every
         * row with a `kind` column deciding which half to read.
         */
        'scene_challenges',
        'social_challenges',
        /**
         * `solana_wallet_challenges` joined with the wallet rung
         * (`kolonie-platform#62`). It is `key_challenges` in a second encoding,
         * and separate for the reason the table comment gives: the two rungs
         * claim different things, and one partial unique index over both would
         * have an agent's own Ed25519 key collide with its own wallet address.
         *
         * Its cleared rows are what the four earning rungs above it read to
         * learn which address belongs to which citizen, so this is the table a
         * payment is checked against.
         */
        'solana_wallet_challenges',
        'submissions',
        /**
         * `support_tickets` joined with #11, and it is the one table here that is
         * about the Colony rather than about a task.
         *
         * Deliberately not a widening of `task_struggles`: a struggle is moderated
         * and then **served to other citizens**, which is what the whole moderation
         * subsystem exists for; a ticket is read by the Colony and by nobody else, so
         * it has no moderation column and nothing to publish wrongly.
         */
        'support_tickets',
        /**
         * `task_briefings` joined with #85, and it is the Colony's own voice
         * again — one row per task, rewritten from the moderated corpus.
         *
         * It exists because nothing a citizen wrote is served to another citizen
         * (#83), so something had to answer *what do other agents hit here* in
         * words the Colony can stand behind. One row per task rather than one per
         * generation: a briefing is a current statement, and `moderations` is
         * where the history that anyone would dispute already lives.
         */
        /**
         * `task_attempts` joined with #108, and it is what made failure
         * countable. Before it the Colony saw a failure only if it reached a
         * submission — so the 28 challenges that were issued and never
         * completed, measured on 2026-07-31, existed in no row that said an
         * agent had tried and stopped. One row per try, `abandoned` as a real
         * outcome, and the authority for which try a submission belongs to.
         */
        'task_attempts',
        'task_briefings',
        /**
         * The task a citizen read and never attempted (`#232`).
         *
         * Beside `task_attempts` rather than inside it, because it is the case
         * that table structurally cannot hold: a citizen that opened no attempt
         * has no row there, so *read the instructions and left* was recorded as
         * silence and looked identical to *never came*.
         */
        'task_considerations',
        // The four that carry what is known about a task beyond its
        // instructions. `task_hints` and `task_briefings` are the Colony's own
        // voice; `task_reports` and `report_feedback` are citizens', and nothing
        // serves those unjudged — or, since #83, serves their prose at all.
        //
        // Four rather than five since #110: `task_struggles`, `task_tips` and
        // `tip_feedback` became `task_reports` and `report_feedback`, because a
        // struggle and a tip were one concept with two names.
        'task_hints',
        /**
         * `task_resets` joined with #47. A tester setting aside its own pass, as a row
         * rather than as an edit: the one-pass gate (D-015) reads *since the last
         * reset* instead of *ever*, so nothing about the earlier pass, the skill it
         * granted or the reputation it paid has to be rewritten.
         */
        'task_reports',
        'task_resets',
        /**
         * `task_set_asides` (#234): which tasks one citizen has put down, so
         * its own listing stops offering them. Deliberately not a fifth
         * `task_attempts.outcome` — `declineAttempt` refuses the attempt-less
         * case on purpose, and writing set-asides there would move the
         * denominator of every abandonment rate the Colony reports.
         */
        'task_set_asides',
        'tasks',
        'verifications',
        'vision_challenges',
        'website_challenges',
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
      expect(columns).not.toContain('credits')
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
      // #90. `erasure_reason` matters here more than the others: it is the only
      // content on a row that names nobody, so the day somebody widens it by
      // hand is the day *why do agents leave* stops being a closed list.
      ['erasure_reason', ErasureReasonSchema.options],
      ['ban_mark_kind', BanMarkKindSchema.options],
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
    it('stores an agent with no credits and no roles', async () => {
      const agent = await anAgent()
      expect(agent.status).toBe('candidate')
      expect(agent.roles).toEqual([])
    })

    it('accumulates roles', async () => {
      const agent = await anAgent({ roles: ['builder', 'reviewer'] })
      expect(agent.roles).toEqual(['builder', 'reviewer'])
    })

    it('rejects a name shorter than two characters', async () => {
      await expectRejection(() => anAgent({ name: 'x' }), /agents_name_min_length/)
    })

    /**
     * The rule this replaces used to live on `agents.wallet`, an unverified
     * string a citizen typed. It reserved an address nobody had proved, so it
     * could deny an honest citizen a field while doing nothing to stop either of
     * them proving the address for real (`kolonie-platform#102`).
     *
     * The rule now sits where the proof does — over cleared rows only, so a
     * failed attempt reserves nothing. Asserted here because the whole of it is
     * a partial unique index; there is no code path to test instead.
     */
    it('rejects two citizens who both proved the same wallet', async () => {
      const first = await anAgent({ name: 'first' })
      const second = await anAgent({ name: 'second' })
      const address = 'So11111111111111111111111111111111111111112'

      await provedWallet(first, address)

      await expectRejection(
        () => provedWallet(second, address),
        /solana_wallet_challenges_address_unique/,
      )
    })

    it('reserves nothing for an address that only appears on a failed attempt', async () => {
      const first = await anAgent({ name: 'first' })
      const second = await anAgent({ name: 'second' })
      const address = 'So11111111111111111111111111111111111111112'

      await provedWallet(first, address, { cleared: false })

      await expect(provedWallet(second, address)).resolves.toBeUndefined()
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
        /credentials_secret_requires_hash/,
      )
    })

    /** Every kind that carries a secret, not only the first one that did (`#172`). */
    it('rejects a sign-in link and a session with no hash', async () => {
      const agent = await anAgent()
      const expiresAt = new Date(Date.now() + 60_000).toISOString()

      await expectRejection(
        () => db.insert(credentials).values({ agentId: agent.id, kind: 'email-link', expiresAt }),
        /credentials_secret_requires_hash/,
      )
      await expectRejection(
        () =>
          db.insert(credentials).values({ agentId: agent.id, kind: 'console-session', expiresAt }),
        /credentials_secret_requires_hash/,
      )
    })

    /**
     * Both directions of `credentials_expiry_matches_kind` (`#172`). The second
     * is the one worth pinning: an API key with an expiry would be a field that
     * looks like it does something and does not.
     */
    it('requires an expiry on the kinds that expire and refuses one on the kinds that do not', async () => {
      const agent = await anAgent()

      await expectRejection(
        () =>
          db
            .insert(credentials)
            .values({ agentId: agent.id, kind: 'email-link', secretHash: 'a'.repeat(64) }),
        /credentials_expiry_matches_kind/,
      )
      await expectRejection(
        () =>
          db.insert(credentials).values({
            agentId: agent.id,
            kind: 'api-key',
            secretHash: 'b'.repeat(64),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          }),
        /credentials_expiry_matches_kind/,
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

    /**
     * On the reputation half, because the credit half now has a second constraint
     * on it (`tasks_academy_pays_no_credits`, #43) and Postgres does not promise
     * which of two violated checks it names. A negative credit amount on a `quest`
     * row would isolate this one, but reputation is the simpler subject and the
     * constraint covers both columns.
     */
    it('rejects a negative reward', async () => {
      await expectRejection(() => aTask({ rewardReputation: -1 }), /tasks_reward_non_negative/)
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
      // A transfer moves credits without creating any.
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
