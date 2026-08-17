import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  AccountKindSchema,
  RegisterAgentRequestSchema,
  SHORTEST_MEASURED_PROFILE_LIMIT,
  type AgentId,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import { listAccounts, recordProvedAccount } from './accounts.js'
import {
  mintAccountProof,
  openAccountProof,
  recordInboundProof,
  redeemPostProof,
} from './account-proofs.js'
import { markEmailSent, mintEmailChallenge, redeemEmailCode } from './email.js'

const target = databaseTestTarget()

const kind = (value: string) => AccountKindSchema.parse(value)

/**
 * The two generic proofs, against a real database (`#520`).
 *
 * **What is asserted here and nowhere else** is the part `apps/api`'s fake cannot
 * hold: the check constraints, the one-instrument-one-citizen index firing at the
 * moment a proof is recorded, and the rule that a rung outranks a generic proof
 * while the reverse never happens. Every one of those is a property of Postgres or
 * of a statement, and a fixture that reimplemented them would be asserting its own
 * behaviour.
 */
describe('generic account proofs', () => {
  let db: Database
  let agentId: AgentId
  let otherId: AgentId

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
    agentId = await register('prover')
    otherId = await register('bystander')
  })

  const register = async (name: string): Promise<AgentId> => {
    const result = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name, platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)

    return result.agent.id
  }

  /** Earn `mailbox` the way the rung does, so a mail proof has something to bind to. */
  const proveMailbox = async (agent: AgentId, address: string): Promise<void> => {
    const minted = await mintEmailChallenge(db, agent, address)
    if (minted.outcome !== 'minted') throw new Error(minted.outcome)

    // The rung refuses a code it never sent, so the fixture has to do what the
    // mailer does. Skipping it fails as `nothing_sent_yet`, which reads like a
    // problem with the proof and is a problem with the setup.
    await markEmailSent(db, minted.challenge.id)

    const redeemed = await redeemEmailCode(db, agent, minted.challenge.code)
    if (redeemed.outcome !== 'verified') throw new Error(redeemed.outcome)
  }

  const accountOf = async (agent: AgentId, of: string) =>
    (await listAccounts(db, agent)).find((row) => row.kind === of)

  describe('a post proof', () => {
    it('proves an account at a provider with no verifier, and records how', async () => {
      const minted = await mintAccountProof(db, agentId, {
        kind: kind('trello'),
        identifier: 'colette-board',
        method: 'provider-post',
        provider: 'trello.com' as never,
      })
      if (minted.outcome !== 'minted') throw new Error(minted.outcome)

      const redeemed = await redeemPostProof(
        db,
        agentId,
        minted.proof.id,
        'https://trello.com/colette-board',
      )

      expect(redeemed.outcome).toBe('proved')

      const account = await accountOf(agentId, 'trello')
      expect(account).toMatchObject({
        proved: true,
        provedBy: 'provider-post',
        identifier: 'colette-board',
        provider: 'trello.com',
        // Possession and nothing more. A capability is what a verdict proved an
        // account can *do*.
        capabilities: [],
      })
      // The pair the check constraint enforces: a proved row carries both.
      expect(account?.provedAt).not.toBeNull()
    })

    it('mints a string short enough to be a bio', async () => {
      const minted = await mintAccountProof(db, agentId, {
        kind: kind('telegram'),
        identifier: 'colette',
        method: 'provider-post',
      })
      if (minted.outcome !== 'minted') throw new Error(minted.outcome)

      /**
       * The published string's own ceiling (`#1168`), beside the mail proof's
       * local part. A bio is the shortest surface an account tends to own —
       * Telegram's was measured at 70 — and a string that does not fit one leaves
       * a citizen with an account it cannot prove and no refusal saying why. The
       * assertion is what stops a later raise of the entropy from taking the fit
       * away silently.
       */
      expect(minted.proof.secret.length).toBeLessThanOrEqual(SHORTEST_MEASURED_PROFILE_LIMIT)
      // And it is still the alphabet a hand-paste survives: hex, no case to fold.
      expect(minted.proof.secret).toMatch(/^kol_acct_[0-9a-f]{60}$/)
    })

    it('is single-use', async () => {
      const minted = await mintAccountProof(db, agentId, {
        kind: kind('trello'),
        identifier: 'colette-board',
        method: 'provider-post',
      })
      if (minted.outcome !== 'minted') throw new Error(minted.outcome)

      await redeemPostProof(db, agentId, minted.proof.id, 'https://trello.com/x')
      const again = await redeemPostProof(db, agentId, minted.proof.id, 'https://trello.com/x')

      expect(again.outcome).toBe('no-open-proof')
      // And it is no longer readable as open, which is what the submit path checks
      // before it fetches anything.
      expect(await openAccountProof(db, agentId, minted.proof.id)).toBeUndefined()
    })

    it('is no longer open once it has expired', async () => {
      const minted = await mintAccountProof(db, agentId, {
        kind: kind('telegram'),
        identifier: 'colette',
        method: 'provider-post',
      })
      if (minted.outcome !== 'minted') throw new Error(minted.outcome)

      /**
       * The clock moved rather than the code: the row is aged past its deadline,
       * which is the only thing separating this from an ordinary open proof.
       *
       * **Both timestamps move, because `account_proofs_expiry_after_creation`
       * refuses a deadline before the minting** — a row cannot be aged by pulling
       * only the deadline back, which is the constraint doing exactly what it is
       * for.
       */
      await db.execute(
        `update account_proofs
            set created_at = now() - interval '2 days',
                expires_at = now() - interval '1 minute'
          where id = '${minted.proof.id}'`,
      )

      expect(await openAccountProof(db, agentId, minted.proof.id)).toBeUndefined()
      // And redeeming answers the same way a spent one does, which is what the
      // submit path turns into *mint another*: an expired string proves nothing,
      // and saying which flavour of gone it is would tell a caller nothing to act
      // on.
      expect(
        (await redeemPostProof(db, agentId, minted.proof.id, 'https://t.me/colette')).outcome,
      ).toBe('no-open-proof')
    })

    it('refuses when another citizen proved the same account first', async () => {
      const first = await mintAccountProof(db, agentId, {
        kind: kind('trello'),
        identifier: 'shared-board',
        method: 'provider-post',
      })
      const second = await mintAccountProof(db, otherId, {
        kind: kind('trello'),
        identifier: 'shared-board',
        method: 'provider-post',
      })
      if (first.outcome !== 'minted' || second.outcome !== 'minted') throw new Error('not minted')

      expect((await redeemPostProof(db, agentId, first.proof.id, 'https://x/1')).outcome).toBe(
        'proved',
      )

      /**
       * **The index is the boundary and the mint's check is only a courtesy.**
       * Both proofs were minted before either was spent, which is exactly the race
       * the courtesy cannot see — and it has to come back as its own outcome rather
       * than as a failure, because the second citizen has done nothing wrong.
       */
      const raced = await redeemPostProof(db, otherId, second.proof.id, 'https://x/2')
      expect(raced.outcome).toBe('already-proved-by-another')
    })

    it('refuses to mint against an account already proved elsewhere', async () => {
      await recordProvedAccount(db, otherId, {
        kind: kind('trello'),
        identifier: 'taken-board',
        capabilities: [],
        provedAt: new Date().toISOString(),
      })

      const minted = await mintAccountProof(db, agentId, {
        kind: kind('trello'),
        identifier: 'taken-board',
        method: 'provider-post',
      })

      expect(minted.outcome).toBe('already-proved-by-another')
    })
  })

  describe('a mail proof', () => {
    it('proves the account when the forward arrives from the proved mailbox', async () => {
      await proveMailbox(agentId, 'prover@mail.example')

      const minted = await mintAccountProof(db, agentId, {
        kind: kind('notion'),
        identifier: 'colette',
        method: 'provider-mail',
      })
      if (minted.outcome !== 'minted') throw new Error(minted.outcome)
      expect(minted.proof.token).toBe(minted.proof.secret)

      const arrived = await recordInboundProof(db, minted.proof.secret, 'prover@mail.example')

      expect(arrived.outcome).toBe('accepted')
      expect(await accountOf(agentId, 'notion')).toMatchObject({
        proved: true,
        provedBy: 'provider-mail',
      })
    })

    it('proves nothing when the forward comes from anywhere else', async () => {
      await proveMailbox(agentId, 'prover@mail.example')

      const minted = await mintAccountProof(db, agentId, {
        kind: kind('notion'),
        identifier: 'colette',
        method: 'provider-mail',
      })
      if (minted.outcome !== 'minted') throw new Error(minted.outcome)

      const arrived = await recordInboundProof(db, minted.proof.secret, 'stranger@example.org')

      expect(arrived.outcome).toBe('sender_mismatch')
      expect(await accountOf(agentId, 'notion')).toBeUndefined()
    })

    it('cannot be minted without a proved mailbox', async () => {
      const minted = await mintAccountProof(db, agentId, {
        kind: kind('notion'),
        identifier: 'colette',
        method: 'provider-mail',
      })

      expect(minted.outcome).toBe('no-proved-mailbox')
    })

    it('mints a string short enough to be a local part', async () => {
      await proveMailbox(agentId, 'prover@mail.example')

      const minted = await mintAccountProof(db, agentId, {
        kind: kind('notion'),
        identifier: 'colette',
        method: 'provider-mail',
      })
      if (minted.outcome !== 'minted') throw new Error(minted.outcome)

      /**
       * RFC 5321 caps a local part at 64 octets, and this value becomes one. The
       * assertion is here rather than in a comment because the failure it prevents
       * appears only against a real mail server, long after the tests pass.
       */
      expect(minted.proof.secret.length).toBeLessThanOrEqual(64)
    })

    it('says nothing about a token it does not hold', async () => {
      // The inbound handler tries the mailbox challenges through the same door, so
      // this outcome has to be distinguishable from every other one.
      expect((await recordInboundProof(db, 'kol_acct_nope', 'a@b.example')).outcome).toBe(
        'unknown_token',
      )
    })
  })

  describe('what a rung is worth beside a generic proof', () => {
    it('marks a rung’s verdict as rung-proved without being asked', async () => {
      await recordProvedAccount(db, agentId, {
        kind: kind('github'),
        identifier: 'colette',
        capabilities: [],
        provedAt: new Date().toISOString(),
      })

      // Every caller that existed before `#520` was a verdict, so the default has
      // to be the one they all meant.
      expect(await accountOf(agentId, 'github')).toMatchObject({ provedBy: 'rung' })
    })

    it('lets a rung overrule a generic proof', async () => {
      const minted = await mintAccountProof(db, agentId, {
        kind: kind('github'),
        identifier: 'colette',
        method: 'provider-post',
      })
      if (minted.outcome !== 'minted') throw new Error(minted.outcome)
      await redeemPostProof(db, agentId, minted.proof.id, 'https://github.com/colette')

      expect(await accountOf(agentId, 'github')).toMatchObject({ provedBy: 'provider-post' })

      await recordProvedAccount(db, agentId, {
        kind: kind('github'),
        identifier: 'colette',
        capabilities: [],
        provedAt: new Date().toISOString(),
      })

      // The citizen holds the stronger claim now and the register says so.
      expect(await accountOf(agentId, 'github')).toMatchObject({ provedBy: 'rung' })
    })

    it('never lets a generic proof downgrade a rung', async () => {
      await recordProvedAccount(db, agentId, {
        kind: kind('github'),
        identifier: 'colette',
        capabilities: [],
        provedAt: new Date().toISOString(),
      })

      const minted = await mintAccountProof(db, agentId, {
        kind: kind('github'),
        identifier: 'colette',
        method: 'provider-post',
      })
      if (minted.outcome !== 'minted') throw new Error(minted.outcome)
      await redeemPostProof(db, agentId, minted.proof.id, 'https://github.com/colette')

      /**
       * **The one outcome `#520` says must not happen.** Conflating the two would
       * quietly devalue every rung already earned, and here it would do it by
       * overwriting one — so the direction is asserted rather than described.
       */
      expect(await accountOf(agentId, 'github')).toMatchObject({ provedBy: 'rung' })
    })
  })

  describe('the shape of the table itself', () => {
    /**
     * Which constraint refused a statement.
     *
     * **Read off `constraint_name` down the cause chain, not out of the message.**
     * Drizzle wraps the driver's error in its own *"Failed query: …"*, so the
     * message names the statement and never the rule — asserting on it passes for
     * any failure at all, which would make these four tests agree with a database
     * that had none of the constraints.
     */
    const refusedBy = async (statement: string): Promise<string | undefined> => {
      try {
        await db.execute(statement)
      } catch (error: unknown) {
        for (let current: unknown = error; current != null;) {
          if (typeof current === 'object' && 'constraint_name' in current) {
            return (current as { constraint_name?: string }).constraint_name
          }
          current =
            typeof current === 'object' && current !== null && 'cause' in current
              ? (current as { cause?: unknown }).cause
              : null
        }

        return 'refused by something that named no constraint'
      }

      return undefined
    }

    /**
     * **A proved row with no method is accepted, and read as a rung.**
     *
     * This is the half that could not be a check constraint: `0112` is a data
     * repair that sets `proved` on mailbox rows and predates this column, and its
     * replay is tested as written. So the guarantee lives in `toAccount`, and this
     * is the test of it — the row goes in bare, and the reader still names a
     * strength.
     */
    it('reads a proved row with no recorded method as rung-proved', async () => {
      expect(
        await refusedBy(
          `insert into accounts (agent_id, kind, identifier, proved, proved_at)
           values ('${agentId}', 'trello', 'unmarked', true, now())`,
        ),
      ).toBeUndefined()

      expect(await accountOf(agentId, 'trello')).toMatchObject({
        proved: true,
        provedBy: 'rung',
      })
    })

    it('refuses an unproved row that claims a method', async () => {
      expect(
        await refusedBy(
          `insert into accounts (agent_id, kind, identifier, proved, proved_by)
           values ('${agentId}', 'trello', 'unearned', false, 'provider-post')`,
        ),
      ).toBe('accounts_unproved_names_no_method')
    })

    it('refuses a method nothing recognises', async () => {
      expect(
        await refusedBy(
          `insert into accounts (agent_id, kind, identifier, proved, proved_at, proved_by)
           values ('${agentId}', 'trello', 'typo', true, now(), 'provider_mail')`,
        ),
      ).toBe('accounts_proved_by_is_known')
    })

    it('refuses a proof claiming a rung’s strength', async () => {
      expect(
        await refusedBy(
          `insert into account_proofs (agent_id, kind, identifier, method, secret, expires_at)
           values ('${agentId}', 'trello', 'x', 'rung', 'kol_acct_x', now() + interval '1 day')`,
        ),
      ).toBe('account_proofs_method_is_generic')
    })

    it('refuses a mail proof that names no sender', async () => {
      expect(
        await refusedBy(
          `insert into account_proofs (agent_id, kind, identifier, method, secret, expires_at)
           values ('${agentId}', 'trello', 'x', 'provider-mail', 'kol_acct_y', now() + interval '1 day')`,
        ),
      ).toBe('account_proofs_mail_names_its_sender')
    })
  })
})
