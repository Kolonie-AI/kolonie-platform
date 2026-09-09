import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { SELF_DIRECTION_THEMES, type SelfDirectionInstrumentDocument } from '@kolonie-ai/core'
import { eq } from 'drizzle-orm'
import type { Database } from '../client.js'
import { agents } from '../schema/agents.js'
import { selfDirectionItems } from '../schema/self-direction.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import {
  publishSelfDirectionInstrument,
  readSelfDirectionInstrument,
  retireSelfDirectionInstrument,
} from './self-direction-instruments.js'

const option = (item: number, index: number) => ({
  key: `option-${index}`,
  text: `Item ${item} option ${index}`,
  weights: {
    initiative: item <= 2 ? index : 0,
    leverage: item >= 3 && item <= 4 ? index : 0,
    outwardEffect: item >= 5 && item <= 6 ? index : 0,
    strategicFocus: item >= 7 && item <= 8 ? index : 0,
    selfRevision: item >= 9 ? index : 0,
  },
  patterns: [],
})

const document = (): SelfDirectionInstrumentDocument => ({
  slug: 'self-direction-mvp',
  version: 1,
  lifecycle: 'pilot',
  cadenceDays: 7,
  retestFloorHours: 72,
  compatibility: { lineage: 'self-direction-mvp', comparableToPrevious: false },
  themeDefinitions: SELF_DIRECTION_THEMES.map((key) => ({ key, description: `${key} choices` })),
  items: Array.from({ length: 10 }, (_, offset) => {
    const item = offset + 1
    return {
      key: `item-${item}`,
      audience: 'general',
      professionTag: null,
      scenarioKind: `scenario-${item}`,
      prompt: `Situation ${item}`,
      rationale: `Why situation ${item} exists`,
      state: 'active',
      options: Array.from({ length: 4 }, (_, optionOffset) => option(item, optionOffset + 1)),
    }
  }),
})

const target = databaseTestTarget()

describe('self-direction instruments', () => {
  let db: Database
  beforeAll(async () => {
    db = await connectForTests(target.url)
  })
  afterAll(async () => db?.close())
  beforeEach(async () => truncateAll(db))

  it('publishes ordinary public content and reads it reproducibly', async () => {
    const first = await publishSelfDirectionInstrument(db, document())
    const second = await publishSelfDirectionInstrument(db, document())
    expect(second).toEqual({ outcome: 'unchanged', instrument: first.instrument })
    expect(await readSelfDirectionInstrument(db, 'self-direction-mvp', 1)).toEqual(document())
  })

  it('refuses content drift at the same slug and version', async () => {
    await publishSelfDirectionInstrument(db, document())
    const changed = document()
    changed.items[0]!.prompt = 'Different situation'
    await expect(publishSelfDirectionInstrument(db, changed)).resolves.toMatchObject({
      outcome: 'conflict',
    })
    expect(
      (await readSelfDirectionInstrument(db, changed.slug, changed.version))?.items[0]?.prompt,
    ).toBe('Situation 1')
  })

  it('survives citizen erasure because no column names a citizen', async () => {
    await publishSelfDirectionInstrument(db, document())
    const [agent] = await db
      .insert(agents)
      .values({ name: 'practising', platform: 'claude' })
      .returning()
    await db.delete(agents).where(eq(agents.id, agent!.id))
    expect(await readSelfDirectionInstrument(db, 'self-direction-mvp', 1)).toEqual(document())
  })

  it('refuses to delete an item other rows still resolve against', async () => {
    const published = await publishSelfDirectionInstrument(db, document())
    if (published.outcome === 'conflict') throw new Error('unexpected publication conflict')
    const [item] = await db
      .select()
      .from(selfDirectionItems)
      .where(eq(selfDirectionItems.instrumentId, published.instrument.id))
      .limit(1)
    await expect(
      db.delete(selfDirectionItems).where(eq(selfDirectionItems.id, item!.id)),
    ).rejects.toThrow()
  })

  it('refuses a document that declares no comparability with earlier versions', async () => {
    const undeclared = { ...document() } as Record<string, unknown>
    delete undeclared.compatibility
    await expect(publishSelfDirectionInstrument(db, undeclared as never)).rejects.toThrow()
  })

  it('retires content from future selection without losing history', async () => {
    const published = await publishSelfDirectionInstrument(db, document())
    if (published.outcome === 'conflict') throw new Error('unexpected publication conflict')
    await expect(retireSelfDirectionInstrument(db, published.instrument.id)).resolves.toBe(true)
    expect((await readSelfDirectionInstrument(db, document().slug, 1))?.lifecycle).toBe('retired')
  })
})

/** The production data itself takes the same guarded path as any later version. */
it('publishes the checked-in pilot and reads every public field back', async () => {
  const { SELF_DIRECTION_MVP_V1 } = await import('../self-direction-instrument/mvp-v1.js')
  const db = await connectForTests(target.url)
  try {
    await truncateAll(db)
    const first = await publishSelfDirectionInstrument(db, SELF_DIRECTION_MVP_V1)
    expect(first.outcome).toBe('created')
    expect(await readSelfDirectionInstrument(db, 'self-direction-mvp', 1)).toEqual(
      SELF_DIRECTION_MVP_V1,
    )
  } finally {
    await db.close()
  }
})
