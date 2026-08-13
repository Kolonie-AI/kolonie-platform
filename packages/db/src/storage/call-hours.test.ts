import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  CALL_HOUR_RETENTION_DAYS,
  RegisterAgentRequestSchema,
  UNROUTED_ROUTE_KEY,
  type AgentId,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agentCallHours } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import { callHoursSince, recordCall, sweepCallHours, type ObservedCall } from './call-hours.js'

const target = databaseTestTarget()

/** Two moments inside one hour, and one in the next. */
const AT = new Date('2026-08-13T09:15:00.000Z')
const LATER_SAME_HOUR = new Date('2026-08-13T09:47:30.000Z')
const NEXT_HOUR = new Date('2026-08-13T10:02:00.000Z')

const aCall = (overrides: Partial<ObservedCall> = {}): ObservedCall => ({
  routeKey: '/v1/tasks/:taskId',
  status: 200,
  bytesOut: 1_024,
  at: AT,
  ...overrides,
})

/**
 * The hourly call rollup (`#835`): what each citizen actually called, per route
 * and per hour, without keeping a request log.
 *
 * The tests below are written against the two properties the table exists for —
 * that a call is a counter increment rather than a row, and that a resolved path
 * cannot become one — because those are the two that would fail silently. A
 * rollup that quietly became a request log would still answer every question
 * asked of it, correctly, while holding something nobody agreed to hold.
 */
describe('the hourly call rollup', () => {
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

  const rowsFor = async (agentId: AgentId) =>
    await db.select().from(agentCallHours).where(eq(agentCallHours.agentId, agentId))

  it('opens a bucket on the first call to a route in an hour', async () => {
    const agentId = await anAgent()

    expect(await recordCall(db, agentId, aCall())).toBe('opened')

    const [row] = await rowsFor(agentId)
    expect(row?.routeKey).toBe('/v1/tasks/:taskId')
    expect(row?.calls).toBe(1)
    expect(row?.bytesOut).toBe(1_024)
    expect(row?.maxBytesOut).toBe(1_024)
    expect(row?.ok).toBe(1)
    expect(row?.hourStartedAt).toContain('09:00:00')
  })

  /**
   * The whole point of the table. A citizen calling one route ten thousand times
   * in an hour is one row and a counter — anything else is the per-request trace
   * the observed-origins table refused for place, made again for time.
   *
   * (Named in prose rather than by its symbol on purpose: `origins.test.ts`
   * asserts mechanically that no storage module outside a short allow-list
   * references that table, and a citation in a comment is not the kind of
   * reference the rule was written to catch — but widening the list to admit one
   * would make the next widening easier to argue for.)
   */
  it('counts a second call in the same hour onto the same row', async () => {
    const agentId = await anAgent()

    await recordCall(db, agentId, aCall())
    expect(await recordCall(db, agentId, aCall({ at: LATER_SAME_HOUR }))).toBe('counted')

    const rows = await rowsFor(agentId)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.calls).toBe(2)
    expect(rows[0]?.bytesOut).toBe(2_048)
  })

  it('opens a second row for the next hour', async () => {
    const agentId = await anAgent()

    await recordCall(db, agentId, aCall())
    expect(await recordCall(db, agentId, aCall({ at: NEXT_HOUR }))).toBe('opened')

    expect(await rowsFor(agentId)).toHaveLength(2)
  })

  /**
   * **The rejection case this table is shaped by.** Two calls that differ only
   * in a path parameter are one row, because the key is the route *template*. A
   * writer that passed the resolved URL through would produce two rows here, and
   * this is the assertion that would fail — which is the only reason the seams
   * in `apps/api` can be trusted to be passing templates.
   */
  it('lands two calls with different path parameters on one row', async () => {
    const agentId = await anAgent()

    await recordCall(db, agentId, aCall())
    await recordCall(db, agentId, aCall({ at: LATER_SAME_HOUR }))

    const rows = await rowsFor(agentId)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.routeKey).toBe('/v1/tasks/:taskId')
    expect(rows[0]?.calls).toBe(2)
  })

  /**
   * A stranger must not be able to choose this table's cardinality. Every
   * request that matched no route lands in one bucket, however many different
   * paths were invented.
   */
  it('collects every unrouted request into one bucket', async () => {
    const agentId = await anAgent()

    await recordCall(db, agentId, aCall({ routeKey: UNROUTED_ROUTE_KEY, status: 404 }))
    await recordCall(
      db,
      agentId,
      aCall({ routeKey: UNROUTED_ROUTE_KEY, status: 404, at: LATER_SAME_HOUR }),
    )

    const rows = await rowsFor(agentId)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.routeKey).toBe(UNROUTED_ROUTE_KEY)
    expect(rows[0]?.calls).toBe(2)
    expect(rows[0]?.clientErrors).toBe(2)
    expect(rows[0]?.ok).toBe(0)
  })

  it('holds the largest single response rather than the last one', async () => {
    const agentId = await anAgent()

    await recordCall(db, agentId, aCall({ bytesOut: 5_000_000 }))
    await recordCall(db, agentId, aCall({ bytesOut: 12, at: LATER_SAME_HOUR }))

    const [row] = await rowsFor(agentId)
    expect(row?.maxBytesOut).toBe(5_000_000)
    expect(row?.bytesOut).toBe(5_000_012)
  })

  /**
   * The two error classes are counted apart because they say opposite things
   * about whose problem it is: a 4xx is the citizen doing something wrong, and a
   * 5xx is the Colony's own defect.
   */
  it('counts a 4xx and a 5xx into different columns, and neither into ok', async () => {
    const agentId = await anAgent()

    await recordCall(db, agentId, aCall({ status: 422 }))
    await recordCall(db, agentId, aCall({ status: 503, at: LATER_SAME_HOUR }))

    const [row] = await rowsFor(agentId)
    expect(row?.clientErrors).toBe(1)
    expect(row?.serverErrors).toBe(1)
    expect(row?.ok).toBe(0)
    expect(row?.calls).toBe(2)
  })

  it('keeps the first stamp and moves the last one', async () => {
    const agentId = await anAgent()

    await recordCall(db, agentId, aCall())
    await recordCall(db, agentId, aCall({ at: LATER_SAME_HOUR }))

    const [row] = await rowsFor(agentId)
    expect(row?.firstAt).toContain('09:15:00')
    expect(row?.lastAt).toContain('09:47:30')
  })

  /**
   * A call arriving milliseconds out of order under concurrency must not move
   * `last_at` backwards — the stamp is the latest moment seen, not the latest
   * write.
   */
  it('does not move the last stamp backwards', async () => {
    const agentId = await anAgent()

    await recordCall(db, agentId, aCall({ at: LATER_SAME_HOUR }))
    await recordCall(db, agentId, aCall({ at: AT }))

    const [row] = await rowsFor(agentId)
    expect(row?.lastAt).toContain('09:47:30')
  })

  it('separates two citizens calling the same route in the same hour', async () => {
    const one = await anAgent('one')
    const two = await anAgent('two')

    await recordCall(db, one, aCall())
    await recordCall(db, two, aCall())

    expect(await rowsFor(one)).toHaveLength(1)
    expect(await rowsFor(two)).toHaveLength(1)
  })

  describe('reading a citizen’s own hours', () => {
    it('returns only the caller’s rows, newest first', async () => {
      const one = await anAgent('one')
      const two = await anAgent('two')

      await recordCall(db, one, aCall())
      await recordCall(db, one, aCall({ at: NEXT_HOUR }))
      await recordCall(db, two, aCall({ routeKey: '/v1/agents/me' }))

      const hours = await callHoursSince(db, one, new Date('2026-08-13T00:00:00.000Z'))

      expect(hours).toHaveLength(2)
      expect(hours[0]?.hourStartedAt).toContain('10:00:00')
      expect(hours.every((hour) => hour.routeKey === '/v1/tasks/:taskId')).toBe(true)
    })

    it('excludes buckets before the window', async () => {
      const agentId = await anAgent()

      await recordCall(db, agentId, aCall())
      await recordCall(db, agentId, aCall({ at: NEXT_HOUR }))

      const hours = await callHoursSince(db, agentId, new Date('2026-08-13T10:00:00.000Z'))

      expect(hours).toHaveLength(1)
      expect(hours[0]?.hourStartedAt).toContain('10:00:00')
    })

    /**
     * Absence of evidence is an answer, not a failure. A brand-new citizen has
     * made no calls, and a read that threw for it would make *nothing to say*
     * indistinguishable from *something went wrong*.
     */
    it('answers with nothing for a citizen that has called nothing', async () => {
      const agentId = await anAgent()

      expect(await callHoursSince(db, agentId, new Date('2026-08-13T00:00:00.000Z'))).toEqual([])
    })
  })

  describe('the retention sweep', () => {
    const dayssAgo = (from: Date, days: number) =>
      new Date(from.getTime() - days * 24 * 60 * 60 * 1000)

    it('deletes buckets older than the window and keeps the rest', async () => {
      const agentId = await anAgent()
      const now = new Date('2026-09-30T12:00:00.000Z')

      await recordCall(db, agentId, aCall({ at: dayssAgo(now, CALL_HOUR_RETENTION_DAYS + 1) }))
      await recordCall(db, agentId, aCall({ at: dayssAgo(now, 1) }))

      expect(await sweepCallHours(db, now)).toBe(1)

      const rows = await rowsFor(agentId)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.hourStartedAt).toContain('2026-09-29')
    })

    /**
     * The boundary is tested rather than assumed: a bucket exactly at the window
     * is inside it. Thirty-five days means the thirty-fifth day still answers.
     */
    it('keeps a bucket that is exactly at the window', async () => {
      const agentId = await anAgent()
      const now = new Date('2026-09-30T12:00:00.000Z')

      await recordCall(db, agentId, aCall({ at: dayssAgo(now, CALL_HOUR_RETENTION_DAYS) }))

      expect(await sweepCallHours(db, now)).toBe(0)
      expect(await rowsFor(agentId)).toHaveLength(1)
    })

    it('sweeps nothing on an empty table without complaining', async () => {
      expect(await sweepCallHours(db, new Date('2026-09-30T12:00:00.000Z'))).toBe(0)
    })
  })

  /**
   * **The rule this whole path is built on**, stated as a test rather than as a
   * comment: a write that cannot happen leaves the citizen's request alone. A
   * citizen id that names nobody violates the foreign key, which is as close as
   * this function gets to a failure that is not the database being down.
   */
  it('never throws when the write cannot happen', async () => {
    const stranger = '00000000-0000-4000-8000-000000000000' as AgentId

    expect(await recordCall(db, stranger, aCall())).toBe('failed')
  })
})
