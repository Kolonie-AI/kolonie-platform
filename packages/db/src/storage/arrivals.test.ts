import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { RegisterAgentRequestSchema, type AccountKind, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import { declareAccount } from './accounts.js'
import { recordOrigin } from './origins.js'
import { findOrCreateHuman } from './humans.js'
import { issueCodeForAgent, redeemCodeAsHuman } from './human-links.js'
import { recentArrivals } from './arrivals.js'

const target = databaseTestTarget()

/**
 * A digest-shaped value. **Never an address**, which is the point of the column
 * it goes in — `origins.test.ts` uses the same device and the same reason.
 */
const digest = (seed: string) => seed.repeat(64).slice(0, 64)

/**
 * Who arrived, with enough on the row to tell one arrival from forty (`#607`).
 *
 * The row used to carry a name, a time and one of two words. What is asserted
 * here is the two properties that make the richer row worth having — it says
 * enough to notice a script, and it says it **without printing anything that
 * names somebody outside the Colony**.
 */
describe('who arrived', () => {
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

  const anAgent = async (name: string): Promise<AgentId> => {
    const result = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name, platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    return result.agent.id
  }

  const aPerson = async (subject: string, email: string | null) => {
    const arrived = await findOrCreateHuman(db, { provider: 'github', subject, email })
    if (arrived.human === undefined) throw new Error('no person')
    return arrived.human.id
  }

  const operate = async (humanId: Awaited<ReturnType<typeof aPerson>>, agentId: AgentId) => {
    const code = await issueCodeForAgent(db, agentId)
    const redeemed = await redeemCodeAsHuman(db, code.code, humanId)
    if (redeemed.outcome !== 'linked') throw new Error(redeemed.outcome)
  }

  it('carries what a name and a timestamp could not say', async () => {
    const agentId = await anAgent('canary')
    await recordOrigin(db, agentId, { fingerprint: digest('a'), country: 'DE', colo: 'FRA' })
    await recordOrigin(db, agentId, { fingerprint: digest('b'), country: 'DE', colo: 'FRA' })
    await declareAccount(db, agentId, {
      kind: 'mailbox' as AccountKind,
      identifier: 'canary@example.org',
    })
    const humanId = await aPerson('gh-1', 'someone@example.org')
    await operate(humanId, agentId)

    const arrivals = await recentArrivals(db)
    const row = arrivals.agents[0]

    expect(row?.name).toBe('canary')
    expect(row?.runtime).toBe('openclaw')
    // Declared on registration when the runtime says so; null when it does not.
    expect(row?.model).toBeNull()
    expect(row?.country).toBe('DE')
    expect(row?.origins).toBe(2)
    expect(row?.operated).toBe(true)
    expect(row?.operatorAgents).toBe(1)
    expect(row?.mailboxDomain).toBe('example.org')
  })

  /**
   * **A domain, never an address.** The reduction happens in SQL, so an address
   * cannot reach a caller even by mistake — which is why this asserts on the
   * whole returned object rather than on one field.
   */
  it('never hands back an address, only a domain', async () => {
    const agentId = await anAgent('canary')
    await declareAccount(db, agentId, {
      kind: 'mailbox' as AccountKind,
      identifier: 'canary@example.org',
    })
    const humanId = await aPerson('gh-1', 'someone@example.org')
    await operate(humanId, agentId)

    const arrivals = await recentArrivals(db)
    const serialised = JSON.stringify(arrivals)

    expect(serialised).not.toContain('canary@example.org')
    expect(serialised).not.toContain('someone@example.org')
    expect(serialised).toContain('example.org')
  })

  /**
   * A handle is not a domain, and a page that guessed would print one. Anything
   * with no `@` in it reduces to nothing rather than to itself.
   */
  it('reduces an identifier that is not an address to nothing', async () => {
    const agentId = await anAgent('canary')
    await declareAccount(db, agentId, { kind: 'github' as AccountKind, identifier: 'some-handle' })

    const arrivals = await recentArrivals(db)

    expect(arrivals.agents[0]?.mailboxDomain).toBeNull()
  })

  /**
   * **The swarm signal `#510` built.** One operator behind several accounts is
   * the shape this section exists to notice, and the count is across the whole
   * Colony rather than across the twenty rows shown — counting only the page
   * would hide exactly the case it is for.
   */
  it('says how many agents share one operator', async () => {
    const humanId = await aPerson('gh-1', null)
    for (const name of ['one', 'two', 'three']) await operate(humanId, await anAgent(name))

    const arrivals = await recentArrivals(db)

    expect(arrivals.agents).toHaveLength(3)
    for (const row of arrivals.agents) expect(row.operatorAgents).toBe(3)
    // One key for the three, so a page can group them without naming anybody.
    expect(new Set(arrivals.agents.map((row) => row.operatorKey)).size).toBe(1)
  })

  it('groups arrivals that share an origin', async () => {
    const together = digest('c')
    for (const name of ['one', 'two']) {
      await recordOrigin(db, await anAgent(name), {
        fingerprint: together,
        country: 'DE',
        colo: 'FRA',
      })
    }
    await recordOrigin(db, await anAgent('three'), {
      fingerprint: digest('d'),
      country: 'DE',
      colo: 'FRA',
    })

    const arrivals = await recentArrivals(db)
    const keys = arrivals.agents.map((row) => row.originKey)

    expect(new Set(keys).size).toBe(2)
    expect(keys.filter((key) => key === together)).toHaveLength(2)
  })

  it('lists people as well as agents, newest first', async () => {
    await aPerson('gh-1', 'first@example.org')
    await aPerson('gh-2', null)

    const arrivals = await recentArrivals(db)

    expect(arrivals.people).toHaveLength(2)
    expect(arrivals.people[0]?.provider).toBe('github')
    // `readProfile` refuses an unverified address, so absent is informative.
    expect(arrivals.people[0]?.addressKnown).toBe(false)
    expect(arrivals.people[1]?.addressKnown).toBe(true)
    expect(arrivals.people[1]?.emailDomain).toBe('example.org')
  })

  it('says how many agents a person operates', async () => {
    const humanId = await aPerson('gh-1', null)
    await operate(humanId, await anAgent('one'))
    await operate(humanId, await anAgent('two'))

    const arrivals = await recentArrivals(db)

    expect(arrivals.people[0]?.agentsOperated).toBe(2)
  })

  /**
   * **No score, no flag, no ranking** — `#607` names all three. The rows are
   * facts and a person draws the conclusion; a computed *likely fake* would be
   * acted on without anybody having looked.
   */
  it('computes no score, flag or ranking', async () => {
    const agentId = await anAgent('canary')
    await recordOrigin(db, agentId, { fingerprint: digest('a'), country: 'DE', colo: 'FRA' })

    const arrivals = await recentArrivals(db)
    const fields = Object.keys(arrivals.agents[0] ?? {})

    for (const forbidden of ['score', 'risk', 'suspicion', 'rank', 'flag', 'likely']) {
      expect(fields.some((field) => field.toLowerCase().includes(forbidden))).toBe(false)
    }
  })

  it('answers with empty lists rather than failing when nobody has arrived', async () => {
    const arrivals = await recentArrivals(db)

    expect(arrivals.agents).toEqual([])
    expect(arrivals.people).toEqual([])
    expect(arrivals.computedAt).toBeTypeOf('string')
  })
})
