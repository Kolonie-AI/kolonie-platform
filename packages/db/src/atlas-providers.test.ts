import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AtlasCategorySchema } from '@kolonie-ai/core'
import type { Database } from './client.js'
import { connectForTests, databaseTestTarget, truncateAll } from './testing.js'
import {
  LISTED_ATLAS_ENTRIES,
  WALKED_PROVIDERS,
  curateListedAtlasEntries,
  seedListedAtlasEntries,
} from './atlas-providers.js'
import { PROVIDER_CATALOGUE, seedProviderCatalogue } from './provider-catalogue.js'
import {
  providerRecipe,
  providerRecipeList,
  writeProviderRecipe,
} from './storage/provider-recipes.js'

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

    /**
     * `#678`: the Academy has two rungs — `sms-receive` and `sms-send` — that
     * need a phone number an agent controls, and the catalogue had no shelf for
     * one. A citizen told *earn `phone`* opened fourteen shelves, none of which
     * was the one it was sent for.
     *
     * **The shelf is asserted to have more than one entry**, which is not
     * decoration: a category with a single provider reads as a recommendation,
     * and the Atlas makes no recommendations. It is also what stops the shelf
     * quietly becoming *use Twilio* the next time somebody prunes it.
     */
    it('has somewhere to send a citizen that needs a phone number', () => {
      const telephony = LISTED_ATLAS_ENTRIES.filter((entry) => entry.category === 'telephony')

      expect(telephony.map((entry) => entry.provider)).toEqual([
        'twilio.com',
        'vonage.com',
        'telnyx.com',
      ])
      expect(telephony.length).toBeGreaterThan(1)
    })

    /**
     * **The one measurement on the list says what it costs a citizen.** `#678`
     * asks for the Colony's own Twilio walk to land in the entry rather than be
     * rediscovered: the geography step has no API, and a number that has not
     * been enabled for the destination answers `21408` instead of failing where
     * you set it up. Both halves, because the error code is what a citizen
     * searches for at the moment it goes wrong.
     */
    it('records what the Colony learned from running Twilio', () => {
      const twilio = LISTED_ATLAS_ENTRIES.find((entry) => entry.provider === 'twilio.com')

      expect(WALKED_PROVIDERS).toContain('twilio.com')
      expect(twilio?.agentApi).toBe('partial')
      expect(twilio?.caution).toContain('console-only')
      expect(twilio?.caution).toContain('21408')
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

    /**
     * A guess is defensible on three shelves; everywhere else the answer is
     * silence.
     *
     * **`telephony` was the third and it arrived on `#678`.** The test is the
     * same one — a statute has to put the person there, not a product decision
     * somebody would have to check — and a number that can send or receive is
     * regulated supply in most jurisdictions. What it must not become is a list
     * of shelves that feel like they need an operator; that is the guess `#590`
     * forbids, and the reason this assertion names the set rather than counting
     * it.
     */
    it('guesses at the operator answer only where a statute puts a person in the way', () => {
      const guessed = new Set(
        LISTED_ATLAS_ENTRIES.filter((entry) => entry.operatorGuess !== undefined).map(
          (entry) => entry.category,
        ),
      )

      expect(guessed).toEqual(new Set(['payments-finance', 'commerce-marketplace', 'telephony']))
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
   * The eighteen nobody can walk (`#679`).
   *
   * **What is asserted here is that a judgement never overwrites evidence.** The
   * listing seed's one rule is that it must not write over a walk; this pass
   * makes a stronger claim than a listing does — *do not try* — so the same rule
   * matters more, not less.
   */
  describe('the eighteen nobody can walk', () => {
    const REFUSED = [
      'stripe.com',
      'paypal.com',
      'revolut.com',
      'wise.com',
      'coinbase.com',
      'kraken.com',
      'moonpay.com',
      'shopify.com',
      'etsy.com',
      'ebay.com',
      'sellercentral.amazon.com',
      'gumroad.com',
      'lemonsqueezy.com',
      'fiverr.com',
      'upwork.com',
    ]
    const WITHDRAWN = ['letsencrypt.org', 'obsidian.md', 'haveibeenpwned.com']

    it('refuses the fifteen that need a natural person, and withdraws the three that are not accounts', async () => {
      await seedListedAtlasEntries(db)

      expect(await curateListedAtlasEntries(db)).toEqual({
        refused: REFUSED.length,
        retired: WITHDRAWN.length,
        leftToTheirWalks: 0,
      })

      const stored = await providerRecipeList(db, undefined, { includeInternal: true })
      const byProvider = new Map(stored.map((entry) => [entry.provider, entry]))

      for (const provider of REFUSED) expect(byProvider.get(provider)?.status).toBe('refused')
      for (const provider of WITHDRAWN) expect(byProvider.get(provider)?.status).toBe('retired')
    })

    /** `#679`'s second criterion, and the one a citizen actually reads. */
    it('names a wall on every refusal and a reason on every withdrawal', async () => {
      await seedListedAtlasEntries(db)
      await curateListedAtlasEntries(db)

      const stored = await providerRecipeList(db, undefined, { includeInternal: true })
      const byProvider = new Map(stored.map((entry) => [entry.provider, entry]))

      for (const provider of REFUSED) {
        expect(byProvider.get(provider)?.refusal).toEqual(expect.stringContaining('natural person'))
      }
      for (const provider of WITHDRAWN) {
        expect(byProvider.get(provider)?.retiredReason).toEqual(
          expect.stringContaining('no account here to hold'),
        )
      }
    })

    /** `#679`'s first criterion, stated over the whole catalogue rather than the list. */
    it('leaves nothing joinable that nobody can join', async () => {
      await seedProviderCatalogue(db)
      await seedListedAtlasEntries(db)
      await curateListedAtlasEntries(db)

      const stored = await providerRecipeList(db, undefined, { includeInternal: true })
      const joinable = stored.filter((entry) => entry.status === 'joinable')

      for (const provider of [...REFUSED, ...WITHDRAWN]) {
        expect(joinable.map((entry) => entry.provider)).not.toContain(provider)
      }
    })

    it('changes nothing on a second run', async () => {
      await seedListedAtlasEntries(db)
      await curateListedAtlasEntries(db)
      const before = await providerRecipeList(db, undefined, { includeInternal: true })

      expect(await curateListedAtlasEntries(db)).toEqual({
        refused: 0,
        retired: 0,
        leftToTheirWalks: REFUSED.length + WITHDRAWN.length,
      })
      expect(await providerRecipeList(db, undefined, { includeInternal: true })).toEqual(before)
    })

    /**
     * **The one that matters most, and it is the mirror of the listing's.** A
     * citizen who walked `stripe.com` and got through has produced evidence, and
     * this list is a judgement made by somebody who did not walk it. Evidence
     * wins, and it wins silently rather than by the curator remembering to check.
     */
    it('passes over a provider somebody has since walked', async () => {
      await seedListedAtlasEntries(db)

      const listed = LISTED_ATLAS_ENTRIES.find((entry) => entry.provider === 'stripe.com')
      const walked = await writeProviderRecipe(db, {
        kind: listed?.kind as never,
        provider: 'stripe.com',
        title: 'Stripe',
        status: 'joinable',
        category: 'payments-finance',
        steps: [{ actor: 'agent', instruction: 'sign up' }],
        proves: 'provider-mail',
      })

      const result = await curateListedAtlasEntries(db)

      expect(result.refused).toBe(REFUSED.length - 1)
      expect(result.leftToTheirWalks).toBe(1)
      expect(await providerRecipe(db, walked.kind, 'stripe.com')).toEqual(walked)
    })

    /**
     * The drift `#680` is about, caught here rather than on a deploy: a name
     * curated in one list and dropped from the other is two halves disagreeing.
     */
    it('curates only providers that are on a shelf', async () => {
      await seedListedAtlasEntries(db)

      await expect(curateListedAtlasEntries(db)).resolves.toBeDefined()
    })
  })

  /**
   * `#680`: eleven `compute-hosting` entries read alike and three of them behave
   * nothing like the other eight.
   */
  describe('the shelf that asked no question about its API', () => {
    const ODD_ONES_OUT = ['contabo.com', 'oracle.com', 'scaleway.com']

    it('answers question two for every entry on the hosting shelf', async () => {
      await seedListedAtlasEntries(db)

      const hosting = (await providerRecipeList(db)).filter(
        (entry) => entry.category === 'compute-hosting',
      )

      expect(hosting.length).toBeGreaterThan(0)
      for (const entry of hosting) expect(entry.agentApi).not.toBe('unknown')
    })

    /** The three are told apart by what they say, not by being left off the shelf. */
    it('says what makes the three unlike their shelfmates, and leaves the eight alone', async () => {
      await seedListedAtlasEntries(db)

      const hosting = (await providerRecipeList(db)).filter(
        (entry) => entry.category === 'compute-hosting',
      )

      for (const entry of hosting) {
        if (ODD_ONES_OUT.includes(entry.provider)) {
          expect(entry.caution).not.toBeNull()
        } else {
          expect(entry.caution).toBeNull()
          expect(entry.agentApi).toBe('full')
        }
      }
    })

    /**
     * **Every caution says which of the two kinds it is.** `#590`'s rule is that
     * no listed entry may imply work was done, and a warning is the easiest
     * place to imply it by accident — so an unwalked entry's caution has to say
     * nobody has walked it.
     *
     * **`#678` added the other half rather than relaxing this one.** The Colony
     * runs `twilio.com`, so its caution is a finding, and requiring it to claim
     * nobody has walked it would have made the catalogue lie to protect a test.
     * Both directions are asserted: a walked entry may not borrow the unwalked
     * disclaimer either, because that is the same defect pointing the other way
     * and it would throw away the one measurement on the list.
     */
    it('says in every caution which kind of claim it is making', async () => {
      await seedListedAtlasEntries(db)

      const cautioned = (await providerRecipeList(db)).filter((entry) => entry.caution !== null)

      expect(cautioned.length).toBeGreaterThan(0)

      for (const entry of cautioned) {
        const caution = entry.caution?.toLowerCase() ?? ''

        if (WALKED_PROVIDERS.includes(entry.provider)) {
          expect(caution).toContain('measured')
          expect(caution).not.toContain('nobody has walked')
        } else {
          expect(caution).toContain('walk')
        }
      }
    })

    /**
     * Everywhere nobody has looked still says so, which is most of the
     * catalogue.
     *
     * **Derived from the answers rather than from a shelf name.** This filtered
     * on `category !== 'compute-hosting'` until `#678`, which was the same fact
     * written twice — the shelf somebody had read, and the map of what they
     * found. Adding `twilio.com` to the second broke the first, which is the
     * duplication announcing itself. Asking *which entries carry no answer* is
     * one record and stays true wherever the next walk happens.
     */
    it('leaves every entry nobody has looked at answering so', async () => {
      await seedListedAtlasEntries(db)

      const answered = new Set(
        LISTED_ATLAS_ENTRIES.filter((entry) => entry.agentApi !== undefined).map(
          (entry) => entry.provider,
        ),
      )
      const unanswered = (await providerRecipeList(db)).filter(
        (entry) => !answered.has(entry.provider),
      )

      expect(unanswered.length).toBeGreaterThan(0)

      for (const entry of unanswered) expect(entry.agentApi).toBe('unknown')
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
