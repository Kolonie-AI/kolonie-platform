import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { AccountKindSchema, RegisterAgentRequestSchema, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { emailChallenges } from '../schema/index.js'
import { connectForTests, databaseTestTarget, MIGRATIONS_FOLDER, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import { declareAccount, listAccounts, providerTallies } from './accounts.js'

const target = databaseTestTarget()

/**
 * The repair `#297` was filed about, run as written rather than as a
 * reimplementation — the same rule `0104`'s test states: a data migration runs
 * once and cannot be corrected by running it again, so the statement that will
 * meet the production database is the one that has to be tested.
 *
 * **What it repairs, and how the gap opened.** `0066` filled the register with
 * `INSERT … ON CONFLICT DO NOTHING`, which is right for an insert and wrong for
 * a repair: a mailbox the citizen had already declared was an existing row, so
 * the insert conflicted and the row kept `proved = false`. `#289` closed the
 * forward gap by writing the register inside `redeemEmailCode`, which helps only
 * a mailbox verified after it deployed.
 *
 * A citizen read `proved: false, capabilities: []` from `accounts.list` for the
 * address `mailboxes.list` reported as granted and reach, and could not repair
 * it by passing anything: it had proved that mailbox as a *second* one on an
 * already-passed rung, and `#292` refuses a passed rung permanently. Then
 * `accounts.providers` started counting `proved` per provider, and the flag
 * stopped being cosmetic — the citizen's best working provider landed as
 * `proved: 0` beside a receive-only one at `proved: 1`.
 */
describe('the mailbox proof repair', () => {
  let db: Database
  let statements: string[]

  beforeAll(async () => {
    db = await connectForTests(target.url)
    const file = await readFile(
      join(MIGRATIONS_FOLDER, '0112_the_mailboxes_the_register_still_calls_unproved.sql'),
      'utf8',
    )
    statements = file
      .split('--> statement-breakpoint')
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  const runRepair = async (): Promise<void> => {
    for (const statement of statements) {
      await db.execute(sql.raw(statement))
    }
  }

  let seeded = 0

  const anAgent = async (): Promise<AgentId> => {
    const result = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name: `unproved-${++seeded}`, platform: 'claude' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    return result.agent.id
  }

  /** A challenge the citizen cleared, written directly — the proof, not the path to it. */
  const aVerifiedChallenge = async (
    agentId: AgentId,
    address: string,
    purpose: 'inbox' | 'send' = 'inbox',
  ): Promise<void> => {
    await db.insert(emailChallenges).values({
      agentId,
      address,
      purpose,
      // A code and a sent mail belong to the inbox half: the Colony writes to
      // the citizen there and the citizen reads a nonce back. The send half runs
      // the other way — mail arrives from the address — and a check constraint
      // enforces the difference rather than leaving it to a convention.
      ...(purpose === 'inbox'
        ? { code: `CODE${++seeded}`.toUpperCase(), sentAt: sql`now() - interval '2 hours'` }
        : { inboundAt: sql`now() - interval '2 hours'` }),
      token: `token-${++seeded}`,
      expiresAt: sql`now() + interval '1 hour'`,
      verifiedAt: sql`now() - interval '1 hour'`,
    })
  }

  const declared = async (agentId: AgentId, identifier: string, provider?: string) => {
    await declareAccount(db, agentId, {
      kind: AccountKindSchema.parse('mailbox'),
      identifier,
      ...(provider === undefined ? {} : { provider }),
    })
  }

  const mailboxes = async (agentId: AgentId) =>
    listAccounts(db, agentId, AccountKindSchema.parse('mailbox'))

  /** The reported state, end to end. */
  it('marks a declared mailbox the Colony verified as proved, with what it proves', async () => {
    const agentId = await anAgent()
    await declared(agentId, 'vireo@atomicmail.ai')
    await aVerifiedChallenge(agentId, 'vireo@atomicmail.ai')

    expect((await mailboxes(agentId))[0]).toMatchObject({ proved: false, capabilities: [] })

    await runRepair()

    expect((await mailboxes(agentId))[0]).toMatchObject({
      proved: true,
      capabilities: ['receive'],
    })
  })

  /**
   * The consequence the citizen measured, and the reason this stopped being
   * cosmetic: the provider dataset counts proofs, and the best working provider
   * was landing at zero.
   */
  it('stops the provider tally recording a verified provider as proved:0', async () => {
    const agentId = await anAgent()
    await declared(agentId, 'vireo@atomicmail.ai', 'atomicmail.io')
    await aVerifiedChallenge(agentId, 'vireo@atomicmail.ai')

    const before = await providerTallies(db)
    expect(before.find((row) => row.provider === 'atomicmail.io')).toMatchObject({ proved: 0 })

    await runRepair()

    const after = await providerTallies(db)
    expect(after.find((row) => row.provider === 'atomicmail.io')).toMatchObject({
      citizens: 1,
      proved: 1,
    })
  })

  /**
   * Each purpose contributes only what it proves. Reading a nonce out of a
   * mailbox proves `receive` and sending one proves `send`; a repair that
   * granted both from either would put a capability on record that nothing
   * demonstrated, which is the one thing this table must never carry.
   */
  it('records send beside receive when both halves were cleared, and neither implies the other', async () => {
    const both = await anAgent()
    await declared(both, 'writer@atomicmail.ai')
    await aVerifiedChallenge(both, 'writer@atomicmail.ai', 'inbox')
    await aVerifiedChallenge(both, 'writer@atomicmail.ai', 'send')

    const sendOnly = await anAgent()
    await declared(sendOnly, 'outbound@atomicmail.ai')
    await aVerifiedChallenge(sendOnly, 'outbound@atomicmail.ai', 'send')

    await runRepair()

    expect((await mailboxes(both))[0]?.capabilities).toEqual(['receive', 'send'])
    expect((await mailboxes(sendOnly))[0]?.capabilities).toEqual(['send'])
  })

  /**
   * The same `mailboxIdentity` the unique index is built on. A citizen that
   * declared `Vireo+colony@AtomicMail.ai` and proved `vireo@atomicmail.ai` has
   * one mailbox, and two comparisons of one pair of addresses disagreeing would
   * be its own defect.
   */
  it('matches the declaration and the proof by mailbox identity, not by string', async () => {
    const agentId = await anAgent()
    await declared(agentId, 'Vireo+colony@AtomicMail.ai')
    await aVerifiedChallenge(agentId, 'vireo@atomicmail.ai')

    await runRepair()

    expect((await mailboxes(agentId))[0]).toMatchObject({ proved: true })
  })

  /** Somebody else's proof is not evidence about this citizen's address. */
  it('does not prove one citizen’s mailbox from another citizen’s challenge', async () => {
    const holder = await anAgent()
    const other = await anAgent()
    await declared(holder, 'shared-name@atomicmail.ai')
    await aVerifiedChallenge(other, 'someone-else@atomicmail.ai')

    await runRepair()

    expect((await mailboxes(holder))[0]).toMatchObject({ proved: false })
  })

  /** An unverified challenge is not a proof, and a declaration is not one either. */
  it('leaves a mailbox with no cleared challenge alone', async () => {
    const agentId = await anAgent()
    await declared(agentId, 'unproven@atomicmail.ai')
    await db.insert(emailChallenges).values({
      agentId,
      address: 'unproven@atomicmail.ai',
      purpose: 'inbox',
      code: 'PENDING1',
      token: `token-pending-${++seeded}`,
      expiresAt: sql`now() + interval '1 hour'`,
      sentAt: sql`now()`,
    })

    await runRepair()

    expect((await mailboxes(agentId))[0]).toMatchObject({ proved: false, capabilities: [] })
  })

  /**
   * It runs once against production and must be safe to run again — the `WHERE`
   * stops matching, and `proved_at` keeps the instant the proof happened rather
   * than sliding forward on each pass.
   */
  it('is idempotent, and keeps the instant the proof happened', async () => {
    const agentId = await anAgent()
    await declared(agentId, 'vireo@atomicmail.ai')
    await aVerifiedChallenge(agentId, 'vireo@atomicmail.ai')

    await runRepair()
    const once = (await mailboxes(agentId))[0]

    await runRepair()

    expect((await mailboxes(agentId))[0]).toEqual(once)
    expect(once?.provedAt).not.toBeNull()
  })
})
