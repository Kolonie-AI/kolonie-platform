import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import {
  providerIcon,
  providerIconCounts,
  providersDueForIcon,
  providersWithIcons,
  recordProviderIcon,
} from './atlas-provider-icons.js'

const target = databaseTestTarget()

/**
 * `#1667` — the icon store, and above all the two reads that take a list.
 *
 * **This file exists because `#1405` shipped without it.** Both list-taking
 * functions wrote `= any(${array})` into a `sql` template, which drizzle expands
 * into a placeholder list — `any(($1, $2, $3))` — and Postgres reads that as a
 * row constructor and refuses it with `42809`, *op ANY/ALL (array) requires array
 * on right side*. The verifier runner's poll loop hit it every tick from the
 * moment the sweep was deployed (`#1667`), and every Atlas shelf page would have
 * hit the other one.
 *
 * **Every case here is multi-provider on purpose.** A single-element call fails
 * too — `22P02`, *malformed array literal* — but the shapes are different enough
 * that a one-provider test can be made to pass by the wrong fix. Two is what
 * proves an array reached the driver as an array.
 */
describe('the provider icon store', () => {
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

  const icon = (source: string) =>
    ({
      outcome: 'icon',
      bytes: new Uint8Array([1, 2, 3]),
      format: 'png',
      width: 32,
      height: 32,
      sourceUrl: source,
    }) as const

  describe('which providers are due', () => {
    /**
     * The regression itself. Three providers in one call is what the sweep does
     * every tick, and it is what threw.
     */
    it('answers for several providers at once', async () => {
      const homepages = new Map([
        ['one.example', 'https://one.example'],
        ['two.example', 'https://two.example'],
        ['three.example', 'https://three.example'],
      ])

      const due = await providersDueForIcon(db, homepages, 10)

      expect(due.map((entry) => entry.provider).sort()).toEqual([
        'one.example',
        'three.example',
        'two.example',
      ])
    })

    /** A provider already looked at, and not yet stale, is not due. */
    it('leaves out a provider whose copy is still fresh', async () => {
      await recordProviderIcon(db, 'one.example', icon('https://one.example/favicon.ico'))

      const due = await providersDueForIcon(
        db,
        new Map([
          ['one.example', 'https://one.example'],
          ['two.example', 'https://two.example'],
        ]),
        10,
      )

      expect(due.map((entry) => entry.provider)).toEqual(['two.example'])
    })

    /** Never looked at comes before merely stale — the sweep's own ordering. */
    it('puts a provider nobody has asked about before an overdue one', async () => {
      await db.execute(
        // A row whose refresh window closed a day ago. Written through SQL rather
        // than by moving the clock, because the ordering is the assertion and the
        // TTL is not.
        `insert into atlas_provider_icons (provider, fetched_at, refresh_after, absence)
         values ('stale.example', now() - interval '40 days', now() - interval '1 day', 'no-candidate')`,
      )

      const due = await providersDueForIcon(
        db,
        new Map([
          ['stale.example', 'https://stale.example'],
          ['fresh.example', 'https://fresh.example'],
        ]),
        10,
      )

      expect(due.map((entry) => entry.provider)).toEqual(['fresh.example', 'stale.example'])
    })

    it('asks about nothing when it is given nothing', async () => {
      expect(await providersDueForIcon(db, new Map(), 10)).toEqual([])
      expect(await providersDueForIcon(db, new Map([['one.example', 'https://one']]), 0)).toEqual(
        [],
      )
    })
  })

  describe('which providers the Colony holds an icon for', () => {
    /** The other half of the same defect, asked the way a shelf page asks it. */
    it('answers for several providers at once', async () => {
      await recordProviderIcon(db, 'has.example', icon('https://has.example/favicon.ico'))
      await recordProviderIcon(db, 'looked.example', {
        outcome: 'none',
        absence: 'no-candidate',
      })

      const held = await providersWithIcons(db, [
        'has.example',
        'looked.example',
        'unknown.example',
      ])

      expect([...held]).toEqual(['has.example'])
    })

    it('answers for none of them without asking the database', async () => {
      expect([...(await providersWithIcons(db, []))]).toEqual([])
    })
  })

  describe('one provider', () => {
    it('gives back what the sweep stored', async () => {
      await recordProviderIcon(db, 'has.example', icon('https://has.example/favicon.ico'))

      const stored = await providerIcon(db, 'has.example')

      expect(stored?.format).toBe('png')
      expect([...(stored?.bytes ?? [])]).toEqual([1, 2, 3])
    })

    /**
     * A finding of nothing overwrites an icon, and the reader then answers
     * nothing — the module's own decision, asserted so it cannot drift into
     * serving a picture the provider has taken down.
     */
    it('answers nothing once the sweep finds the icon gone', async () => {
      await recordProviderIcon(db, 'was.example', icon('https://was.example/favicon.ico'))
      await recordProviderIcon(db, 'was.example', { outcome: 'none', absence: 'no-candidate' })

      expect(await providerIcon(db, 'was.example')).toBeUndefined()
    })
  })

  it('counts what it holds against what it has looked at', async () => {
    await recordProviderIcon(db, 'has.example', icon('https://has.example/favicon.ico'))
    await recordProviderIcon(db, 'looked.example', { outcome: 'none', absence: 'unreachable' })

    expect(await providerIconCounts(db)).toEqual({ held: 1, looked: 2 })
  })
})
