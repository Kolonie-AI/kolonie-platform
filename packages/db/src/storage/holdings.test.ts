import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { AccountKindSchema, RegisterAgentRequestSchema, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import { declareAccount, recordAccountRecheck, recordProvedAccount } from './accounts.js'
import { holdingsOf } from './holdings.js'
import { setVaultEntry } from './vault.js'

const target = databaseTestTarget()

/**
 * What a citizen holds, as `kolonie.me` reads it back (`#144`).
 *
 * The assembly is what is under test — three reads that have to agree about one
 * citizen — and in particular the two things the issue's criteria are pointed
 * at: that the reach address is *the* address the Colony writes to rather than
 * one the citizen proved, and that nothing on this path opens a vault entry.
 */
describe('what a citizen holds', () => {
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

  const anAgent = async (name = 'canary'): Promise<AgentId> => {
    const result = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name, platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    return result.agent.id
  }

  const declare = async (agentId: AgentId, kind: string, identifier: string) => {
    const declared = await declareAccount(db, agentId, {
      kind: AccountKindSchema.parse(kind),
      identifier,
    })
    if (declared.outcome !== 'declared') throw new Error(declared.outcome)
    return declared.account
  }

  /**
   * A proved account, because only a proved one can be re-checked — an
   * unconfirmed row is the record of a check that failed, and there is nothing
   * to re-check about something the Colony never verified.
   */
  const prove = async (agentId: AgentId, kind: string, identifier: string) =>
    await recordProvedAccount(db, agentId, {
      kind: AccountKindSchema.parse(kind),
      identifier,
      capabilities: [],
      provedAt: new Date().toISOString(),
    })

  it('is empty for a citizen that has just arrived', async () => {
    const agentId = await anAgent()

    expect(await holdingsOf(db, agentId)).toEqual({
      accounts: {},
      reachAddress: null,
      unconfirmed: [],
      reachAddressUnconfirmed: false,
      vaultEntries: 0,
    })
  })

  it('counts accounts by kind and omits the kinds it holds none of', async () => {
    const agentId = await anAgent()
    await declare(agentId, 'mailbox', 'one@example.invalid')
    await declare(agentId, 'mailbox', 'two@example.invalid')
    await declare(agentId, 'github', 'canary')

    const holdings = await holdingsOf(db, agentId)

    expect(holdings.accounts).toEqual({ mailbox: 2, github: 1 })
    expect(Object.keys(holdings.accounts)).not.toContain('social')
  })

  it('keeps one citizen’s holdings out of another’s', async () => {
    const mine = await anAgent('canary-one')
    const theirs = await anAgent('canary-two')
    await declare(mine, 'github', 'canary')

    expect((await holdingsOf(db, theirs)).accounts).toEqual({})
  })

  /**
   * Counted, and never opened. `vaultEntryCount` holds no sealing token, so a
   * future change that reached for `listVaultEntries` to get this number would
   * have to add one — which is the point of the two functions being different.
   */
  it('counts vault entries without a sealing token', async () => {
    const agentId = await anAgent()
    await setVaultEntry(db, 'kol_token', agentId, 'smtp', 'secret', 'the mailbox password')
    await setVaultEntry(db, 'kol_token', agentId, 'api', 'secret')

    expect((await holdingsOf(db, agentId)).vaultEntries).toBe(2)
  })

  /**
   * The unconfirmed case (`#152`): a fact rather than a penalty, named rather
   * than counted so a citizen does not have to open the register to find out
   * which account it is about.
   */
  it('names an account the register last failed to find', async () => {
    const agentId = await anAgent()
    const account = await prove(agentId, 'github', 'canary')

    await recordAccountRecheck(db, account.id, 'gone', new Date().toISOString())

    const holdings = await holdingsOf(db, agentId)
    expect(holdings.unconfirmed).toEqual(['canary'])
    // Not the reach address, which is the case that costs the citizen
    // something and is answered separately.
    expect(holdings.reachAddressUnconfirmed).toBe(false)
  })

  it('says nothing is unconfirmed when a later check found it again', async () => {
    const agentId = await anAgent()
    const account = await prove(agentId, 'github', 'canary')

    await recordAccountRecheck(db, account.id, 'gone', new Date().toISOString())
    await recordAccountRecheck(db, account.id, 'held', new Date().toISOString())

    expect((await holdingsOf(db, agentId)).unconfirmed).toEqual([])
  })

  /**
   * **The reach address is the one the Colony writes to, not one the citizen
   * proved.** D-047 puts that on `email_challenges.primary_at`, and asking the
   * account register instead would answer with *an* address — which a citizen
   * could not act on, because it would not know whether mail arrives there.
   */
  describe('the address the Colony writes to', () => {
    const aProvedMailbox = async (agentId: AgentId, address: string, primary: boolean) => {
      await db.execute(sql`
        insert into email_challenges
          (agent_id, address, token, code, purpose, expires_at, sent_at, verified_at, primary_at)
        values (${agentId}, ${address}, ${address}, '123456', 'inbox',
                now() + interval '1 day', now(), now(),
                ${primary ? sql`now()` : sql`null`})
      `)
      await prove(agentId, 'mailbox', address)
    }

    it('is null for a citizen that has proved none', async () => {
      const agentId = await anAgent()
      await declare(agentId, 'mailbox', 'unproved@example.invalid')

      expect((await holdingsOf(db, agentId)).reachAddress).toBeNull()
    })

    it('is the primary mailbox and not merely the newest proved one', async () => {
      const agentId = await anAgent()
      await aProvedMailbox(agentId, 'first@example.invalid', true)
      await aProvedMailbox(agentId, 'second@example.invalid', false)

      expect((await holdingsOf(db, agentId)).reachAddress).toBe('first@example.invalid')
    })

    /**
     * The one case here that costs the citizen something: mail the Colony sends
     * may not arrive, and the remedy is different from the remedy for any other
     * unconfirmed account.
     */
    it('is flagged when the register last failed to find it', async () => {
      const agentId = await anAgent()
      await aProvedMailbox(agentId, 'reach@example.invalid', true)
      const [account] = await db.execute<{ id: string }>(
        sql`select id from accounts where agent_id = ${agentId} and identifier = 'reach@example.invalid'`,
      )
      await recordAccountRecheck(db, account!.id, 'gone', new Date().toISOString())

      const holdings = await holdingsOf(db, agentId)
      expect(holdings.reachAddressUnconfirmed).toBe(true)
      expect(holdings.unconfirmed).toEqual(['reach@example.invalid'])
    })
  })
})
