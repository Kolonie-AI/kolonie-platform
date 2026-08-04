import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import {
  AccountKindSchema,
  RegisterAgentRequestSchema,
  type AccountKind,
  type AgentId,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import { declareAccount } from './accounts.js'
import { providerReportTallies, reportProvider } from './provider-reports.js'

const target = databaseTestTarget()
const MAILBOX = AccountKindSchema.parse('mailbox') as AccountKind

describe('providers that produced no account', () => {
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
      RegisterAgentRequestSchema.parse({ name: `reporting-${++seeded}`, platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    return result.agent.id
  }

  it('records a report and counts it', async () => {
    await reportProvider(db, await anAgent(), {
      kind: MAILBOX,
      provider: 'disroot.org',
      outcome: 'signup-refused',
    })

    expect(await providerReportTallies(db)).toEqual([
      {
        kind: 'mailbox',
        provider: 'disroot.org',
        outcome: 'signup-refused',
        citizens: 1,
        experienced: 0,
      },
    ])
  })

  /**
   * The property that makes the published number a count of citizens rather
   * than of writes. Without it one agent could report the same wall a hundred
   * times and the aggregate would say a hundred citizens hit it.
   */
  it('counts one citizen once, however many times it writes', async () => {
    const agentId = await anAgent()
    for (const outcome of ['abandoned', 'never-provisioned', 'signup-refused'] as const) {
      await reportProvider(db, agentId, { kind: MAILBOX, provider: 'offilive.com', outcome })
    }

    const tallies = await providerReportTallies(db)

    expect(tallies).toHaveLength(1)
    expect(tallies[0]).toMatchObject({ outcome: 'signup-refused', citizens: 1 })
  })

  it('withdraws a report on null, which is how a citizen that got in corrects it', async () => {
    const agentId = await anAgent()
    await reportProvider(db, agentId, {
      kind: MAILBOX,
      provider: 'offilive.com',
      outcome: 'never-provisioned',
    })

    const withdrawn = await reportProvider(db, agentId, {
      kind: MAILBOX,
      provider: 'offilive.com',
      outcome: null,
    })

    expect(withdrawn).toEqual({ outcome: 'withdrawn' })
    expect(await providerReportTallies(db)).toEqual([])
  })

  it('keeps the three outcomes apart, because they cost an agent different amounts', async () => {
    await reportProvider(db, await anAgent(), {
      kind: MAILBOX,
      provider: 'somewhere.example',
      outcome: 'signup-refused',
    })
    await reportProvider(db, await anAgent(), {
      kind: MAILBOX,
      provider: 'somewhere.example',
      outcome: 'never-provisioned',
    })

    const tallies = await providerReportTallies(db)

    expect(tallies).toHaveLength(2)
    expect(tallies.map((tally) => tally.outcome).sort()).toEqual([
      'never-provisioned',
      'signup-refused',
    ])
  })

  /**
   * The weighting the proposal asked for against its own interest: a wall
   * reported by citizens that hold verified accounts elsewhere is a wall, and
   * one reported only by citizens holding nothing may be a runtime.
   */
  it('says how many reporters hold a verified account of the kind somewhere', async () => {
    const experienced = await anAgent()
    const novice = await anAgent()

    await declareAccount(db, experienced, {
      kind: MAILBOX,
      identifier: 'somebody@elsewhere.example',
      provider: 'elsewhere.example',
    })
    // Proving is the verifier's job; this test is about the aggregate reading it.
    await db.execute(sql`update accounts set proved = true, proved_at = now()`)

    for (const agentId of [experienced, novice]) {
      await reportProvider(db, agentId, {
        kind: MAILBOX,
        provider: 'agmail.ai',
        outcome: 'never-provisioned',
      })
    }

    expect(await providerReportTallies(db)).toEqual([
      {
        kind: 'mailbox',
        provider: 'agmail.ai',
        outcome: 'never-provisioned',
        citizens: 2,
        experienced: 1,
      },
    ])
  })

  it('narrows to one kind when asked', async () => {
    const agentId = await anAgent()
    await reportProvider(db, agentId, {
      kind: MAILBOX,
      provider: 'somewhere.example',
      outcome: 'abandoned',
    })
    await reportProvider(db, agentId, {
      kind: AccountKindSchema.parse('domain') as AccountKind,
      provider: 'elsewhere.example',
      outcome: 'abandoned',
    })

    expect(await providerReportTallies(db, MAILBOX)).toHaveLength(1)
    expect(await providerReportTallies(db)).toHaveLength(2)
  })

  it('names no citizen anywhere in what it publishes', async () => {
    const agentId = await anAgent()
    await reportProvider(db, agentId, {
      kind: MAILBOX,
      provider: 'disroot.org',
      outcome: 'signup-refused',
    })

    expect(JSON.stringify(await providerReportTallies(db))).not.toContain(agentId)
  })

  it('goes when its author does', async () => {
    const agentId = await anAgent()
    await reportProvider(db, agentId, {
      kind: MAILBOX,
      provider: 'disroot.org',
      outcome: 'signup-refused',
    })

    await db.execute(sql`delete from agents where id = ${agentId}`)

    expect(await providerReportTallies(db)).toEqual([])
  })
})
