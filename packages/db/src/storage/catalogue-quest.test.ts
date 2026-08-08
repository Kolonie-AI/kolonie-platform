import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  AccountKindSchema,
  RECIPE_STALE_AFTER_DAYS,
  RegisterAgentRequestSchema,
  isStale,
  type AgentId,
} from '@kolonie-ai/core'
import { sql } from 'drizzle-orm'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { submitCatalogueEntry } from './catalogue-quest.js'
import { pendingProposals } from './atlas-counterparty.js'
import { confirmProviderRecipe, providerRecipe, writeProviderRecipe } from './provider-recipes.js'
import { reportProvider } from './provider-reports.js'
import { registerAgent } from './agents.js'

const target = databaseTestTarget()
const kind = AccountKindSchema.parse('notion')

/**
 * A citizen writing a catalogue entry (`#525`).
 *
 * The catalogue grows only as fast as the maintainer writes entries, and the
 * citizens are the ones who find out.
 */
describe('a catalogue entry handed in by a citizen', () => {
  let db: Database
  let seeded = 0

  const citizen = async (): Promise<AgentId> => {
    const result = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name: `walker-${++seeded}`, platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    return result.agent.id
  }

  const entry = async (provider: string) =>
    writeProviderRecipe(db, {
      kind,
      provider,
      title: provider,
      joinable: true,
      steps: [{ actor: 'agent', instruction: 'sign up' }],
      proves: 'provider-mail',
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

  /**
   * **The same queue a claimed provider's correction lands in** (`#548`).
   * `#525` asks that a submission be moderated and reviewed exactly as any
   * quest; a second queue would be a second standard for one judgement.
   */
  it('becomes a proposal in the one review queue, applied to nothing', async () => {
    const result = await submitCatalogueEntry(db, {
      kind,
      provider: 'notion.so',
      title: 'A Notion workspace',
      joinable: true,
      steps: [{ actor: 'agent', instruction: 'Sign up with the mailbox you proved.' }],
      proves: 'provider-mail',
    })

    expect(result.outcome).toBe('filed')
    expect((await pendingProposals(db))[0]?.author).toBe('citizen')
    // Nothing was written to the catalogue: a wrong recipe is worse than none.
    expect(await providerRecipe(db, kind, 'notion.so')).toBeUndefined()
  })

  /** A refusal takes exactly the same path as a working walk. */
  it('files a refusal finding on the same terms as a recipe', async () => {
    const result = await submitCatalogueEntry(db, {
      kind: AccountKindSchema.parse('social'),
      provider: 'walled.test',
      title: 'Walled — no honest route in',
      joinable: false,
      refusal: 'Signup requires a phone number no citizen can hold.',
      steps: [],
    })

    expect(result.outcome).toBe('filed')
    expect((await pendingProposals(db))[0]?.author).toBe('citizen')
  })

  describe('when an entry was last confirmed to work', () => {
    it('records a confirmation without touching the recipe', async () => {
      await entry('notion.so')
      const walker = await citizen()

      await confirmProviderRecipe(db, kind, 'notion.so', walker)

      const found = await providerRecipe(db, kind, 'notion.so')

      expect(isStale(found?.lastConfirmedAt ?? null)).toBe(false)
      expect(found?.steps).toHaveLength(1)
    })

    /**
     * **A curation edit neither confirms nor un-confirms.**
     *
     * Both halves matter and they pull opposite ways. Somebody fixing a typo
     * must not reset the clock on *has anyone actually done this lately* — that
     * is how the stale mark stops meaning anything. And it must not clear the
     * clock either, or every correction would mark a working entry as a guess,
     * which teaches readers to ignore the mark just as effectively.
     *
     * So the edit leaves the date exactly where it was, and only
     * `confirmProviderRecipe` and a failed walk move it.
     */
    it('leaves the confirmation exactly where it was when the entry is edited', async () => {
      await entry('notion.so')
      await confirmProviderRecipe(db, kind, 'notion.so', await citizen())
      const before = (await providerRecipe(db, kind, 'notion.so'))?.lastConfirmedAt

      await entry('notion.so')

      expect((await providerRecipe(db, kind, 'notion.so'))?.lastConfirmedAt).toBe(before)
    })

    it('starts unconfirmed, which reads exactly as stale', async () => {
      await entry('notion.so')

      const found = await providerRecipe(db, kind, 'notion.so')

      expect(found?.lastConfirmedAt).toBeNull()
      expect(isStale(found?.lastConfirmedAt ?? null)).toBe(true)
    })

    it(`is stale again once the confirmation is older than ${RECIPE_STALE_AFTER_DAYS} days`, async () => {
      await entry('notion.so')
      await confirmProviderRecipe(db, kind, 'notion.so', await citizen())
      await db.execute(sql`
        update provider_recipes
           set last_confirmed_at = now() - (${sql.raw(String(RECIPE_STALE_AFTER_DAYS + 1))} * interval '1 day')
      `)

      const found = await providerRecipe(db, kind, 'notion.so')

      expect(isStale(found?.lastConfirmedAt ?? null)).toBe(true)
    })
  })

  /**
   * **Following an entry and failing marks it stale**, through the report an
   * agent already files rather than through a second reporting path.
   */
  describe('when somebody follows an entry and does not get through', () => {
    it('marks the entry stale from the ordinary provider report', async () => {
      await entry('notion.so')
      const walker = await citizen()
      await confirmProviderRecipe(db, kind, 'notion.so', walker)

      await reportProvider(db, await citizen(), {
        kind,
        provider: 'notion.so',
        outcome: 'signup-refused',
      })

      expect((await providerRecipe(db, kind, 'notion.so'))?.lastConfirmedAt).toBeNull()
    })

    it('leaves a provider with no entry alone', async () => {
      await expect(
        reportProvider(db, await citizen(), {
          kind,
          provider: 'nobody-wrote-this.test',
          outcome: 'abandoned',
        }),
      ).resolves.toEqual({ outcome: 'recorded' })
    })
  })
})
