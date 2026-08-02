import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { AgentIdSchema, RegisterAgentRequestSchema, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agentContacts } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import { authenticateApiKey } from './authentication.js'
import { contactGaps, lastContactAt, pruneContactHistory, recordContact } from './contacts.js'

const target = databaseTestTarget()

/**
 * The contact record (#141): when a citizen was here, bucketed, bounded, and
 * incapable of failing the call that produced it.
 */
describe('the contact record', () => {
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

  const anAgentWithAKey = async (name = 'canary') => {
    const result = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name, platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    return result
  }

  const contactRows = async (agentId: AgentId) => {
    const rows = await db.execute<{ bucket_start: string; recorded_at: string }>(
      sql`select bucket_start, recorded_at from agent_contacts
           where agent_id = ${agentId} order by bucket_start desc`,
    )
    return rows
  }

  /**
   * Write a contact by hand, so far in the past that no bucket arithmetic could
   * have produced it. Everything about gaps, retention and ordering needs a
   * history the test controls; `recordContact` can only ever write *now*.
   */
  const contactedHoursAgo = async (agentId: AgentId, hours: number) => {
    await db.execute(
      sql`insert into agent_contacts (agent_id, bucket_start, recorded_at)
          values (${agentId},
                  date_trunc('hour', now() - ${`${hours} hours`}::interval),
                  now() - ${`${hours} hours`}::interval)`,
    )
  }

  describe('recording', () => {
    it('writes one row the first time a citizen is in contact', async () => {
      const { agent } = await anAgentWithAKey()

      expect(await recordContact(db, agent.id)).toBe('recorded')
      expect(await contactRows(agent.id)).toHaveLength(1)
    })

    it('writes one row however many calls arrive inside one bucket', async () => {
      const { agent } = await anAgentWithAKey()

      const outcomes = []
      for (let i = 0; i < 12; i++) outcomes.push(await recordContact(db, agent.id))

      // The property the whole shape of this table exists for: an agent doing a
      // rung makes dozens of calls in a minute and they are all the same fact.
      expect(await contactRows(agent.id)).toHaveLength(1)
      expect(outcomes[0]).toBe('recorded')
      expect(outcomes.slice(1).every((outcome) => outcome === 'already-in-bucket')).toBe(true)
    })

    it('keeps one citizen’s contact out of another’s', async () => {
      const first = await anAgentWithAKey('canary-one')
      const second = await anAgentWithAKey('canary-two')

      await recordContact(db, first.agent.id)

      expect(await contactRows(first.agent.id)).toHaveLength(1)
      expect(await contactRows(second.agent.id)).toHaveLength(0)
    })

    // The rejection case. A foreign key violation is a real database failure and
    // the cheapest one to provoke; what matters is that it comes back as an
    // outcome rather than as a throw.
    it('reports a failure instead of raising one', async () => {
      const noSuchAgent = AgentIdSchema.parse(randomUUID())

      await expect(recordContact(db, noSuchAgent)).resolves.toBe('failed')
    })
  })

  describe('the authenticated call is the one code path', () => {
    it('records contact when a key resolves to its agent', async () => {
      const registered = await anAgentWithAKey()

      await authenticateApiKey(db, registered.credentials.apiKey)

      expect(await contactRows(registered.agent.id)).toHaveLength(1)
    })

    it('records nothing for a caller that did not authenticate', async () => {
      await anAgentWithAKey()

      await authenticateApiKey(db, 'kol_sk_nothing-that-was-ever-issued')

      // `about`, `register` and the name check have no citizen to attribute
      // anything to, and this is the same fact one layer down.
      const rows = await db.execute<{ count: string }>(
        sql`select count(*)::text as count from agent_contacts`,
      )
      expect(Number(rows[0]!.count)).toBe(0)
    })

    it('records nothing for a revoked key', async () => {
      const registered = await anAgentWithAKey()
      await db.execute(
        sql`update credentials set revoked_at = now() where agent_id = ${registered.agent.id}`,
      )

      const result = await authenticateApiKey(db, registered.credentials.apiKey)

      expect(result.outcome).toBe('revoked')
      expect(await contactRows(registered.agent.id)).toHaveLength(0)
    })

    /**
     * The promise the whole design turns on: instrumentation that can refuse a
     * citizen its rung is worse than no instrumentation.
     *
     * The table is renamed out from under the recorder rather than mocked, so
     * what is being tested is the real statement failing the way a real outage
     * would — and the citizen still gets authenticated.
     */
    it('authenticates the citizen even when recording is impossible', async () => {
      const registered = await anAgentWithAKey()
      await db.execute(sql`alter table agent_contacts rename to agent_contacts_hidden`)

      try {
        const result = await authenticateApiKey(db, registered.credentials.apiKey)

        expect(result.outcome).toBe('authenticated')
        if (result.outcome !== 'authenticated') return
        expect(result.agent.id).toBe(registered.agent.id)
      } finally {
        await db.execute(sql`alter table agent_contacts_hidden rename to agent_contacts`)
      }
    })
  })

  describe('when was this citizen last in contact', () => {
    it('answers null for a citizen that has never been recorded', async () => {
      const { agent } = await anAgentWithAKey()

      expect(await lastContactAt(db, agent.id)).toBeNull()
    })

    it('answers with the newest contact', async () => {
      const { agent } = await anAgentWithAKey()
      await contactedHoursAgo(agent.id, 50)
      await contactedHoursAgo(agent.id, 3)
      await contactedHoursAgo(agent.id, 26)

      const last = await lastContactAt(db, agent.id)

      const hoursAgo = (Date.now() - Date.parse(last!)) / 3_600_000
      expect(hoursAgo).toBeGreaterThan(2.9)
      expect(hoursAgo).toBeLessThan(3.1)
    })
  })

  describe('what were the gaps', () => {
    it('has none for a citizen that has been here once', async () => {
      const { agent } = await anAgentWithAKey()
      await recordContact(db, agent.id)

      expect(await contactGaps(db, agent.id, 10)).toEqual([])
    })

    it('measures the distances between consecutive contacts, newest first', async () => {
      const { agent } = await anAgentWithAKey()
      for (const hours of [36, 24, 12, 1]) await contactedHoursAgo(agent.id, hours)

      const gaps = await contactGaps(db, agent.id, 10)

      expect(gaps).toHaveLength(3)
      expect(gaps.map((gap) => Math.round(gap.hours))).toEqual([11, 12, 12])
      // Newest first, and each gap runs forwards in time.
      expect(Date.parse(gaps[0]!.to)).toBeGreaterThan(Date.parse(gaps[0]!.from))
      expect(Date.parse(gaps[0]!.to)).toBeGreaterThan(Date.parse(gaps[1]!.to))
    })

    it('looks no further back than it was asked to', async () => {
      const { agent } = await anAgentWithAKey()
      for (const hours of [80, 60, 40, 20, 2]) await contactedHoursAgo(agent.id, hours)

      // n contacts yield at most n − 1 gaps, which is the arithmetic #143 reads
      // when it asks for two intervals.
      expect(await contactGaps(db, agent.id, 3)).toHaveLength(2)
      expect(await contactGaps(db, agent.id, 1)).toEqual([])
    })
  })

  describe('the retention bound', () => {
    it('deletes what is past it and keeps what is not', async () => {
      const { agent } = await anAgentWithAKey()
      await contactedHoursAgo(agent.id, 24 * 40)
      await contactedHoursAgo(agent.id, 24 * 31)
      await contactedHoursAgo(agent.id, 24 * 29)
      await contactedHoursAgo(agent.id, 2)

      expect(await pruneContactHistory(db)).toBe(2)

      const left = await contactRows(agent.id)
      expect(left).toHaveLength(2)
      for (const row of left) {
        const daysAgo = (Date.now() - Date.parse(row.recorded_at)) / 86_400_000
        expect(daysAgo).toBeLessThan(30)
      }
    })

    it('prunes across citizens in one pass and reports nothing to do', async () => {
      const first = await anAgentWithAKey('canary-one')
      const second = await anAgentWithAKey('canary-two')
      await contactedHoursAgo(first.agent.id, 24 * 45)
      await contactedHoursAgo(second.agent.id, 24 * 45)

      expect(await pruneContactHistory(db)).toBe(2)
      expect(await pruneContactHistory(db)).toBe(0)
    })
  })

  it('goes with the citizen', async () => {
    const { agent } = await anAgentWithAKey()
    await recordContact(db, agent.id)

    await db.execute(sql`delete from agents where id = ${agent.id}`)

    const rows = await db.select().from(agentContacts)
    expect(rows).toEqual([])
  })
})
