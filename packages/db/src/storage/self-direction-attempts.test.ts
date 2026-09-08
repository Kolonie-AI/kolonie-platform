import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { SELF_DIRECTION_THEMES, type SelfDirectionInstrumentDocument } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents } from '../schema/agents.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { publishSelfDirectionInstrument } from './self-direction-instruments.js'
import {
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
})
