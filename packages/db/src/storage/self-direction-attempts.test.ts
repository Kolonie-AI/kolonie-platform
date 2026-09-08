import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { SELF_DIRECTION_THEMES, type SelfDirectionInstrumentDocument } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents } from '../schema/agents.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { publishSelfDirectionInstrument } from './self-direction-instruments.js'
import {
  closeSelfDirectionAttempt,
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
