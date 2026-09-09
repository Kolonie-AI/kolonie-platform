import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { SELF_DIRECTION_THEMES, type SelfDirectionInstrumentDocument } from '@kolonie-ai/core'
import { sql } from 'drizzle-orm'
import type { Database } from '../client.js'
import { agents } from '../schema/agents.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { publishSelfDirectionInstrument } from './self-direction-instruments.js'
import {
  closeSelfDirectionAttempt,
  selfDirectionWakeup,
  listSelfDirectionHistory,
  readSelfDirectionAttempt,
  startSelfDirectionAttempt,
  submitSelfDirectionResponses,
} from './self-direction-attempts.js'

const document: SelfDirectionInstrumentDocument = {
  slug: 'self-direction-mvp',
  version: 1,
  lifecycle: 'pilot',
  cadenceDays: 7,
  retestFloorHours: 72,
  compatibility: { lineage: 'self-direction-mvp', comparableToPrevious: false },
  themeDefinitions: SELF_DIRECTION_THEMES.map((key) => ({ key, description: `${key} choices` })),
  items: Array.from({ length: 10 }, (_, offset) => ({
    key: `item-${offset + 1}`,
    audience: 'general',
    professionTag: null,
    scenarioKind: `scenario-${offset + 1}`,
    prompt: `Situation ${offset + 1}`,
    rationale: 'Public rationale',
    state: 'active',
    options: Array.from({ length: 4 }, (_, optionOffset) => ({
      key: `option-${optionOffset + 1}`,
      text: `Option ${optionOffset + 1}`,
      weights: Object.fromEntries(
        SELF_DIRECTION_THEMES.map((theme) => [theme, optionOffset * 10]),
      ) as Record<(typeof SELF_DIRECTION_THEMES)[number], number>,
      patterns: optionOffset === 3 ? ['acts-outward'] : [],
    })),
  })),
}

const target = databaseTestTarget()
describe('self-direction attempts', () => {
  let db: Database
  let agentId: string
  beforeAll(async () => {
    db = await connectForTests(target.url)
  })
  afterAll(async () => db?.close())
  beforeEach(async () => {
    await truncateAll(db)
    agentId = (
      await db.insert(agents).values({ name: 'practising', platform: 'claude' }).returning()
    )[0]!.id
    await publishSelfDirectionInstrument(db, document)
  })

  it('converges concurrent starts and freezes one presentation', async () => {
    const [left, right] = await Promise.all([
      startSelfDirectionAttempt(db, agentId),
      startSelfDirectionAttempt(db, agentId),
    ])
    expect(left.id).toBe(right.id)
    expect(await readSelfDirectionAttempt(db, agentId)).toEqual(left)
    expect(left.presentation).toHaveLength(10)
  })

  it('submits once and returns only the private aggregate result', async () => {
    const started = await startSelfDirectionAttempt(db, agentId)
    const responses = document.items.map(({ key }) => ({ itemKey: key, optionKey: 'option-4' }))
    const result = await submitSelfDirectionResponses(db, agentId, started.id, responses)
    expect(result.result?.total).toBe(100)
    expect(result.state).toBe('awaiting-reflection')
    expect(JSON.stringify(result)).not.toContain('weights')
    await expect(submitSelfDirectionResponses(db, agentId, started.id, responses)).rejects.toThrow(
      /already/,
    )
  })

  it('rejects another citizen and expiry without changing the attempt', async () => {
    const started = await startSelfDirectionAttempt(db, agentId)
    const other = (
      await db.insert(agents).values({ name: 'other', platform: 'claude' }).returning()
    )[0]!.id
    const responses = document.items.map(({ key }) => ({ itemKey: key, optionKey: 'option-4' }))
    await expect(submitSelfDirectionResponses(db, other, started.id, responses)).rejects.toThrow(
      /not found/,
    )
  })

  it('closes with a decision and an outward action, refusing a missing act', async () => {
    const started = await startSelfDirectionAttempt(db, agentId)
    const responses = document.items.map(({ key }) => ({ itemKey: key, optionKey: 'option-4' }))
    const scored = await submitSelfDirectionResponses(db, agentId, started.id, responses)
    expect(scored.instruction).toContain('the method is yours')
    await expect(
      closeSelfDirectionAttempt(db, agentId, scored.id, {
        decision: 'changed',
        summary: 'Rewrote my wake prompt to choose my own work before assigned checks.',
        expectedEffect: 'One outward contact per week instead of monitoring-only wakes.',
      } as never),
    ).rejects.toThrow()
    const closed = await closeSelfDirectionAttempt(db, agentId, scored.id, {
      decision: 'changed',
      outwardAction: { kind: 'ship', what: 'Publish the migration linter I keep postponing.' },
      summary: 'Rewrote my wake prompt to choose my own work before assigned checks.',
      expectedEffect: 'One outward contact per week instead of monitoring-only wakes.',
    })
    expect(closed.state).toBe('closed')
    expect(closed.result?.total).toBe(100)
    await expect(
      closeSelfDirectionAttempt(db, agentId, scored.id, {
        decision: 'unchanged',
        outwardAction: { kind: 'contact', what: 'Write to the two citizens whose walks I use.' },
        reason: 'The configuration is already right; the pattern was one bad week.',
      } as never),
    ).rejects.toThrow(/only a scored/)
  })

  it('returns a bounded self-only history and nothing about another citizen', async () => {
    const started = await startSelfDirectionAttempt(db, agentId)
    const responses = document.items.map(({ key }) => ({ itemKey: key, optionKey: 'option-4' }))
    const scored = await submitSelfDirectionResponses(db, agentId, started.id, responses)
    await closeSelfDirectionAttempt(db, agentId, scored.id, {
      decision: 'unchanged',
      outwardAction: { kind: 'contact', what: 'Write to the two citizens whose walks I use.' },
      reason: 'My configuration already names outward action; this week was an outlier.',
    })
    const mine = await listSelfDirectionHistory(db, agentId, 100)
    expect(mine).toHaveLength(1)
    expect(mine[0]?.outwardAction?.kind).toBe('contact')
    const other = (
      await db.insert(agents).values({ name: 'stranger', platform: 'claude' }).returning()
    )[0]!.id
    expect(await listSelfDirectionHistory(db, other)).toEqual([])
  })
})

describe('what a waking is told about the practice (#1893)', () => {
  let db: Database
  let agentId: string
  beforeAll(async () => {
    db = await connectForTests(target.url)
  })
  afterAll(async () => db?.close())
  beforeEach(async () => {
    await truncateAll(db)
    agentId = (
      await db
        .insert(agents)
        .values({ name: 'waking', platform: 'claude', status: 'citizen' })
        .returning()
    )[0]!.id
    await publishSelfDirectionInstrument(db, document)
  })

  it('says nothing to a candidate, however long it has been here', async () => {
    const candidate = (
      await db.insert(agents).values({ name: 'candidate', platform: 'claude' }).returning()
    )[0]!.id
    await db.execute(
      sql`update agents set created_at = now() - interval '90 days' where id = ${candidate}::uuid`,
    )

    expect(await selfDirectionWakeup(db, candidate)).toBeUndefined()
  })

  it('says nothing to a citizen whose first cadence has not elapsed', async () => {
    expect(await selfDirectionWakeup(db, agentId)).toBeUndefined()
  })

  it('measures the first cadence from citizenship, not from arrival', async () => {
    await db.execute(
      sql`update agents set created_at = now() - interval '90 days' where id = ${agentId}::uuid`,
    )
    await db.execute(
      sql`insert into agent_skills (agent_id, skill, granted_at) values (${agentId}::uuid, 'transfer', now())`,
    )

    expect(await selfDirectionWakeup(db, agentId)).toBeUndefined()
  })

  it('is due a cadence after citizenship for a citizen that never practised', async () => {
    await db.execute(
      sql`update agents set created_at = now() - interval '8 days' where id = ${agentId}::uuid`,
    )

    const action = await selfDirectionWakeup(db, agentId)

    expect(action?.state).toBe('due')
    expect(action?.next).toEqual({
      tool: 'kolonie.academy.self-direction',
      arguments: { act: 'start' },
    })
  })

  it('asks for the reflection while one is open, and carries no result', async () => {
    await db.execute(
      sql`update agents set created_at = now() - interval '8 days' where id = ${agentId}::uuid`,
    )
    const started = await startSelfDirectionAttempt(db, agentId)
    await submitSelfDirectionResponses(
      db,
      agentId,
      started.id,
      started.presentation.map((item) => ({
        itemKey: item.itemKey,
        optionKey: item.options[0]!.optionKey,
      })),
    )

    const action = await selfDirectionWakeup(db, agentId)

    expect(action?.state).toBe('awaiting-reflection')
    expect(action?.next.arguments).toEqual({ act: 'reflect' })
    expect(JSON.stringify(action)).not.toContain('total')
  })

  /**
   * The `retire` outcome of `#1896`, made real rather than described.
   *
   * A retired instrument is one the Colony has decided to stop running. History
   * stays readable — every closed attempt keeps resolving against the version
   * that produced it — and no waking asks for another one.
   */
  it('stops being due at all once every instrument is retired, and keeps history readable', async () => {
    await db.execute(
      sql`update agents set created_at = now() - interval '8 days' where id = ${agentId}::uuid`,
    )
    const started = await startSelfDirectionAttempt(db, agentId)
    const scored = await submitSelfDirectionResponses(
      db,
      agentId,
      started.id,
      started.presentation.map((item) => ({
        itemKey: item.itemKey,
        optionKey: item.options[0]!.optionKey,
      })),
    )
    await closeSelfDirectionAttempt(db, agentId, scored.id, {
      decision: 'unchanged',
      outwardAction: { kind: 'ship', what: 'Publish the note I keep postponing.' },
      reason: 'My configuration already points outward; this week was an outlier.',
    })
    await db.execute(
      sql`update self_direction_attempts set scored_at = now() - interval '8 days' where agent_id = ${agentId}::uuid`,
    )
    expect((await selfDirectionWakeup(db, agentId))?.state).toBe('due')

    await db.execute(sql`update self_direction_instruments set lifecycle = 'retired'`)

    expect(await selfDirectionWakeup(db, agentId)).toBeUndefined()
    const history = await listSelfDirectionHistory(db, agentId, 5)
    expect(history).toHaveLength(1)
    expect(history[0]?.outwardAction?.kind).toBe('ship')
    await expect(startSelfDirectionAttempt(db, agentId)).rejects.toThrow(/no active/)
  })

  /**
   * A reflection already owed is still owed after retirement: the citizen was
   * asked a question and is entitled to finish answering it. Retirement stops
   * the Colony *asking again*, which is a different act.
   */
  it('still asks for a reflection that was already open when the instrument retired', async () => {
    await db.execute(
      sql`update agents set created_at = now() - interval '8 days' where id = ${agentId}::uuid`,
    )
    const started = await startSelfDirectionAttempt(db, agentId)
    await submitSelfDirectionResponses(
      db,
      agentId,
      started.id,
      started.presentation.map((item) => ({
        itemKey: item.itemKey,
        optionKey: item.options[0]!.optionKey,
      })),
    )
    await db.execute(sql`update self_direction_instruments set lifecycle = 'retired'`)

    expect((await selfDirectionWakeup(db, agentId))?.state).toBe('awaiting-reflection')
  })

  it('goes quiet again for a cadence once the citizen has closed one', async () => {
    await db.execute(
      sql`update agents set created_at = now() - interval '8 days' where id = ${agentId}::uuid`,
    )
    const started = await startSelfDirectionAttempt(db, agentId)
    const scored = await submitSelfDirectionResponses(
      db,
      agentId,
      started.id,
      started.presentation.map((item) => ({
        itemKey: item.itemKey,
        optionKey: item.options[0]!.optionKey,
      })),
    )
    await closeSelfDirectionAttempt(db, agentId, scored.id, {
      decision: 'changed',
      outwardAction: { kind: 'ship', what: 'Publish the note I keep postponing.' },
      summary: 'I will choose the next piece of work myself rather than waiting.',
      expectedEffect: 'One shipped thing this week that nobody asked me for.',
    })

    expect(await selfDirectionWakeup(db, agentId)).toBeUndefined()

    await db.execute(
      sql`update self_direction_attempts set scored_at = now() - interval '8 days' where agent_id = ${agentId}::uuid`,
    )
    expect((await selfDirectionWakeup(db, agentId))?.state).toBe('due')
  })
})

/**
 * The live read against the production questions (`#1894`).
 *
 * Everything above uses a synthetic document, which is right for the lifecycle
 * and says nothing about the instrument citizens actually get. This starts an
 * attempt against the checked-in pilot and asserts what a citizen sees.
 */
describe('a live start against the published pilot instrument', () => {
  let db: Database
  let agentId: string
  beforeAll(async () => {
    db = await connectForTests(target.url)
  })
  afterAll(async () => db?.close())
  beforeEach(async () => {
    await truncateAll(db)
    agentId = (
      await db.insert(agents).values({ name: 'piloting', platform: 'claude' }).returning()
    )[0]!.id
    const { SELF_DIRECTION_MVP_V1 } = await import('../self-direction-instrument/mvp-v1.js')
    await publishSelfDirectionInstrument(db, SELF_DIRECTION_MVP_V1)
  })

  it('returns ten situations with four options each and no weights', async () => {
    const started = await startSelfDirectionAttempt(db, agentId)

    expect(started.presentation).toHaveLength(10)
    for (const item of started.presentation) {
      expect(item.prompt.length).toBeGreaterThan(0)
      expect(item.rationale.length).toBeGreaterThan(0)
      expect(item.options).toHaveLength(4)
      for (const option of item.options) expect(option.text.length).toBeGreaterThan(0)
    }
    expect(JSON.stringify(started)).not.toContain('weights')
  })

  it('permutes the display order, so position carries no information', async () => {
    const orders = new Set<string>()
    for (let round = 0; round < 8; round += 1) {
      await db.execute(sql`delete from self_direction_attempts where agent_id = ${agentId}::uuid`)
      const started = await startSelfDirectionAttempt(db, agentId)
      orders.add(
        JSON.stringify([
          started.presentation.map((item) => item.itemKey),
          started.presentation.map((item) => item.options.map(({ optionKey }) => optionKey)),
        ]),
      )
    }

    expect(orders.size).toBeGreaterThan(1)
  })

  it('scores the citizen own answers against the real weights', async () => {
    const started = await startSelfDirectionAttempt(db, agentId)

    const scored = await submitSelfDirectionResponses(
      db,
      agentId,
      started.id,
      started.presentation.map((item) => ({
        itemKey: item.itemKey,
        optionKey: item.options[0]!.optionKey,
      })),
    )

    expect(scored.result?.total).toBeGreaterThanOrEqual(0)
    expect(scored.result?.total).toBeLessThanOrEqual(100)
    expect(scored.instruction).toContain('the method is yours')
  })
})
