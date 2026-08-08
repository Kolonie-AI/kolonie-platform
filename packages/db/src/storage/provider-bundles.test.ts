import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { BUNDLE_LEADING_KINDS, inBundleOrder, leadsWithTheCheapAccounts } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { seedProviderCatalogue } from '../provider-catalogue.js'
import { BUNDLES, bundleNamed, bundles, seedBundles } from './provider-bundles.js'

const target = databaseTestTarget()

/**
 * The bundles (#531).
 *
 * **The ordering rule is what this file is for.** `#531` calls it *"the part
 * worth getting right"*, and it is the property a well-meaning edit breaks by
 * putting the interesting provider first — nothing else here would fail if it
 * did.
 */
describe('the provider bundles', () => {
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

  describe('the ordering rule', () => {
    it('holds for every bundle the Colony ships', () => {
      for (const bundle of BUNDLES) {
        expect(leadsWithTheCheapAccounts(bundle.entries), bundle.slug).toBe(true)
      }
    })

    /**
     * Not *every bundle contains a mailbox* — the rule is about order, and a
     * bundle with neither leading kind is legitimate. What must never happen is
     * one that has them and buries them.
     */
    it('refuses a bundle that buries the accounts which remove operator work', () => {
      expect(
        leadsWithTheCheapAccounts([
          { kind: 'trello', provider: 'trello.com' } as never,
          { kind: 'mailbox', provider: 'openmail.sh' } as never,
        ]),
      ).toBe(false)
    })

    it('passes a bundle that has none of them at all', () => {
      expect(leadsWithTheCheapAccounts([{ kind: 'github', provider: 'github.com' } as never])).toBe(
        true,
      )
    })

    it('names the two kinds it is about', () => {
      expect([...BUNDLE_LEADING_KINDS]).toEqual(['mailbox', 'phone'])
    })

    /**
     * **The order is derived and stored nowhere** (`#548`): a `position` column
     * would be a placement inside a recommendation that somebody could later be
     * sold, and `#543` says paying buys nothing about ordering.
     */
    it('puts the leading kinds first and everything else alphabetically', () => {
      const ordered = inBundleOrder([
        { kind: 'social', provider: 'bsky.app' } as never,
        { kind: 'phone', provider: 'twilio.com' } as never,
        { kind: 'github', provider: 'github.com' } as never,
        { kind: 'mailbox', provider: 'openmail.sh' } as never,
      ])

      expect(ordered.map((row) => row.provider)).toEqual([
        'openmail.sh',
        'twilio.com',
        'bsky.app',
        'github.com',
      ])
    })
  })

  describe('seeding', () => {
    it('writes them and can be run twice', async () => {
      expect(await seedBundles(db)).toBe(BUNDLES.length)
      expect(await seedBundles(db)).toBe(BUNDLES.length)

      const held = await bundles(db)
      expect(held).toHaveLength(BUNDLES.length)
    })

    it('keeps each bundle’s entries in the order it was written in', async () => {
      await seedBundles(db)

      const starter = await bundleNamed(db, 'starter')
      expect(starter?.entries.map((row) => row.kind)).toEqual(['mailbox', 'phone'])
    })
  })

  describe('what the catalogue says about each entry', () => {
    /**
     * A bundle names entries as text and the catalogue is written separately, so
     * an entry nobody has got to yet is the ordinary case rather than an error.
     * Hiding it would make a bundle silently shorter than it was designed to be.
     */
    it('shows an entry nobody has written yet, and says so', async () => {
      await seedBundles(db)

      const design = await bundleNamed(db, 'design')
      const unwritten = design?.entries.find((row) => row.provider === 'openai.com')

      expect(unwritten).toBeDefined()
      expect(unwritten?.title).toBeNull()
      // `null` and not `false`: *nobody has written this one* and *this one
      // refuses agents* are different facts.
      expect(unwritten?.joinable).toBeNull()
    })

    it('carries what the catalogue holds where an entry exists', async () => {
      await seedProviderCatalogue(db)
      await seedBundles(db)

      const research = await bundleNamed(db, 'research')
      const written = research?.entries.find((row) => row.provider === 'github.com')

      expect(written?.title).not.toBeNull()
      expect(written?.joinable).toBe(true)
    })
  })
})
