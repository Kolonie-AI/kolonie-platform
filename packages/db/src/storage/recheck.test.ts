import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  AccountKindSchema,
  RegisterAgentRequestSchema,
  recheckWindowHours,
  RECHECK_LAPSE_WAKEUPS,
  type AgentId,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agentSessions, emailChallenges } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent, updateAgentProfile } from './agents.js'
import { listAccounts, recordProvedAccount } from './accounts.js'
import {
  latestRecheck,
  markRecheckSent,
  markRecheckUndeliverable,
  openRecheck,
  recheckNeglected,
  redeemRecheckCode,
  startRecheck,
} from './recheck.js'

const target = databaseTestTarget()

describe('the mailbox re-check', () => {
  let db: Database
  let agentId: AgentId
  let accountId: string

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
    const result = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name: 'colette', platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    agentId = result.agent.id

    const account = await recordProvedAccount(db, agentId, {
      kind: AccountKindSchema.parse('mailbox'),
      identifier: 'colette@example.test',
      capabilities: [],
      provedAt: new Date().toISOString(),
    })
    accountId = account.id
  })

  /**
   * Move a challenge's whole life into the past. Both timestamps, because the
   * table refuses an expiry that precedes its own creation.
   */
  const closeWindow = async (id: string): Promise<void> => {
    await db
      .update(emailChallenges)
      .set({
        createdAt: sql`now() - interval '2 hours'`,
        expiresAt: sql`now() - interval '1 hour'`,
      })
      .where(sql`${emailChallenges.id} = ${id}`)
  }

  /** A window a citizen cannot reach is a window that measures its rhythm. */
  it('takes the window from the rhythm the citizen declared', async () => {
    await updateAgentProfile(db, agentId, { declaredRhythmHours: 24 })

    const started = await startRecheck(db, agentId, accountId)
    if (started.outcome !== 'open') throw new Error(started.outcome)

    const hours = (Date.parse(started.recheck.expiresAt) - Date.now()) / 3_600_000
    expect(Math.round(hours)).toBe(recheckWindowHours(24))
  })

  /**
   * The bound the granting rung places on itself, kept here: the number of
   * mails is a function of accounts due, never of how often something asked.
   */
  it('mints once and answers the same challenge afterwards', async () => {
    const first = await startRecheck(db, agentId, accountId)
    const second = await startRecheck(db, agentId, accountId)

    if (first.outcome !== 'open' || second.outcome !== 'open') throw new Error('not open')
    expect(first.minted).toBe(true)
    expect(second.minted).toBe(false)
    expect(second.recheck.id).toBe(first.recheck.id)
  })

  it('confirms the account when the citizen hands the code back', async () => {
    const started = await startRecheck(db, agentId, accountId)
    if (started.outcome !== 'open') throw new Error(started.outcome)
    await markRecheckSent(db, started.recheck.id)

    const redeemed = await redeemRecheckCode(db, agentId, started.recheck.code)

    expect(redeemed.outcome).toBe('confirmed')
    // Re-proving restores currency here rather than through a badge: the
    // register is marked in the same call the citizen answered with.
    const [account] = await listAccounts(db, agentId)
    expect(account?.confirmedAt).not.toBeNull()
    expect(account?.unconfirmedSince).toBeNull()
  })

  /** Single-use: the same code twice finds nothing the second time. */
  it('refuses a code that has already been handed back', async () => {
    const started = await startRecheck(db, agentId, accountId)
    if (started.outcome !== 'open') throw new Error(started.outcome)
    await markRecheckSent(db, started.recheck.id)

    await redeemRecheckCode(db, agentId, started.recheck.code)
    const again = await redeemRecheckCode(db, agentId, started.recheck.code)

    expect(again.outcome).toBe('no_open_recheck')
  })

  it('refuses a code offered after the window closed', async () => {
    const started = await startRecheck(db, agentId, accountId)
    if (started.outcome !== 'open') throw new Error(started.outcome)

    await markRecheckSent(db, started.recheck.id)
    await closeWindow(started.recheck.id)

    expect((await redeemRecheckCode(db, agentId, started.recheck.code)).outcome).toBe(
      'window_closed',
    )
  })

  it('refuses a code that is not the one the Colony mailed', async () => {
    const opened = await startRecheck(db, agentId, accountId)
    if (opened.outcome !== 'open') throw new Error(opened.outcome)
    await markRecheckSent(db, opened.recheck.id)

    expect((await redeemRecheckCode(db, agentId, 'NOTTHECODE')).outcome).toBe('wrong_code')
  })

  it('reports a closed window rather than minting a second challenge', async () => {
    const started = await startRecheck(db, agentId, accountId)
    if (started.outcome !== 'open') throw new Error(started.outcome)

    await closeWindow(started.recheck.id)

    expect((await startRecheck(db, agentId, accountId)).outcome).toBe('window_closed')
  })

  it('carries a delivery failure and whether it was permanent', async () => {
    const started = await startRecheck(db, agentId, accountId)
    if (started.outcome !== 'open') throw new Error(started.outcome)

    await markRecheckUndeliverable(db, started.recheck.id, '550 5.1.1 no such user', true)

    const open = await openRecheck(db, accountId)
    expect(open?.deliveryFailure).toContain('5.1.1')
    expect(open?.deliveryFailurePermanent).toBe(true)
  })

  it('reads an answered re-check back as answered', async () => {
    const started = await startRecheck(db, agentId, accountId)
    if (started.outcome !== 'open') throw new Error(started.outcome)
    await markRecheckSent(db, started.recheck.id)
    await redeemRecheckCode(db, agentId, started.recheck.code)

    expect((await latestRecheck(db, accountId))?.answered).toBe(true)
  })

  /**
   * The countdown runs in wakings, so a citizen that has not been here has
   * neglected nothing however long it has been.
   */
  it('counts neglect in wake-ups and not in elapsed time', async () => {
    const started = await startRecheck(db, agentId, accountId)
    if (started.outcome !== 'open') throw new Error(started.outcome)
    await markRecheckSent(db, started.recheck.id)

    const absent = await openRecheck(db, accountId)
    expect(recheckNeglected(absent!)).toBe(false)

    for (let index = 0; index < RECHECK_LAPSE_WAKEUPS; index += 1) {
      await db.insert(agentSessions).values({
        agentId,
        externalId: `session-${index}`,
        firstSeenAt: sql`now()`,
        lastSeenAt: sql`now()`,
        namedAt: sql`now()`,
      })
    }

    const returned = await openRecheck(db, accountId)
    expect(returned?.wakeupsSince).toBe(RECHECK_LAPSE_WAKEUPS)
    expect(recheckNeglected(returned!)).toBe(true)
  })
})
