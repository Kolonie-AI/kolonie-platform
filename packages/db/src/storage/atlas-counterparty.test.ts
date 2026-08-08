import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { AccountKindSchema } from '@kolonie-ai/core'
import type { RecipeStatus } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import {
  decideProposal,
  pendingProposals,
  proposeEntryChange,
  providerClaim,
  recordProviderClaim,
} from './atlas-counterparty.js'
import { writeProviderRecipe } from './provider-recipes.js'

const target = databaseTestTarget()
const kind = AccountKindSchema.parse('social')

const REFERRAL = {
  url: 'https://example.test/ref/kolonie',
  termsNote: 'Programme terms read 2026-08-08; agent signups are not excluded.',
  checkedBy: 'the maintainer',
  checkedAt: '2026-08-08T00:00:00.000Z',
}

/**
 * The counterparty side of an Atlas entry (`#548`).
 *
 * The interesting properties are all refusals: what a provider cannot do to its
 * own entry, and what the schema does not contain.
 */
describe('an entry’s paying counterparty', () => {
  let db: Database

  const entry = async (provider: string, status: RecipeStatus) =>
    writeProviderRecipe(db, {
      kind,
      provider,
      title: provider,
      status,
      ...(status === 'joinable'
        ? {
            steps: [{ actor: 'agent' as const, instruction: 'sign up' }],
            proves: 'provider-post' as const,
          }
        : status === 'refused'
          ? { refusal: 'No honest signup route exists.', steps: [] }
          : { steps: [] }),
    })

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  describe('a claim', () => {
    it('records how the provider proved it, and how to reach them', async () => {
      await recordProviderClaim(db, {
        provider: 'example.test',
        method: 'well-known',
        contact: 'jo@example.test',
      })

      const claim = await providerClaim(db, 'example.test')

      expect(claim?.method).toBe('well-known')
      expect(claim?.contact).toBe('jo@example.test')
    })

    it('says nothing about a provider nobody has claimed', async () => {
      expect(await providerClaim(db, 'unclaimed.test')).toBeUndefined()
    })
  })

  describe('a claimed provider proposes and does not edit', () => {
    it('files a proposal rather than changing the entry', async () => {
      await entry('example.test', 'joinable')

      const result = await proposeEntryChange(db, {
        kind,
        provider: 'example.test',
        author: 'claimed-provider',
        proposed: { title: 'Our new name' },
        note: 'We renamed the product.',
      })

      expect(result.outcome).toBe('filed')
      expect((await pendingProposals(db))[0]?.status).toBe('pending')
    })

    /**
     * **The change a provider may never make about itself.** A provider that
     * could clear its own refusal could clear it the day it was written, and
     * every refusal in the Atlas would then mean *nobody has paid to have this
     * removed yet*.
     */
    it('refuses a proposal that would clear a finding about itself', async () => {
      await entry('walled.test', 'refused')

      const result = await proposeEntryChange(db, {
        kind,
        provider: 'walled.test',
        author: 'claimed-provider',
        proposed: { status: 'joinable' },
      })

      expect(result.outcome).toBe('refused')
      expect(await pendingProposals(db)).toHaveLength(0)
    })

    /**
     * **Including by moving it to `unwritten`** (`#588`), which erases a walked
     * finding as thoroughly as declaring the provider joinable does and is the
     * cheaper move to miss. The rule is about the refusal leaving, not about
     * which state it leaves for.
     */
    it('refuses it however the refusal is emptied rather than flipped', async () => {
      await entry('walled.test', 'refused')

      for (const proposed of [{ refusal: null }, { refusal: '' }, { status: 'unwritten' }]) {
        const result = await proposeEntryChange(db, {
          kind,
          provider: 'walled.test',
          author: 'claimed-provider',
          proposed,
        })

        expect(result.outcome).toBe('refused')
      }
    })

    /**
     * **A citizen saying *I got in* is the evidence; a provider saying *you can
     * get in* is a claim about its own product.** The asymmetry is the point.
     */
    it('takes the same proposal from a citizen', async () => {
      await entry('walled.test', 'refused')

      const result = await proposeEntryChange(db, {
        kind,
        provider: 'walled.test',
        author: 'citizen',
        proposed: { status: 'joinable' },
        note: 'I got through on 2026-08-08; here is what changed.',
      })

      expect(result.outcome).toBe('filed')
    })

    it('lets a provider correct a working entry, which is the useful case', async () => {
      await entry('example.test', 'joinable')

      const result = await proposeEntryChange(db, {
        kind,
        provider: 'example.test',
        author: 'claimed-provider',
        proposed: { caution: 'Our confirmation mail moved to a different sender.' },
      })

      expect(result.outcome).toBe('filed')
    })
  })

  describe('the review queue', () => {
    it('holds both authors’ proposals in one queue', async () => {
      await entry('example.test', 'joinable')
      await proposeEntryChange(db, {
        kind,
        provider: 'example.test',
        author: 'citizen',
        proposed: { title: 'a' },
      })
      await proposeEntryChange(db, {
        kind,
        provider: 'example.test',
        author: 'claimed-provider',
        proposed: { title: 'b' },
      })

      expect((await pendingProposals(db)).map((one) => one.author)).toEqual([
        'citizen',
        'claimed-provider',
      ])
    })

    it('takes a decision once and leaves nothing pending', async () => {
      await entry('example.test', 'joinable')
      const filed = await proposeEntryChange(db, {
        kind,
        provider: 'example.test',
        author: 'citizen',
        proposed: { title: 'a' },
      })
      if (filed.outcome !== 'filed') throw new Error('expected it to be filed')

      expect((await decideProposal(db, filed.proposal.id, 'accepted'))?.status).toBe('accepted')
      expect(await decideProposal(db, filed.proposal.id, 'refused')).toBeUndefined()
      expect(await pendingProposals(db)).toHaveLength(0)
    })
  })

  describe('a referral arrangement', () => {
    it('is stored with the record of the terms check', async () => {
      const written = await writeProviderRecipe(db, {
        kind,
        provider: 'example.test',
        title: 'Example',
        status: 'joinable',
        steps: [{ actor: 'agent', instruction: 'sign up' }],
        proves: 'provider-post',
        referral: REFERRAL,
        contact: 'jo@example.test',
      })

      expect(written.referral?.termsNote).toContain('not excluded')
      expect(written.contact).toBe('jo@example.test')
    })

    /**
     * **No link without a recorded check**, in the database as well as in the
     * write shape — a psql prompt writes through neither, and a link nobody
     * checked is the one that breaks a programme's terms in the Colony's name.
     */
    it('is refused by the database when the check was not recorded', async () => {
      await entry('example.test', 'joinable')

      await expect(
        db.execute(sql`
          update provider_recipes
             set referral = ${JSON.stringify({ url: 'https://example.test/ref' })}::jsonb
           where provider = 'example.test'
        `),
      ).rejects.toThrow()
    })

    it('is refused when the terms note is empty', async () => {
      await entry('example.test', 'joinable')

      await expect(
        db.execute(sql`
          update provider_recipes
             set referral = ${JSON.stringify({ ...REFERRAL, termsNote: '' })}::jsonb
           where provider = 'example.test'
        `),
      ).rejects.toThrow()
    })
  })
})

/**
 * **There is no orderable or manually settable position anywhere in the schema**
 * (`#548`).
 *
 * `#543` states that paying buys nothing about ordering, and `#545` derives the
 * order from the measurements on every read. A field that exists will eventually
 * be set — so the enforcement is that none exists, and this is what checks it
 * rather than a paragraph asking the next person to remember.
 */
describe('nothing in the schema can be ordered by hand', () => {
  const schemaDir = fileURLToPath(new URL('../schema', import.meta.url))

  /**
   * Words that would name a settable position. `order` alone is deliberately not
   * among them: `recommendedOrder` on a task is the Academy's suggested sequence
   * and predates all of this, and a check that flagged it would be red the day it
   * was written.
   */
  const forbidden = [/\bposition\b/i, /\brank\b/i, /sortOrder/i, /manualOrder/i, /pinned/i]

  it("names no position, rank or pin in any Atlas table's columns", () => {
    const atlasSchemas = readdirSync(schemaDir).filter(
      (name) => name.startsWith('atlas-') || name.startsWith('provider-'),
    )

    const offenders = atlasSchemas.filter((name) => {
      const text = readFileSync(join(schemaDir, name), 'utf8')
      return forbidden.some((pattern) => pattern.test(text))
    })

    expect(offenders).toEqual([])
  })
})
