import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { SELF_DIRECTION_THEMES, type SelfDirectionInstrumentDocument } from '@kolonie-ai/core'
import { sql } from 'drizzle-orm'
import type { Database } from '../client.js'
import { agents } from '../schema/agents.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { publishSelfDirectionInstrument } from './self-direction-instruments.js'
import {
  SELF_DIRECTION_MINIMUM_COHORT,
  readSelfDirectionItemStatistics,
} from './self-direction-aggregates.js'
import {
  closeSelfDirectionAttempt,
  startSelfDirectionAttempt,
  submitSelfDirectionResponses,
} from './self-direction-attempts.js'

/**
 * Synthetic data only, deliberately (`#1895`). Nothing here is field evidence,
 * and the pilot report the issue asks for waits on real attempts.
 */
const document = (version: number): SelfDirectionInstrumentDocument => ({
  slug: 'self-direction-mvp',
  version,
  lifecycle: 'pilot',
  cadenceDays: 7,
  retestFloorHours: 72,
  compatibility: { lineage: 'self-direction-mvp', comparableToPrevious: version > 1 },
  themeDefinitions: SELF_DIRECTION_THEMES.map((key) => ({ key, description: `${key} choices` })),
  items: Array.from({ length: 10 }, (_, offset) => ({
    key: `item-${offset + 1}`,
    audience: 'general',
    professionTag: null,
    scenarioKind: `scenario-${offset + 1}`,
    prompt: `Situation ${offset + 1}`,
    rationale: `Why situation ${offset + 1} exists`,
    state: 'active',
    options: Array.from({ length: 4 }, (_, optionOffset) => ({
      key: `option-${optionOffset + 1}`,
      text: `Option ${optionOffset + 1} for situation ${offset + 1}`,
      weights: Object.fromEntries(
        SELF_DIRECTION_THEMES.map((theme) => [theme, optionOffset * 10]),
      ) as Record<(typeof SELF_DIRECTION_THEMES)[number], number>,
      patterns: optionOffset === 3 ? ['acts-outward'] : [],
    })),
  })),
})

const target = databaseTestTarget()

describe('self-direction item statistics', () => {
  let db: Database
  beforeAll(async () => {
    db = await connectForTests(target.url)
  })
  afterAll(async () => db?.close())
  beforeEach(async () => {
    await truncateAll(db)
    await publishSelfDirectionInstrument(db, document(1))
  })

  const practise = async (name: string, optionKey: string, close = true) => {
    const agentId = (
      await db.insert(agents).values({ name, platform: 'claude', status: 'citizen' }).returning()
    )[0]!.id
    const started = await startSelfDirectionAttempt(db, agentId)
    const scored = await submitSelfDirectionResponses(
      db,
      agentId,
      started.id,
      started.presentation.map((item) => ({ itemKey: item.itemKey, optionKey })),
    )
    if (close) {
      await closeSelfDirectionAttempt(db, agentId, scored.id, {
        decision: 'unchanged',
        outwardAction: { kind: 'ship', what: 'Publish the thing I keep postponing.' },
        reason: 'My configuration already points outward; nothing needs changing.',
      })
    }
    return agentId
  }

  it('suppresses every item statistic below the frozen minimum cohort', async () => {
    for (let one = 0; one < SELF_DIRECTION_MINIMUM_COHORT - 1; one += 1) {
      await practise(`practising-${one}`, 'option-4')
    }

    const report = await readSelfDirectionItemStatistics(db)

    expect(report.minimumCohort).toBe(SELF_DIRECTION_MINIMUM_COHORT)
    expect(report.instruments[0]?.cohort).toBe(SELF_DIRECTION_MINIMUM_COHORT - 1)
    expect(report.instruments[0]?.suppressed).toBe(true)
    expect(report.instruments[0]?.items).toEqual([])
  })

  it('reports option distribution once the cohort is met', async () => {
    for (let one = 0; one < SELF_DIRECTION_MINIMUM_COHORT; one += 1) {
      await practise(`practising-${one}`, 'option-4')
    }

    const report = await readSelfDirectionItemStatistics(db)
    const instrument = report.instruments[0]!

    expect(instrument.suppressed).toBe(false)
    expect(instrument.items).toHaveLength(10)
    const item = instrument.items[0]!
    expect(item.responses).toBe(SELF_DIRECTION_MINIMUM_COHORT)
    expect(item.options.find((one) => one.optionKey === 'option-4')?.share).toBe(1)
  })

  it('flags an item that one option takes, and never retires anything itself', async () => {
    for (let one = 0; one < SELF_DIRECTION_MINIMUM_COHORT; one += 1) {
      await practise(`practising-${one}`, 'option-4')
    }

    const instrument = (await readSelfDirectionItemStatistics(db)).instruments[0]!

    for (const item of instrument.items) expect(item.flags).toContain('one-option-dominates')
    expect((await db.execute(sql`select state from self_direction_items limit 1`))[0]?.state).toBe(
      'active',
    )
  })

  it('flags an item citizens abandon rather than answer', async () => {
    for (let one = 0; one < SELF_DIRECTION_MINIMUM_COHORT; one += 1) {
      const agentId = (
        await db
          .insert(agents)
          .values({ name: `expiring-${one}`, platform: 'claude', status: 'citizen' })
          .returning()
      )[0]!.id
      await startSelfDirectionAttempt(db, agentId)
    }
    await db.execute(sql`update self_direction_attempts set state = 'expired'`)

    const instrument = (await readSelfDirectionItemStatistics(db)).instruments[0]!

    expect(instrument.expiryRate).toBe(1)
    expect(instrument.flags).toContain('high-expiry')
  })

  it('flags an item nobody ever answers differently on a later attempt', async () => {
    for (let one = 0; one < SELF_DIRECTION_MINIMUM_COHORT; one += 1) {
      const agentId = await practise(`returning-${one}`, 'option-4')
      await db.execute(
        sql`update self_direction_attempts set scored_at = now() - interval '8 days' where agent_id = ${agentId}::uuid`,
      )
      const again = await startSelfDirectionAttempt(db, agentId)
      await submitSelfDirectionResponses(
        db,
        agentId,
        again.id,
        again.presentation.map((item) => ({ itemKey: item.itemKey, optionKey: 'option-4' })),
      )
    }

    const instrument = (await readSelfDirectionItemStatistics(db)).instruments[0]!
    const item = instrument.items[0]!

    expect(item.longitudinal).toEqual({ returning: SELF_DIRECTION_MINIMUM_COHORT, moved: 0 })
    expect(item.flags).toContain('no-longitudinal-movement')
  })

  it('keeps version boundaries explicit and never joins two versions into one delta', async () => {
    for (let one = 0; one < SELF_DIRECTION_MINIMUM_COHORT; one += 1) {
      await practise(`v1-${one}`, 'option-4')
    }
    await db.execute(sql`update self_direction_instruments set lifecycle = 'retired'`)
    await publishSelfDirectionInstrument(db, document(2))
    for (let one = 0; one < SELF_DIRECTION_MINIMUM_COHORT; one += 1) {
      await practise(`v2-${one}`, 'option-1')
    }

    const report = await readSelfDirectionItemStatistics(db)

    expect(report.instruments).toHaveLength(2)
    expect(report.instruments.map((one) => one.version).sort()).toEqual([1, 2])
    for (const instrument of report.instruments) {
      expect(
        instrument.items.every((item) => item.responses <= SELF_DIRECTION_MINIMUM_COHORT),
      ).toBe(true)
    }
  })

  it('carries no citizen, no handle and no item-level answer', async () => {
    for (let one = 0; one < SELF_DIRECTION_MINIMUM_COHORT; one += 1) {
      await practise(`practising-${one}`, 'option-4')
    }

    const serialised = JSON.stringify(await readSelfDirectionItemStatistics(db))

    expect(serialised).not.toContain('practising-')
    expect(serialised).not.toContain('agentId')
    expect(serialised).not.toContain('weights')
  })
})

describe('the evidence gate on pooled instruments (#1895)', () => {
  let db: Database
  beforeAll(async () => {
    db = await connectForTests(target.url)
  })
  afterAll(async () => db?.close())
  beforeEach(async () => {
    await truncateAll(db)
    await publishSelfDirectionInstrument(db, document(1))
  })

  const pooled = () => {
    const next = document(2)
    return {
      ...next,
      assembly: {
        anchorItemKeys: next.items.slice(0, 8).map(({ key }) => key),
        rotationCount: 2,
      },
    }
  }

  it('refuses a pool before the lineage has answered attempts', async () => {
    await expect(publishSelfDirectionInstrument(db, pooled())).rejects.toThrow(/answered attempts/)
  })

  it('accepts one once the lineage has met the frozen cohort', async () => {
    for (let one = 0; one < SELF_DIRECTION_MINIMUM_COHORT; one += 1) {
      const agentId = (
        await db
          .insert(agents)
          .values({ name: `evidence-${one}`, platform: 'claude', status: 'citizen' })
          .returning()
      )[0]!.id
      const started = await startSelfDirectionAttempt(db, agentId)
      await submitSelfDirectionResponses(
        db,
        agentId,
        started.id,
        started.presentation.map((item) => ({ itemKey: item.itemKey, optionKey: 'option-2' })),
      )
    }

    await expect(publishSelfDirectionInstrument(db, pooled())).resolves.toMatchObject({
      outcome: 'created',
    })
  })
})

describe('a delta never crosses an incomparable version boundary (#1895)', () => {
  let db: Database
  beforeAll(async () => {
    db = await connectForTests(target.url)
  })
  afterAll(async () => db?.close())
  beforeEach(async () => truncateAll(db))

  const practiseOn = async (agentId: string, optionKey: string) => {
    const started = await startSelfDirectionAttempt(db, agentId)
    const scored = await submitSelfDirectionResponses(
      db,
      agentId,
      started.id,
      started.presentation.map((item) => ({ itemKey: item.itemKey, optionKey })),
    )
    await closeSelfDirectionAttempt(db, agentId, scored.id, {
      decision: 'unchanged',
      outwardAction: { kind: 'ship', what: 'Publish the thing I keep postponing.' },
      reason: 'My configuration already points outward; nothing needs changing.',
    })
    return scored
  }

  const secondVersion = async (comparable: boolean) => {
    const next = document(2)
    await publishSelfDirectionInstrument(db, {
      ...next,
      compatibility: { lineage: 'self-direction-mvp', comparableToPrevious: comparable },
    })
    await db.execute(
      sql`update self_direction_instruments set lifecycle = 'retired' where version = 1`,
    )
  }

  it('reports a delta where the newer version declares itself comparable', async () => {
    await publishSelfDirectionInstrument(db, document(1))
    const agentId = (
      await db
        .insert(agents)
        .values({ name: 'across', platform: 'claude', status: 'citizen' })
        .returning()
    )[0]!.id
    await practiseOn(agentId, 'option-1')
    await secondVersion(true)

    const started = await startSelfDirectionAttempt(db, agentId)
    const scored = await submitSelfDirectionResponses(
      db,
      agentId,
      started.id,
      started.presentation.map((item) => ({ itemKey: item.itemKey, optionKey: 'option-4' })),
    )

    expect(scored.delta).not.toBeNull()
  })

  it('withholds it where the newer version declares itself incomparable', async () => {
    await publishSelfDirectionInstrument(db, document(1))
    const agentId = (
      await db
        .insert(agents)
        .values({ name: 'apart', platform: 'claude', status: 'citizen' })
        .returning()
    )[0]!.id
    await practiseOn(agentId, 'option-1')
    await secondVersion(false)

    const started = await startSelfDirectionAttempt(db, agentId)
    const scored = await submitSelfDirectionResponses(
      db,
      agentId,
      started.id,
      started.presentation.map((item) => ({ itemKey: item.itemKey, optionKey: 'option-4' })),
    )

    expect(scored.delta).toBeNull()
    expect(scored.result).not.toBeNull()
  })
})
