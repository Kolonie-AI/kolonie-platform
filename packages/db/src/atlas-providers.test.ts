import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AtlasCategorySchema } from '@kolonie-ai/core'
import type { Database } from './client.js'
import { connectForTests, databaseTestTarget, truncateAll } from './testing.js'
import { LISTED_ATLAS_ENTRIES, seedListedAtlasEntries } from './atlas-providers.js'
import { PROVIDER_CATALOGUE, seedProviderCatalogue } from './provider-catalogue.js'
import { providerRecipe, providerRecipeList } from './storage/provider-recipes.js'

const target = databaseTestTarget()

/**
 * The providers the Atlas lists before anybody walks them (`#590`).
 *
 * **What is asserted here is that a listing claims nothing.** The seed exists to
 * make the Atlas a map, and a map that quietly implied the Colony had checked
 * ninety-six signups would be worse than the three-row catalogue it replaced —
 * so the tests are mostly about what these rows do *not* carry.
 */
describe('the providers the Atlas lists', () => {
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

  describe('the list itself, before it reaches a database', () => {
    it('names every provider once, so no shelf can claim one twice', () => {
      const providers = LISTED_ATLAS_ENTRIES.map((entry) => entry.provider)

      expect(new Set(providers).size).toBe(providers.length)
    })

    it('gives every entry a category from the closed vocabulary', () => {
      for (const entry of LISTED_ATLAS_ENTRIES) {
        expect(AtlasCategorySchema.safeParse(entry.category).success).toBe(true)
      }
    })

    /**
     * **The three the catalogue already walked keep the kind their rows carry.**
     * Otherwise the listing would insert a second row for the same provider under
     * a different kind, and the Atlas page would show a recipe beside *nobody has
     * looked* for one provider.
     */
    it('reuses the kind of every provider the catalogue already holds', () => {
      for (const walked of PROVIDER_CATALOGUE) {
        const listed = LISTED_ATLAS_ENTRIES.find((one) => one.provider === walked.provider)

        expect(listed?.kind).toBe(walked.kind)
      }
    })

    /** A guess is defensible on two shelves; everywhere else the answer is silence. */
    it('guesses at the operator answer only where a statute puts a person in the way', () => {
      const guessed = new Set(
        LISTED_ATLAS_ENTRIES.filter((entry) => entry.operatorGuess !== undefined).map(
          (entry) => entry.category,
        ),
      )

      expect(guessed).toEqual(new Set(['payments-finance', 'commerce-marketplace']))
    })
  })

  describe('what it writes', () => {
    it('lists every provider on the list, with a category and no steps', async () => {
      await seedListedAtlasEntries(db)

      const stored = await providerRecipeList(db)

      expect(stored).toHaveLength(LISTED_ATLAS_ENTRIES.length)
      for (const entry of stored) {
        expect(AtlasCategorySchema.safeParse(entry.category).success).toBe(true)
        expect(entry.status).toBe('unwritten')
        expect(entry.steps).toHaveLength(0)
        expect(entry.proves).toBeNull()
        expect(entry.refusal).toBeNull()
      }
    })

    it('reports what it changed, so a deploy log can tell a first run from a second', async () => {
      const first = await seedListedAtlasEntries(db)
      const second = await seedListedAtlasEntries(db)

      expect(first).toEqual({ listed: LISTED_ATLAS_ENTRIES.length, untouched: 0 })
      expect(second).toEqual({ listed: 0, untouched: LISTED_ATLAS_ENTRIES.length })
    })

    it('changes nothing on a second run', async () => {
      await seedListedAtlasEntries(db)
      const before = await providerRecipeList(db)
      await seedListedAtlasEntries(db)

      expect(await providerRecipeList(db)).toEqual(before)
    })

    it('marks a guessed operator answer as a guess', async () => {
      await seedListedAtlasEntries(db)

      const stripe = await providerRecipe(db, 'payments' as never, 'stripe.com')

      expect(stripe?.operatorNeed).toBe('operator-needed')
      expect(stripe?.operatorNeedIsGuess).toBe(true)
    })

    it('answers unknown, unguessed, where nobody has looked and nothing was assumed', async () => {
      await seedListedAtlasEntries(db)

      const proton = await providerRecipe(db, 'mailbox' as never, 'proton.me')

      expect(proton?.operatorNeed).toBe('unknown')
      expect(proton?.operatorNeedIsGuess).toBe(false)
    })
  })

  /**
   * **The one that matters most.** A listing arriving over a walked recipe would
   * not merely lose the steps — it would replace *this is how you join* with
   * *nobody has looked*, erasing the fact that anybody ever did.
   */
  describe('what it must never touch', () => {
    it('leaves a walked recipe exactly as it found it', async () => {
      await seedProviderCatalogue(db)
      const walked = await providerRecipeList(db)

      await seedListedAtlasEntries(db)

      for (const before of walked) {
        const after = await providerRecipe(db, before.kind, before.provider)

        expect(after).toEqual(before)
      }
    })

    it('lists the rest alongside them rather than instead of them', async () => {
      await seedProviderCatalogue(db)
      const { listed, untouched } = await seedListedAtlasEntries(db)

      expect(untouched).toBe(PROVIDER_CATALOGUE.length)
      expect(listed).toBe(LISTED_ATLAS_ENTRIES.length - PROVIDER_CATALOGUE.length)

      const stored = await providerRecipeList(db)
      expect(stored).toHaveLength(LISTED_ATLAS_ENTRIES.length)
      expect(stored.filter((entry) => entry.status === 'joinable')).toHaveLength(2)
      expect(stored.filter((entry) => entry.status === 'refused')).toHaveLength(1)
    })

    /**
     * `#590`'s third rule. A refusal is a finding with a reason attached, and
     * none of these has been examined — `bsky.app` is refused because somebody
     * looked, and it stays that way because the listing does not write over it.
     */
    it('lists nothing as refused', async () => {
      await seedListedAtlasEntries(db)

      expect(await providerRecipeList(db)).not.toContainEqual(
        expect.objectContaining({ status: 'refused' }),
      )
    })
  })

  /**
   * The rejection case `#590` asks for, at the database rather than in the seed.
   *
   * The listing path cannot write steps — it passes an empty array — so what is
   * asserted is that the row shape it uses could not carry them even if a later
   * edit tried, which is `#588`'s constraint doing its job for this seed.
   */
  it('refuses a listed row that carries steps', async () => {
    await expect(
      db.execute(
        `insert into provider_recipes (kind, provider, title, status, category, steps)
         values ('mailbox', 'listed.example', 'Listed', 'unwritten', 'mailbox',
                 '[{"actor":"agent","instruction":"sign up"}]')`,
      ),
    ).rejects.toThrow()
  })
})
