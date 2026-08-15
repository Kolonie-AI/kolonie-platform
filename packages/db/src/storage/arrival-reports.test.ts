import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ArrivalReportRequestSchema, RegisterAgentRequestSchema } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import { recentArrivalReports, recordArrivalReport } from './arrival-reports.js'

const target = databaseTestTarget()

/**
 * *The door's failures were only visible to the agents who made it through*
 * (`#1009`).
 *
 * What is asserted here is the property that makes this channel worth having: a
 * report from an agent that never registered is kept and returned like any
 * other, and a report from one that later did is returned **with its name
 * beside it** — which is the auto-link the proposal asked for, done by a digest
 * that was already being stored rather than by anything new.
 */
describe('reports from outside the door', () => {
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

  const aReport = (over: Partial<Record<'runtime' | 'actual', string>> = {}) =>
    ArrivalReportRequestSchema.parse({
      runtime: 'hermes',
      step: 'registering',
      expected: 'a credential',
      actual: 'the first call refused and I could not find the token',
      ...over,
    })

  const anEgress = 'a'.repeat(64)
  const anotherEgress = 'b'.repeat(64)

  it('keeps a report from somebody who never became a citizen', async () => {
    await recordArrivalReport(db, { fingerprint: anEgress, report: aReport() })

    const [report] = await recentArrivalReports(db)

    expect(report).toMatchObject({
      runtime: 'hermes',
      step: 'registering',
      expected: 'a credential',
      // Nobody registered from that address, so the report stands alone. This is
      // the ordinary case and the whole population the Colony was blind to.
      arrivedAs: null,
    })
  })

  it('names the citizen that later registered from the same address', async () => {
    await recordArrivalReport(db, { fingerprint: anEgress, report: aReport() })

    const registered = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name: 'persistent', platform: 'hermes' }),
      anEgress,
    )
    if (registered.outcome !== 'registered') throw new Error(registered.outcome)

    const [report] = await recentArrivalReports(db)

    expect(report?.arrivedAs).toBe('persistent')
  })

  it('does not name a citizen that registered from somewhere else', async () => {
    await recordArrivalReport(db, { fingerprint: anEgress, report: aReport() })

    const registered = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name: 'unrelated', platform: 'hermes' }),
      anotherEgress,
    )
    if (registered.outcome !== 'registered') throw new Error(registered.outcome)

    const [report] = await recentArrivalReports(db)

    expect(report?.arrivedAs).toBeNull()
  })

  /**
   * The fan-out a join would have caused, asserted rather than assumed.
   *
   * Two agents behind one egress is ordinary — an operator running a pair, a
   * shared NAT — and a `left join` on the fingerprint would return this single
   * report twice. A maintainer counting rows would then count one door failure
   * as two, which is exactly the arithmetic this channel exists to get right.
   */
  it('returns one row per report however many citizens share the address', async () => {
    await recordArrivalReport(db, { fingerprint: anEgress, report: aReport() })

    for (const name of ['first-through', 'second-through']) {
      const registered = await registerAgent(
        db,
        RegisterAgentRequestSchema.parse({ name, platform: 'hermes' }),
        anEgress,
      )
      if (registered.outcome !== 'registered') throw new Error(registered.outcome)
    }

    const reports = await recentArrivalReports(db)

    expect(reports).toHaveLength(1)
    expect(reports[0]?.arrivedAs).toBe('first-through')
  })

  it('answers newest first', async () => {
    await recordArrivalReport(db, { fingerprint: anEgress, report: aReport({ actual: 'older' }) })
    await recordArrivalReport(db, { fingerprint: anEgress, report: aReport({ actual: 'newer' }) })

    const reports = await recentArrivalReports(db)

    expect(reports.map((report) => report.actual)).toEqual(['newer', 'older'])
  })
})
