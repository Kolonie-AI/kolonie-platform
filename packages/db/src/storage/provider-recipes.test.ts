import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AccountKindSchema, looksLikeCredential, WriteProviderRecipeSchema } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { providerRecipe, providerRecipeList, writeProviderRecipe } from './provider-recipes.js'
import { PROVIDER_CATALOGUE, seedProviderCatalogue } from '../provider-catalogue.js'

const target = databaseTestTarget()

const kind = (value: string) => AccountKindSchema.parse(value)

/**
 * The provider catalogue (`#521`).
 *
 * **What is asserted here is that an entry is a row.** No migration, no verifier and
 * no code path per provider — which is the whole claim, so it is tested by writing an
 * entry for a provider nothing in this repository has ever heard of and reading it
 * back through the surface an agent uses.
 */
describe('the provider catalogue', () => {
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

  it('takes a provider the Colony has never heard of, as a row', async () => {
    await writeProviderRecipe(db, {
      kind: kind('linear'),
      provider: 'linear.app',
      title: 'A Linear workspace',
      joinable: true,
      steps: [
        { actor: 'agent', instruction: 'Vault a password, then sign up with your proved mailbox.' },
        { actor: 'agent', instruction: 'Forward the welcome mail to close a provider-mail proof.' },
      ],
      proves: 'provider-mail',
    })

    const found = await providerRecipe(db, kind('linear'), 'linear.app')

    expect(found).toMatchObject({
      kind: 'linear',
      provider: 'linear.app',
      joinable: true,
      proves: 'provider-mail',
    })
    expect(found?.steps).toHaveLength(2)
  })

  it('is found case-insensitively, because a provider is one normalised token', async () => {
    await writeProviderRecipe(db, {
      kind: kind('linear'),
      provider: 'linear.app',
      title: 'A Linear workspace',
      joinable: true,
      steps: [{ actor: 'agent', instruction: 'Sign up.' }],
      proves: 'provider-post',
    })

    expect(await providerRecipe(db, kind('linear'), 'LINEAR.APP')).toBeDefined()
  })

  it('replaces an entry rather than merging two versions of a walk', async () => {
    const entry = {
      kind: kind('linear'),
      provider: 'linear.app',
      title: 'A Linear workspace',
      joinable: true,
      proves: 'provider-post' as const,
    }

    await writeProviderRecipe(db, {
      ...entry,
      steps: [
        { actor: 'agent', instruction: 'Step one, as it stood on Monday.' },
        { actor: 'agent', instruction: 'Step two, as it stood on Monday.' },
      ],
    })
    await writeProviderRecipe(db, {
      ...entry,
      steps: [
        { actor: 'agent', instruction: 'The form changed on Tuesday and this is all of it.' },
      ],
    })

    const found = await providerRecipe(db, kind('linear'), 'linear.app')

    // Merged steps would be a walk nobody wrote.
    expect(found?.steps).toHaveLength(1)
    expect((await providerRecipeList(db)).length).toBe(1)
  })

  describe('what the shape refuses', () => {
    const refusedBy = async (statement: string): Promise<string | undefined> => {
      try {
        await db.execute(statement)
      } catch (error: unknown) {
        for (let current: unknown = error; current != null;) {
          if (typeof current === 'object' && 'constraint_name' in current) {
            return (current as { constraint_name?: string }).constraint_name
          }
          current =
            typeof current === 'object' && current !== null && 'cause' in current
              ? (current as { cause?: unknown }).cause
              : null
        }

        return 'refused by something that named no constraint'
      }

      return undefined
    }

    /**
     * **The checks are in SQL as well as in the request shape**, because the seed
     * writes through neither and a hand-written entry is the case this catalogue is
     * built to allow. Nothing in a Zod schema reaches a psql prompt.
     */
    it('refuses an unjoinable provider that does not say why', async () => {
      expect(
        await refusedBy(
          `insert into provider_recipes (kind, provider, title, joinable)
           values ('social', 'silent.example', 'Silent', false)`,
        ),
      ).toBe('provider_recipes_refusal_says_why')
    })

    it('refuses a joinable provider with no steps', async () => {
      expect(
        await refusedBy(
          `insert into provider_recipes (kind, provider, title, joinable, proves)
           values ('social', 'empty.example', 'Empty', true, 'rung')`,
        ),
      ).toBe('provider_recipes_joinable_has_steps')
    })

    it('refuses a joinable provider that never says how it is proved', async () => {
      expect(
        await refusedBy(
          `insert into provider_recipes (kind, provider, title, joinable, steps)
           values ('social', 'unproved.example', 'Unproved', true, '[{"actor":"agent","instruction":"sign up"}]')`,
        ),
      ).toBe('provider_recipes_joinable_has_steps')
    })

    it('refuses a refusal that carries steps anyway', async () => {
      expect(
        await refusedBy(
          `insert into provider_recipes (kind, provider, title, joinable, refusal, steps)
           values ('social', 'busy.example', 'Busy', false, 'no honest route',
                   '[{"actor":"agent","instruction":"sign up"}]')`,
        ),
      ).toBe('provider_recipes_refusal_is_empty')
    })

    it('holds one entry per provider per kind', async () => {
      await db.execute(
        `insert into provider_recipes (kind, provider, title, joinable, refusal)
         values ('social', 'twice.example', 'Twice', false, 'no honest route')`,
      )

      expect(
        await refusedBy(
          `insert into provider_recipes (kind, provider, title, joinable, refusal)
           values ('social', 'twice.example', 'Again', false, 'still no honest route')`,
        ),
      ).toBe('provider_recipes_kind_provider_unique')
    })
  })

  describe('the entries it starts with', () => {
    it('writes them, and writing twice changes nothing', async () => {
      expect(await seedProviderCatalogue(db)).toEqual({ written: PROVIDER_CATALOGUE.length })
      await seedProviderCatalogue(db)

      expect((await providerRecipeList(db)).length).toBe(PROVIDER_CATALOGUE.length)
    })

    /**
     * `#521`'s *done when*, asserted rather than counted: at least three, **one of
     * them a provider with no rung, and one of them a refusal**. A test that only
     * counted would pass on three entries that all demonstrated the same thing.
     */
    it('covers a rung, a provider with no rung, and a refusal', async () => {
      await seedProviderCatalogue(db)
      const entries = await providerRecipeList(db)

      expect(entries.length).toBeGreaterThanOrEqual(3)
      expect(entries.some((entry) => entry.proves === 'rung')).toBe(true)
      expect(entries.some((entry) => entry.joinable && entry.proves !== 'rung')).toBe(true)
      const refusal = entries.find((entry) => !entry.joinable)
      expect(refusal?.refusal).toBeTruthy()
      // A refusal has to date itself: it is a fact about somebody else's product.
      expect(refusal?.refusal).toMatch(/\d{4}-\d{2}-\d{2}/)
    })

    /**
     * **Every operator step names its ask, and the github entry has two** (`#517`).
     *
     * An earlier version of this test asserted exactly one, on the reading that a
     * recipe is *steps, one wall, steps*. That is the shape of most of them and it is
     * not a law: `github-account`'s briefing records that GitHub's terms forbid an
     * account registered by automated means, so on that provider the account
     * creation is itself the operator's — and the token that comes back is a second,
     * genuinely separate act through a different channel. Collapsing the two would
     * have meant asking an operator for a credential in the same breath as asking it
     * to accept terms, which is how a password ends up in a chat.
     *
     * So what is asserted is the property that actually matters: every operator step
     * carries the Colony's own sentence, and no step asks the operator to do the
     * agent's work.
     */
    it('gives every handoff a named ask rather than a narrated wall', async () => {
      await seedProviderCatalogue(db)
      const github = await providerRecipe(db, kind('github'), 'github.com')

      const handoff = github?.steps.filter((step) => step.actor === 'operator') ?? []
      expect(handoff.length).toBeGreaterThanOrEqual(1)
      for (const step of handoff) expect(step.ask).toBeTruthy()

      // Exactly one of them hands over a secret, and it goes through the drop.
      expect(handoff.filter((step) => step.secret === true)).toHaveLength(1)
      // And the operator is told not to send the password it chose.
      expect(handoff[0]?.ask).toContain('do not send it to your agent')
    })

    it('states every entry in the shape the write surface would accept', () => {
      // The seed bypasses `WriteProviderRecipeSchema`, so nothing else checks that
      // the declared entries would survive the route. Here they are held to it.
      for (const entry of PROVIDER_CATALOGUE) {
        expect(() => WriteProviderRecipeSchema.parse(entry)).not.toThrow()
      }
    })
  })
})

/**
 * Who fills the form, and what may never move in words (`#528`).
 *
 * **Held against the shipped entries rather than against a hypothetical one**,
 * because the rule is about content and the content is what gets edited. A test over
 * a fixture would pass forever while the real catalogue drifted.
 */
describe('what a recipe may ask an operator for', () => {
  it('never writes a credential into an ask', () => {
    for (const entry of PROVIDER_CATALOGUE) {
      for (const step of entry.steps) {
        if (step.ask === undefined) continue
        // The same guard the operator channels already apply to every message, so a
        // recipe cannot carry what a request would have refused anyway.
        expect(looksLikeCredential(step.ask)).toBe(false)
      }
    }
  })

  it('moves every secret through a drop, and only through a drop', () => {
    for (const entry of PROVIDER_CATALOGUE) {
      for (const step of entry.steps) {
        // `secret` is the only channel switch there is, and it is on the step rather
        // than in the wording — so no phrasing can route a value the wrong way.
        if (step.secret === true) expect(step.actor).toBe('operator')
      }
    }
  })

  it('has the agent vault its own credential where the provider allows it', () => {
    const trello = PROVIDER_CATALOGUE.find((entry) => entry.provider === 'trello.com')
    const first = trello?.steps[0]

    // The ordinary case: the agent generates the password and writes it to its own
    // vault *before* submitting anything. A password that exists only in a form
    // field is one lost restart away from an account nobody can enter.
    expect(first?.actor).toBe('agent')
    expect(first?.instruction).toContain('kolonie.vault.set')
    expect(trello?.steps.some((step) => step.actor === 'operator')).toBe(false)
  })

  /**
   * **The exception, asserted so that it stays an exception.** GitHub's terms forbid
   * an account registered by automated means, so there the operator creates it and
   * chooses the password. What must hold anyway is that the password does not move
   * and the token comes back sealed — if somebody later rewrites this entry to have
   * the operator send the password, this is what fails.
   */
  it('tells an operator who must choose a password not to send it', () => {
    const github = PROVIDER_CATALOGUE.find((entry) => entry.provider === 'github.com')
    const creating = github?.steps.find((step) => step.actor === 'operator' && step.secret !== true)

    expect(creating?.ask).toContain('do not send it to your agent')
    // And the thing the agent actually works through arrives through the drop.
    expect(github?.steps.filter((step) => step.secret === true)).toHaveLength(1)
  })
})
