import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  AccountKindSchema,
  RegisterAgentRequestSchema,
  type AccountCapability,
  type AgentId,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import {
  ACCOUNT_FROM_SKILL,
  accountsObtainedThrough,
  declareAccount,
  listAccounts,
  recheckableAccounts,
  recordAccountRecheck,
  recordProvedAccount,
  resolveAccount,
  setAccountNote,
  setAccountPreference,
  setAccountStatus,
  setAccountVaultKey,
} from './accounts.js'

const target = databaseTestTarget()

if (!target.available) {
  console.warn(`\n${target.reason}\n`)
}

const kind = (value: string) => AccountKindSchema.parse(value)
const capabilities = (...values: string[]) => values as unknown as readonly AccountCapability[]

describe.skipIf(!target.available)('the account register', () => {
  let db: Database
  let agentId: AgentId
  let otherId: AgentId

  beforeAll(async () => {
    if (!target.available) return
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
    agentId = await register('holder')
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

  const prove = (agent: AgentId, of: string, identifier: string, ...caps: string[]) =>
    recordProvedAccount(db, agent, {
      kind: kind(of),
      identifier,
      capabilities: capabilities(...caps),
      provedAt: new Date().toISOString(),
    })

  describe('what a citizen may write', () => {
    it('records an account the citizen says it holds, and marks it unproved', async () => {
      const declared = await declareAccount(db, agentId, {
        kind: kind('social'),
        identifier: '@newcomer',
        note: 'created ten minutes ago, cannot post for 48 hours',
      })

      expect(declared).toMatchObject({
        outcome: 'declared',
        account: { proved: false, provedAt: null, capabilities: [], status: 'in-use' },
      })
    })

    /**
     * The rejection case that decides whether the register is evidence or a
     * claim. An unproved account is a note the citizen left itself; a verifier
     * that would accept one turns the register into a way to assert a
     * capability, which is the one thing it must never be.
     */
    it('never offers an unproved account to a verifier', async () => {
      await declareAccount(db, agentId, { kind: kind('domain'), identifier: 'declared.example' })

      expect(await resolveAccount(db, agentId, kind('domain'))).toBeUndefined()
    })

    it('answers a repeated declaration with the row that is already there', async () => {
      await declareAccount(db, agentId, { kind: kind('github'), identifier: 'octocat' })

      const again = await declareAccount(db, agentId, {
        kind: kind('github'),
        identifier: 'OCTOCAT',
      })

      expect(again.outcome).toBe('already_recorded')
      expect(await listAccounts(db, agentId)).toHaveLength(1)
    })

    /** One instrument names one citizen, for the kinds that identify (D-044's rule, per kind). */
    it('refuses an identifier another citizen has proved', async () => {
      await prove(otherId, 'github', 'octocat', 'control')

      expect(
        await declareAccount(db, agentId, { kind: kind('github'), identifier: 'octocat' }),
      ).toEqual({ outcome: 'identifier_taken' })
    })

    /**
     * **An unproved claim reserves nothing**, exactly as an unproved mailbox
     * challenge reserves no address: a citizen that typed a handle it does not
     * hold would otherwise lock that handle out of the Colony for ever.
     */
    it('lets a citizen prove what another citizen merely declared', async () => {
      await declareAccount(db, otherId, { kind: kind('github'), identifier: 'octocat' })

      const proved = await prove(agentId, 'github', 'octocat', 'control')

      expect(proved.proved).toBe(true)
    })

    /** `website` is the configured exception: a URL is a place rather than an identity. */
    it('lets two citizens hold the same website', async () => {
      await prove(otherId, 'website', 'https://shared.example/page', 'control')

      expect(
        await declareAccount(db, agentId, {
          kind: kind('website'),
          identifier: 'https://shared.example/page',
        }),
      ).toMatchObject({ outcome: 'declared' })
    })
  })

  describe('what only a verdict may write', () => {
    it('adds capabilities rather than replacing them', async () => {
      await prove(agentId, 'mailbox', 'citizen@example.org', 'receive')
      const both = await prove(agentId, 'mailbox', 'citizen@example.org', 'send')

      expect([...both.capabilities].sort()).toEqual(['receive', 'send'])
    })

    it('keeps the first proof date when a later verdict names the same account', async () => {
      const first = await prove(agentId, 'domain', 'example.test', 'control')
      const second = await prove(agentId, 'domain', 'example.test', 'control')

      expect(second.provedAt).toBe(first.provedAt)
    })

    /**
     * A caller cannot write a capability, because the write path takes none. The
     * property is pinned here rather than left to the type system alone: this is
     * the assertion that fails if somebody ever threads `capabilities` out
     * through `declareAccount`.
     */
    it('gives a declared account no capabilities, whatever it was declared with', async () => {
      const declared = await declareAccount(db, agentId, {
        kind: kind('wallet'),
        identifier: 'So11111111111111111111111111111111111111112',
      })

      expect(declared).toMatchObject({ account: { capabilities: [], proved: false } })
    })
  })

  describe('what the citizen alone decides', () => {
    it('retires an account without losing it', async () => {
      const account = await prove(agentId, 'social', '@old-handle', 'publish')

      const retired = await setAccountStatus(db, agentId, account.id, 'retired')

      expect(retired).toMatchObject({ outcome: 'updated', account: { status: 'retired' } })
      // Kept, because the verdict that earned a skill still names the account it
      // was earned against.
      expect(await listAccounts(db, agentId)).toHaveLength(1)
    })

    it('stops offering a retired account', async () => {
      const account = await prove(agentId, 'social', '@old-handle', 'publish')
      await prove(agentId, 'social', '@current', 'publish')
      await setAccountStatus(db, agentId, account.id, 'retired')

      expect(await resolveAccount(db, agentId, kind('social'))).toMatchObject({
        identifier: '@current',
      })
    })

    it('lets the preference decide which of several is offered', async () => {
      await prove(agentId, 'social', '@first', 'publish')
      const second = await prove(agentId, 'social', '@second', 'publish')

      await setAccountPreference(db, agentId, second.id)

      expect(await resolveAccount(db, agentId, kind('social'))).toMatchObject({
        identifier: '@second',
      })
    })

    it('moves the preference rather than holding two', async () => {
      const first = await prove(agentId, 'social', '@first', 'publish')
      const second = await prove(agentId, 'social', '@second', 'publish')

      await setAccountPreference(db, agentId, first.id)
      await setAccountPreference(db, agentId, second.id)

      const held = await listAccounts(db, agentId, kind('social'))
      expect(held.filter((account) => account.preferred)).toHaveLength(1)
    })

    /**
     * **Mail has no preference here**, because for mail the question is the reach
     * address — one obligation, decided by D-047 and moved by `promoteMailbox`.
     * A second answer in this table is what the check constraint refuses.
     */
    it('refuses a preference on a mailbox, naming where that decision lives', async () => {
      const mailbox = await prove(agentId, 'mailbox', 'citizen@example.org', 'receive')

      expect(await setAccountPreference(db, agentId, mailbox.id)).toEqual({
        outcome: 'mail_has_no_preference',
      })
    })

    it('never lets a citizen write against another citizen’s account', async () => {
      const theirs = await prove(otherId, 'github', 'octocat', 'control')

      expect(await setAccountStatus(db, agentId, theirs.id, 'lost')).toEqual({
        outcome: 'not_found',
      })
      expect(await setAccountNote(db, agentId, theirs.id, 'mine now')).toEqual({
        outcome: 'not_found',
      })
      expect(await setAccountVaultKey(db, agentId, theirs.id, 'theirs')).toEqual({
        outcome: 'not_found',
      })
    })

    /** A label pointing at a label. The entry it names need not exist. */
    it('accepts a vault key for an entry that does not exist', async () => {
      const account = await prove(agentId, 'mailbox', 'citizen@example.org', 'receive')

      expect(await setAccountVaultKey(db, agentId, account.id, 'mail-2')).toMatchObject({
        outcome: 'updated',
        account: { vaultKey: 'mail-2' },
      })
    })
  })

  describe('provenance', () => {
    it('records every existing account as self-acquired', async () => {
      const account = await prove(agentId, 'mailbox', 'citizen@example.org', 'receive')

      expect(account.provenance).toBe('self-acquired')
      expect(account.obtainedThroughTaskId).toBeNull()
    })

    /**
     * The one query the whole field exists for: if the quest arrangement is ever
     * abused, the affected population is a `where` clause rather than an
     * archaeology project across verdicts.
     */
    it('finds every account one task handed out', async () => {
      expect(await accountsObtainedThrough(db, crypto.randomUUID())).toEqual([])
    })
  })

  describe('the register describes and never decides', () => {
    /**
     * **Nothing gates on it**, and this is the assertion that says so at the
     * level where it could stop being true. `accounts` appears in no query that
     * computes availability, ordering or a reward — those live in `tasks.ts`,
     * `attempts.ts` and `rewards.ts`, and the first two must not learn to read
     * it.
     *
     * `rewards.ts` is the exception and it is a *writer*: it records what a
     * verdict proved, in the verdict's transaction, and reads nothing back.
     */
    it('is read by no gate, no ordering and no reward path', async () => {
      const forbidden = ['tasks.ts', 'attempts.ts', 'balance.ts', 'rewards.ts']

      for (const file of forbidden) {
        const source = readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), 'utf8')
        const reads = source.includes('listAccounts') || source.includes('resolveAccount')

        expect(reads, `${file} must not read the account register`).toBe(false)
      }
    })

    /** Provenance is a record and not a grade: nothing anywhere reads it to decide. */
    it('never reads provenance to permit, refuse, rank or discount', async () => {
      for (const file of ['tasks.ts', 'attempts.ts', 'balance.ts', 'rewards.ts', 'skills.ts']) {
        const source = readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), 'utf8')

        expect(source.includes('provenance'), `${file} must not read provenance`).toBe(false)
      }
    })

    /**
     * The mapping and the backfill describe the same thing, and this is what
     * keeps them describing it. A rung whose identifier key moved would
     * otherwise keep backfilling correctly and stop recording anything new — or
     * the reverse — and neither failure has a test that would notice.
     */
    it('backfills from the same keys the verdict path reads', () => {
      const backfill = readFileSync(
        fileURLToPath(
          new URL('../../drizzle/0066_backfill_the_account_register.sql', import.meta.url),
        ),
        'utf8',
      )

      for (const [skill, source] of Object.entries(ACCOUNT_FROM_SKILL)) {
        const expected =
          source.from === 'metadata'
            ? `"metadata"->>'${source.key}'`
            : `"payload"->>'${source.key}'`

        // `mailbox` and `wallet` are backfilled from their challenge tables,
        // where the identifier is a column rather than a key on a verdict — so
        // the assertion for those two is that the column is named, not the key.
        const named =
          skill === 'mailbox' || skill === 'wallet'
            ? backfill.includes('"address"')
            : backfill.includes(expected)

        expect(named, `the backfill must read ${skill} from ${expected}`).toBe(true)
      }
    })
  })

  /**
   * What a re-check leaves behind (`#152`).
   *
   * The rule under all of these is that **nothing is ever revoked**: a failed
   * re-check writes nothing to reputation, nothing to the ledger and removes no
   * skill. What changes is one field, and it is a fact rather than a penalty.
   */
  describe('re-verification', () => {
    it('records when an account was last confirmed', async () => {
      const account = await prove(agentId, 'domain', 'example.test', 'control')

      await recordAccountRecheck(db, account.id, 'held', new Date().toISOString())

      const [held] = await listAccounts(db, agentId, kind('domain'))
      expect(held?.confirmedAt).not.toBeNull()
      expect(held?.unconfirmedSince).toBeNull()
    })

    it('marks an account unconfirmed, with the date, and takes nothing away', async () => {
      const account = await prove(agentId, 'domain', 'example.test', 'control')

      await recordAccountRecheck(db, account.id, 'gone', new Date().toISOString())

      const [held] = await listAccounts(db, agentId, kind('domain'))
      expect(held?.unconfirmedSince).not.toBeNull()
      // The proof, the capability and the account itself are all untouched.
      expect(held).toMatchObject({ proved: true, capabilities: ['control'], status: 'in-use' })
    })

    it('clears an earlier failure when a later check finds it again', async () => {
      const account = await prove(agentId, 'domain', 'example.test', 'control')
      await recordAccountRecheck(db, account.id, 'gone', new Date().toISOString())

      await recordAccountRecheck(db, account.id, 'held', new Date().toISOString())

      const [held] = await listAccounts(db, agentId, kind('domain'))
      expect(held?.unconfirmedSince).toBeNull()
    })

    /** Retired and lost are never asked about: the citizen said so. */
    it('offers no retired or lost account for re-checking', async () => {
      const retired = await prove(agentId, 'domain', 'retired.test', 'control')
      const lost = await prove(agentId, 'domain', 'lost.test', 'control')
      await prove(agentId, 'domain', 'live.test', 'control')
      await setAccountStatus(db, agentId, retired.id, 'retired')
      await setAccountStatus(db, agentId, lost.id, 'lost')

      const recheckable = await recheckableAccounts(db, agentId, ['domain'])

      expect(recheckable.map((account) => account.identifier)).toEqual(['live.test'])
    })

    it('never offers an unproved account for re-checking', async () => {
      await declareAccount(db, agentId, { kind: kind('domain'), identifier: 'declared.test' })

      expect(await recheckableAccounts(db, agentId, ['domain'])).toEqual([])
    })

    /** The Colony asks about the account it knows least about. */
    it('offers the account with the oldest evidence first', async () => {
      const older = await prove(agentId, 'domain', 'older.test', 'control')
      await prove(agentId, 'domain', 'newer.test', 'control')
      await recordAccountRecheck(db, older.id, 'held', new Date(Date.now() - 1000).toISOString())

      const recheckable = await recheckableAccounts(db, agentId, ['domain'])

      expect(recheckable[0]?.identifier).toBe('older.test')
    })

    it('offers nothing for a kind nothing can check', async () => {
      await prove(agentId, 'social', '@handle', 'publish')

      expect(await recheckableAccounts(db, agentId, ['domain'])).toEqual([])
    })
  })
})
