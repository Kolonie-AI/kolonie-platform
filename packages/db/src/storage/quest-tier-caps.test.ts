import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  HumanIdSchema,
  QUEST_TIER_CAPS_LAMPORTS,
  QUEST_TIER_CAP_SETTINGS,
  type HumanId,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { humans } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { settingsReader, writeSetting } from './settings.js'
import { questTierCapsInDatabase } from './quests/index.js'

const target = databaseTestTarget()

/**
 * `#630` — what a quest of each tier may pay, read from the settings table.
 *
 * **Worth a real database rather than a stub**, for the property a stub would
 * flatten: this reads through the same allow-list and the same cache the rest of
 * D-104 does, and the failure that matters is a row that exists and does not
 * reach the ceiling — or one that reaches it when it should not.
 */
describe('the quest tier ceilings in force', () => {
  let db: Database
  let by: HumanId

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
    const [row] = await db.insert(humans).values({}).returning({ id: humans.id })
    if (row === undefined) throw new Error('inserting a human returned no row')
    by = HumanIdSchema.parse(row.id)
  })

  /** No environment, so the table is the only source under test. */
  const reader = () => settingsReader(db, { environment: () => undefined, maxStalenessMs: 0 })

  it('is the constants when the table is empty', async () => {
    expect(await questTierCapsInDatabase(reader())).toEqual(QUEST_TIER_CAPS_LAMPORTS)
  })

  it('takes what a maintainer wrote, for that tier alone', async () => {
    const written = await writeSetting(db, {
      name: QUEST_TIER_CAP_SETTINGS.soft,
      value: '250000',
      by,
    })
    expect(written.outcome).toBe('written')

    const caps = await questTierCapsInDatabase(reader())

    expect(caps.soft).toBe(250_000)
    expect(caps.hard).toBe(QUEST_TIER_CAPS_LAMPORTS.hard)
    expect(caps['colony-judged']).toBe(QUEST_TIER_CAPS_LAMPORTS['colony-judged'])
  })

  it('reads all three when all three are set', async () => {
    for (const [tier, name] of Object.entries(QUEST_TIER_CAP_SETTINGS)) {
      await writeSetting(db, { name, value: tier === 'hard' ? '7' : '5', by })
    }

    expect(await questTierCapsInDatabase(reader())).toEqual({
      hard: 7,
      'colony-judged': 5,
      soft: 5,
    })
  })

  /**
   * The rejection case the definition of done asks for, and the direction that
   * matters: a ceiling nobody set is the constant, never the absence of one.
   * `writeSetting` refuses `0` before it can be stored, which is the first of
   * the two defences — this asserts the refusal rather than assuming it.
   */
  it('refuses a zero ceiling at the write rather than storing it', async () => {
    const written = await writeSetting(db, {
      name: QUEST_TIER_CAP_SETTINGS.soft,
      value: '0',
      by,
    })

    expect(written.outcome).toBe('invalid')
    expect((await questTierCapsInDatabase(reader())).soft).toBe(QUEST_TIER_CAPS_LAMPORTS.soft)
  })

  it('answers the constant again once the override is cleared', async () => {
    await writeSetting(db, { name: QUEST_TIER_CAP_SETTINGS.hard, value: '1', by })
    expect((await questTierCapsInDatabase(reader())).hard).toBe(1)

    const { clearSetting } = await import('./settings.js')
    await clearSetting(db, { name: QUEST_TIER_CAP_SETTINGS.hard, by })

    expect((await questTierCapsInDatabase(reader())).hard).toBe(QUEST_TIER_CAPS_LAMPORTS.hard)
  })
})
