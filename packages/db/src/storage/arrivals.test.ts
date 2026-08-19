import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
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

  /**
   * *A citizen was created and lost in the same second, and nobody counted it*
   * (`#876`).
   *
   * The signal is `agent_origins`, which `observing` writes on every successful
   * authentication — so no row there is a citizen that has never made one. The
   * property being asserted is that the two states are actually distinguishable,
   * which before this they were not from anywhere.
   */
  describe('accounts that registered and never authenticated', () => {
    it('counts an agent that has never been observed calling', async () => {
      await anAgent('fermata')

      const arrivals = await recentArrivals(db)

      expect(arrivals.unconfirmed.total).toBe(1)
      expect(arrivals.unconfirmed.oldest[0]?.name).toBe('fermata')
      expect(arrivals.unconfirmed.oldest[0]?.hoursSince).toBe(0)
    })

    /**
     * The rejection case: an agent that authenticated is not in this list. It is
     * the half that decides whether the count means anything — a number that
     * included everybody would go up forever and be ignored within a week.
     */
    it('drops an agent as soon as it has authenticated once', async () => {
      const agentId = await anAgent('canary')
      await recordOrigin(db, agentId, { fingerprint: digest('a'), country: 'DE', colo: 'FRA' })

      const arrivals = await recentArrivals(db)

      expect(arrivals.unconfirmed.total).toBe(0)
      expect(arrivals.unconfirmed.oldest).toEqual([])
    })

    it('separates the two when both are present', async () => {
      const called = await anAgent('spoke')
      await recordOrigin(db, called, { fingerprint: digest('b'), country: null, colo: null })
      await anAgent('silent')

      const arrivals = await recentArrivals(db)

      expect(arrivals.unconfirmed.total).toBe(1)
      expect(arrivals.unconfirmed.oldest.map((row) => row.name)).toEqual(['silent'])
    })

    /**
     * **Oldest first, and the total is over every account rather than the page.**
     * One account silent for a month is the finding; twenty listed newest-first
     * would bury it under this morning's arrivals, and a total taken over the
     * rows shown would hide exactly the case worth noticing.
     */
    it('lists the oldest first and counts beyond the rows it shows', async () => {
      for (const name of ['first', 'second', 'third']) await anAgent(name)

      const arrivals = await recentArrivals(db, 2)

      expect(arrivals.unconfirmed.total).toBe(3)
      expect(arrivals.unconfirmed.oldest.map((row) => row.name)).toEqual(['first', 'second'])
    })

    /**
     * **The blind spot, which was measured in production before this shipped.**
     * `agent_origins` has been written since 2026-08-03 and the first citizen
     * registered on 2026-07-28, so the naive question answered *11 of 26 have
     * never authenticated* — ten of them older than the record, two of those
     * holding skills nobody earns without authenticating. The count was nine
     * parts false positive.
     *
     * An account that predates the first observation is therefore not counted as
     * silent. It is not dropped either: it is reported separately, because a
     * page that quietly excluded it would read as *we checked all of them*, which
     * is the same shape of wrong as the count that included it.
     */
    it('does not call an account silent when it is older than the record', async () => {
      const before = await anAgent('ancient')
      await db.execute(
        sql`update agents set created_at = now() - interval '20 days' where id = ${before}`,
      )
      const observed = await anAgent('observed')
      await recordOrigin(db, observed, { fingerprint: digest('c'), country: null, colo: null })
      await anAgent('actually-silent')

      const arrivals = await recentArrivals(db)

      expect(arrivals.unconfirmed.total).toBe(1)
      expect(arrivals.unconfirmed.oldest.map((row) => row.name)).toEqual(['actually-silent'])
      expect(arrivals.unconfirmed.unmeasurable).toBe(1)
    })

    /**
     * **A Colony nobody has called yet counts everybody**, and that is the right
     * default rather than an oversight: an empty origins table on day one is
     * ordinary, and a cutoff that answered *nothing can be measured* would make
     * the section useless exactly when a broken deployment looks like this.
     */
    it('counts every account when nothing has ever been observed', async () => {
      await anAgent('one')
      await anAgent('two')

      const arrivals = await recentArrivals(db)

      expect(arrivals.unconfirmed.total).toBe(2)
      expect(arrivals.unconfirmed.unmeasurable).toBe(0)
    })
  })
})

/**
 * The four columns `/backend/arrivals` could not answer without being left
 * (`#1270`). All four were already stored; they were simply never selected.
 */
describe('what an arrival is, beyond how it arrived', () => {
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

  /** Straight into the event log, because what is read here is `sum(delta)`. */
  const award = async (agentId: AgentId, delta: number): Promise<void> => {
    await db.execute(
      sql`insert into reputation_events (agent_id, delta, reason)
          values (${agentId}, ${delta}, 'task_passed')`,
    )
  }

  it('reads last online, status and reputation off the agent that arrived', async () => {
    const agentId = await anAgent('canary')
    await recordOrigin(db, agentId, { fingerprint: digest('a'), country: 'DE', colo: 'FRA' })
    await db.execute(
      sql`update agents set last_seen_at = now(), status = 'citizen' where id = ${agentId}`,
    )
    await award(agentId, 3)
    await award(agentId, 4)

    const row = (await recentArrivals(db)).agents[0]

    expect(row?.lastSeenAt).not.toBeNull()
    expect(row?.status).toBe('citizen')
    // `sum(delta)`, not a count of events.
    expect(row?.reputation).toBe(7)
  })

  /**
   * The Johanna Wagner shape: registered, never authenticated, no operator. All
   * four answers are on the row, so confirming it needs no second page.
   */
  it('answers never, candidate and zero for an account that never came back', async () => {
    await anAgent('Johanna Wagner')

    const row = (await recentArrivals(db)).agents[0]

    expect(row?.lastSeenAt).toBeNull()
    expect(row?.status).toBe('candidate')
    // Zero and not null: nothing earned is a measured fact.
    expect(row?.reputation).toBe(0)
    expect(row?.calls).toBe(0)
  })

  /**
   * **`agents.last_seen_at` and not the origins rollup.** The two can disagree —
   * an origin is per fingerprint — and every other surface means the column.
   */
  it('takes last online from the agents column rather than from an origin', async () => {
    const agentId = await anAgent('canary')
    await recordOrigin(db, agentId, { fingerprint: digest('a'), country: 'DE', colo: 'FRA' })

    const row = (await recentArrivals(db)).agents[0]

    // `recordOrigin` wrote an origin and did not touch `last_seen_at`, so this
    // is `never` beside a call count — which is the divergence the two columns
    // exist to keep visible rather than collapse.
    expect(row?.lastSeenAt).toBeNull()
    expect(row?.calls).toBeGreaterThan(0)
  })

  it('carries status and reputation into the unconfirmed table too', async () => {
    // An origin first, so the record begins before `fermata` registers: the
    // question is only asked of accounts younger than the first observation
    // the Colony ever made, and one registered before it is `unmeasurable`.
    const other = await anAgent('observed')
    await recordOrigin(db, other, { fingerprint: digest('b'), country: 'DE', colo: 'FRA' })
    const agentId = await anAgent('fermata')
    await award(agentId, 2)

    const row = (await recentArrivals(db)).unconfirmed.oldest.find((one) => one.name === 'fermata')

    expect(row?.status).toBe('candidate')
    expect(row?.reputation).toBe(2)
  })

  /** Ordering is registration order and nothing here may touch it. */
  it('does not reorder by reputation or by status', async () => {
    const first = await anAgent('older')
    await award(first, 50)
    const second = await anAgent('newer')
    await db.execute(sql`update agents set status = 'suspended' where id = ${second}`)

    const names = (await recentArrivals(db)).agents.map((row) => row.name)

    expect(names).toEqual(['newer', 'older'])
  })
})
