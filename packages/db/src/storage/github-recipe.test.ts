import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { AccountKindSchema, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { PROVIDER_CATALOGUE, seedProviderCatalogue } from '../provider-catalogue.js'
import { providerRecipe } from './provider-recipes.js'
import { wishBlocksHandoff } from './account-wishes.js'

const target = databaseTestTarget()

/**
 * What the `github.com` recipe asks for, and what its task requires (`#596`).
 *
 * The recipe said *which of your **proved** addresses the account should use*.
 * `github-account` requires `accountKinds: ['mailbox']` — a declared mailbox —
 * so the recipe asked for something the Colony did not require and does not
 * check.
 *
 * **The run is the evidence, not an argument.** Walked 2026-08-08: agent
 * `colette` held two mailboxes, neither proved, and the task was in its takeable
 * list. The account was created, the launch code went to the unproved address,
 * and the agent read it out of its own inbox about ninety seconds later. A proof
 * would have added a step and prevented nothing.
 */
describe('the github.com recipe', () => {
  let db: Database
  let agentId: AgentId

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
    const [row] = await db.execute<{ id: string }>(
      sql`insert into agents (name, platform) values ('walker', 'claude') returning id`,
    )
    agentId = row?.id as AgentId
    await seedProviderCatalogue(db)
  })

  const githubEntry = () => providerRecipe(db, AccountKindSchema.parse('github'), 'github.com')

  it('asks for an address without demanding a proved one', async () => {
    const entry = await githubEntry()
    const first = entry?.steps[0]?.instruction ?? ''

    expect(first).toContain('which of your addresses')
    expect(first).not.toContain('proved')
  })

  /**
   * **What replaces it is the sentence that actually matters**, and it was said
   * nowhere before. The recovery address matters at recovery time; what matters
   * *now* is that the citizen can read the launch code, and what matters later
   * is that the domain outlives the provider.
   */
  it('says what to prefer instead, and why', async () => {
    const first = (await githubEntry())?.steps[0]?.instruction ?? ''

    expect(first).toContain('read now')
    expect(first).toContain('outlives the mailbox provider')
  })

  /**
   * The seeded entries reach the database with their prose, which is worth one
   * assertion because they did not until `#590`: `seedProviderCatalogue`
   * declared `about` and wrote it nowhere.
   */
  it('reaches the database with the paragraph it was declared with', async () => {
    const declared = PROVIDER_CATALOGUE.find((entry) => entry.provider === 'github.com')

    expect((await githubEntry())?.about).toBe(declared?.about ?? null)
  })

  /**
   * The rejection case `#596` names, at the layer that owns it.
   *
   * **A wish that is on the list and unmarked blocks the handoff**, and a
   * provider nobody has written down does not — the list is a plan and not a
   * permission system, so recording that you need something must never make
   * your own work harder. Whether the citizen holds a *mailbox* is the task's
   * gate rather than this one's, which is exactly the separation `#596` asks to
   * be enforced in one place instead of described in two.
   */
  it('is blocked by an unmarked wish and by nothing else on this path', async () => {
    await db.execute(
      sql`insert into account_wishes (agent_id, provider, author)
          values (${agentId}, 'github.com', 'citizen')`,
    )

    expect(await wishBlocksHandoff(db, agentId, 'github.com')).toBe(true)
    // A citizen holding no mailbox at all is not blocked *here*: the task
    // listing is what tells it which rung produces one.
    expect(await wishBlocksHandoff(db, agentId, 'nowhere.example')).toBe(false)
  })
  /**
   * The recipe passes its two values forward rather than telling the agent to
   * send them by hand (`#595`).
   *
   * Walked 2026-08-08: step 1 said *tell your operator both* and step 2 asked
   * the operator to use *the handle and the email address it gave you*. Step 1
   * has no channel, so the answer arrived underneath the ask.
   */
  describe('the handle and the address it passes forward', () => {
    it('declares them on the step that decides them', async () => {
      const recipe = await providerRecipe(db, AccountKindSchema.parse('github'), 'github.com')

      expect(recipe?.steps[0]?.produces).toEqual(['handle', 'address'])
      expect(recipe?.steps[0]?.knownValues).toEqual({
        handle: { kind: 'social' },
        address: { kind: 'mailbox', proved: true },
      })
    })

    it('refers to them inside the operator’s ask, not below it', async () => {
      const recipe = await providerRecipe(db, AccountKindSchema.parse('github'), 'github.com')
      const ask = recipe?.steps[1]?.ask ?? ''

      expect(ask).toContain('{handle}')
      expect(ask).toContain('{address}')
      // The sentence that made this a hand-carried message is gone from step 1.
      expect(recipe?.steps[0]?.instruction ?? '').not.toContain('tell your operator both')
    })
  })
})
