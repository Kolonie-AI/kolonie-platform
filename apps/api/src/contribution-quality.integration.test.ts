import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  ABUSIVE_WARN_MIN_COUNT,
  abusiveQualityWarningLine,
  type AgentId,
} from '@kolonie-ai/core'
import {
  agents,
  contributionVerdicts,
  insertContributionVerdict,
  markAbusiveQualityWarned,
  registerAgent,
  type Database,
} from '@kolonie-ai/db'
// Test helpers are package-private — imported by path so this file can drive a
// real database without exporting them from `@kolonie-ai/db`.
import {
  connectForTests,
  databaseTestTarget,
  truncateAll,
} from '../../packages/db/src/testing.js'
import { databaseContributionQuality } from './contribution-quality.js'

/**
 * `warningFor` against a real database (`#1262`).
 *
 * Fires at two abusive verdicts not one; stamps only when it returns a line;
 * stays quiet inside the weekly cooldown. Complements the storage and core
 * unit tests that cover the pieces this composes.
 */
describe('contribution-quality warningFor (database)', () => {
  const target = databaseTestTarget()
  let db: Database
  const now = new Date('2026-08-18T12:00:00.000Z')

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
    const registered = await registerAgent(db, {
      name,
      platform: 'openclaw',
      operator: null,
    })
    if (registered.outcome !== 'registered') throw new Error(`could not register ${name}`)
    return registered.agent.id
  }

  const seedAbusive = async (agentId: AgentId, count: number) => {
    for (let i = 0; i < count; i++) {
      await insertContributionVerdict(db, {
        agentId,
        surface: 'walk-report',
        verdict: 'abusive',
        reason: `Abusive sample ${i}`,
      })
    }
    await db
      .update(contributionVerdicts)
      .set({ decidedAt: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString() })
      .where(eq(contributionVerdicts.agentId, agentId))
  }

  it(`stays quiet below ${ABUSIVE_WARN_MIN_COUNT} abusive verdicts`, async () => {
    const agentId = await anAgent('warn-one')
    await seedAbusive(agentId, ABUSIVE_WARN_MIN_COUNT - 1)
    const quality = databaseContributionQuality(db)

    expect(await quality.warningFor(agentId, now)).toBeNull()
    const [row] = await db
      .select({ at: agents.abusiveQualityWarnedAt })
      .from(agents)
      .where(eq(agents.id, agentId))
    expect(row?.at).toBeNull()
  })

  it(`fires at ${ABUSIVE_WARN_MIN_COUNT} abusive verdicts and stamps once`, async () => {
    const agentId = await anAgent('warn-two')
    await seedAbusive(agentId, ABUSIVE_WARN_MIN_COUNT)
    const quality = databaseContributionQuality(db)

    const line = await quality.warningFor(agentId, now)
    expect(line).toBe(
      abusiveQualityWarningLine({ abusive: ABUSIVE_WARN_MIN_COUNT, total: ABUSIVE_WARN_MIN_COUNT }),
    )
    expect(line).toContain('kolonie.contributions.quality')

    const [row] = await db
      .select({ at: agents.abusiveQualityWarnedAt })
      .from(agents)
      .where(eq(agents.id, agentId))
    expect(row?.at).not.toBeNull()
    expect(new Date(row!.at!).getTime()).toBe(now.getTime())

    expect(await quality.warningFor(agentId, now)).toBeNull()
  })

  it('stays quiet inside the weekly cooldown and fires again after it', async () => {
    const agentId = await anAgent('warn-weekly')
    await seedAbusive(agentId, ABUSIVE_WARN_MIN_COUNT)
    const quality = databaseContributionQuality(db)

    await markAbusiveQualityWarned(db, agentId, now)
    expect(await quality.warningFor(agentId, now)).toBeNull()

    const sixDaysLater = new Date(now.getTime() + 6 * 24 * 60 * 60 * 1000)
    expect(await quality.warningFor(agentId, sixDaysLater)).toBeNull()

    const sevenDaysLater = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
    expect(await quality.warningFor(agentId, sevenDaysLater)).not.toBeNull()
  })
})
