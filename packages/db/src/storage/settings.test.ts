import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { HumanIdSchema, NEVER_A_SETTING, SETTINGS, type HumanId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { authorityEvents, humans, settings } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { clearSetting, effectiveSettings, settingsReader, writeSetting } from './settings.js'

const target = databaseTestTarget()

/**
 * `#489`, implementing D-104.
 *
 * The two properties worth a real database are the ones a fake would flatten:
 * that a write and its audit row commit together, and that the allow-list holds
 * on the way **out** as well as in — a row for a name that is not a setting must
 * not be readable, whatever put it there.
 */
describe('the settings a maintainer turns', () => {
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

  const noEnvironment = () => undefined

  describe('the allow-list, which is the security half of D-104', () => {
    /**
     * *"Only names in an explicit allow-list are readable or writable through
     * the settings path, and a name absent from it is not 'not yet supported' —
     * it is refused."*
     */
    it('refuses to write a name that is not a setting', async () => {
      for (const name of NEVER_A_SETTING) {
        expect(await writeSetting(db, { name, value: 'anything', by })).toEqual({
          outcome: 'unknown-setting',
        })
      }

      expect(await db.select().from(settings)).toEqual([])
    })

    /**
     * **The refusal holds on the way out too.** A row written by any other
     * means — a migration, a hand-typed `insert` — must not be readable through
     * this path, or the allow-list would only be a validation rule.
     */
    it('does not read back a row for a name that is not a setting', async () => {
      await db.insert(settings).values({ name: 'DATABASE_URL', value: 'a-connection-string' })

      const reader = settingsReader(db, { environment: noEnvironment })

      expect(await reader.read('DATABASE_URL')).toBeUndefined()
      expect(
        (await effectiveSettings(db, noEnvironment)).map((s) => s.definition.name),
      ).not.toContain('DATABASE_URL')
    })

    /** And the catalogue itself never names one of them. */
    it('names none of the forbidden variables in SETTINGS', () => {
      const named = SETTINGS.map((setting) => setting.name)
      for (const forbidden of NEVER_A_SETTING) {
        expect(named).not.toContain(forbidden)
      }
    })
  })

  describe('precedence — the database wins, the environment is the boot default', () => {
    it('reads the environment when nothing is overridden', async () => {
      const rows = await effectiveSettings(db, (name) =>
        name === 'POLL_INTERVAL_MS' ? '60000' : undefined,
      )

      const poll = rows.find((row) => row.definition.name === 'POLL_INTERVAL_MS')
      expect(poll?.value).toBe('60000')
      expect(poll?.source).toBe('environment')
    })

    it('reads the override once there is one, and says so', async () => {
      await writeSetting(db, { name: 'POLL_INTERVAL_MS', value: '30000', by })

      const rows = await effectiveSettings(db, () => '60000')

      const poll = rows.find((row) => row.definition.name === 'POLL_INTERVAL_MS')
      expect(poll?.value).toBe('30000')
      expect(poll?.source).toBe('database')
      expect(poll?.changedAt).toEqual(expect.any(String))
    })

    it('says unset when neither has a value', async () => {
      const rows = await effectiveSettings(db, noEnvironment)

      expect(rows.every((row) => row.source === 'unset')).toBe(true)
      expect(rows).toHaveLength(SETTINGS.length)
    })

    /** A setting nobody has touched is still listed, or the page hides it. */
    it('lists every setting, not only the overridden ones', async () => {
      await writeSetting(db, { name: 'POLL_INTERVAL_MS', value: '30000', by })

      expect(await effectiveSettings(db, noEnvironment)).toHaveLength(SETTINGS.length)
    })
  })

  describe('validation, before the row is written', () => {
    it('refuses a poll interval of zero', async () => {
      const outcome = await writeSetting(db, { name: 'POLL_INTERVAL_MS', value: '0', by })

      expect(outcome.outcome).toBe('invalid')
      expect(await db.select().from(settings)).toEqual([])
    })

    it('refuses a model name that is not a model reference', async () => {
      expect(
        (await writeSetting(db, { name: 'TRIAGE_MODEL', value: 'nonsense', by })).outcome,
      ).toBe('invalid')
      expect(await db.select().from(settings)).toEqual([])
    })

    it('accepts one that is', async () => {
      expect(
        (await writeSetting(db, { name: 'TRIAGE_MODEL', value: 'deepseek/deepseek-v4-flash', by }))
          .outcome,
      ).toBe('written')
    })

    it('refuses a switch that is neither on nor off', async () => {
      expect(
        (await writeSetting(db, { name: 'REGISTRATION_OPEN', value: 'maybe', by })).outcome,
      ).toBe('invalid')
    })
  })

  describe('the audit', () => {
    /** D-104: *a write that could not be recorded is a write that does not happen.* */
    it('records who changed it, in the same transaction', async () => {
      await writeSetting(db, { name: 'POLL_INTERVAL_MS', value: '30000', by })

      const events = await db
        .select()
        .from(authorityEvents)
        .where(eq(authorityEvents.subjectHumanId, by))

      expect(events).toHaveLength(1)
      expect(events[0]?.action).toBe('setting-changed')
    })

    it('records a clear as its own act', async () => {
      await writeSetting(db, { name: 'POLL_INTERVAL_MS', value: '30000', by })
      await clearSetting(db, { name: 'POLL_INTERVAL_MS', by })

      const events = await db
        .select()
        .from(authorityEvents)
        .where(eq(authorityEvents.subjectHumanId, by))

      expect(events.map((event) => event.action)).toEqual(['setting-changed', 'setting-cleared'])
    })

    /** An audit that fills with rows where nothing happened is one nobody reads. */
    it('writes nothing at all when there was no override to clear', async () => {
      const outcome = await clearSetting(db, { name: 'POLL_INTERVAL_MS', by })

      expect(outcome).toEqual({ outcome: 'unchanged' })
      expect(await db.select().from(authorityEvents)).toEqual([])
    })

    it('leaves no audit row behind a refused write', async () => {
      await writeSetting(db, { name: 'POLL_INTERVAL_MS', value: '0', by })

      expect(await db.select().from(authorityEvents)).toEqual([])
    })
  })

  describe('clearing', () => {
    /**
     * **Deleting the row is what *back to the environment* means.** A null value
     * would be a third state between overridden and not, and nothing could say
     * what it meant.
     */
    it('removes the row rather than writing a value back', async () => {
      await writeSetting(db, { name: 'POLL_INTERVAL_MS', value: '30000', by })

      await clearSetting(db, { name: 'POLL_INTERVAL_MS', by })

      expect(await db.select().from(settings)).toEqual([])
      const rows = await effectiveSettings(db, () => '60000')
      expect(rows.find((row) => row.definition.name === 'POLL_INTERVAL_MS')?.source).toBe(
        'environment',
      )
    })

    it('refuses a name that is not a setting', async () => {
      expect(await clearSetting(db, { name: 'DATABASE_URL', by })).toEqual({
        outcome: 'unknown-setting',
      })
    })
  })

  describe('reaching a running process', () => {
    /**
     * D-104's third answer. The staleness is a **number** rather than
     * *eventually*, so a maintainer flipping a switch knows what they are
     * waiting for — and this is that number being what it says it is.
     */
    it('serves from the cache inside the window and re-reads after it', async () => {
      let clock = 1_000
      const reader = settingsReader(db, {
        environment: noEnvironment,
        maxStalenessMs: 30_000,
        now: () => clock,
      })

      await writeSetting(db, { name: 'POLL_INTERVAL_MS', value: '30000', by })
      expect(await reader.read('POLL_INTERVAL_MS')).toBe('30000')

      // Changed underneath it, within the window: the old value still answers,
      // which is the trade a cache is.
      await writeSetting(db, { name: 'POLL_INTERVAL_MS', value: '45000', by })
      clock += 29_000
      expect(await reader.read('POLL_INTERVAL_MS')).toBe('30000')

      // Past it: the new one.
      clock += 2_000
      expect(await reader.read('POLL_INTERVAL_MS')).toBe('45000')
    })

    it('falls back to the environment for a setting nobody has overridden', async () => {
      const reader = settingsReader(db, {
        environment: (name) => (name === 'TRIAGE_MODEL' ? 'someone/a-model' : undefined),
      })

      expect(await reader.read('TRIAGE_MODEL')).toBe('someone/a-model')
    })

    it('answers undefined for a name that is not a setting, without asking the environment', async () => {
      const reader = settingsReader(db, { environment: () => 'a-secret' })

      expect(await reader.read('DATABASE_URL')).toBeUndefined()
    })

    it('forgets on request, for a process that has just written one', async () => {
      const reader = settingsReader(db, { environment: noEnvironment, maxStalenessMs: 30_000 })

      await writeSetting(db, { name: 'POLL_INTERVAL_MS', value: '30000', by })
      expect(await reader.read('POLL_INTERVAL_MS')).toBe('30000')

      await writeSetting(db, { name: 'POLL_INTERVAL_MS', value: '45000', by })
      reader.forget()

      expect(await reader.read('POLL_INTERVAL_MS')).toBe('45000')
    })
  })
})
