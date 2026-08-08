import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  AccountKindSchema,
  AtlasCategorySchema,
  looksLikeCredential,
  WriteProviderRecipeSchema,
} from '@kolonie-ai/core'
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
      status: 'joinable',
      category: 'code-hosting',
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
      status: 'joinable',
      category: 'code-hosting',
      proves: 'provider-mail',
    })
    expect(found?.steps).toHaveLength(2)
  })

  it('is found case-insensitively, because a provider is one normalised token', async () => {
    await writeProviderRecipe(db, {
      kind: kind('linear'),
      provider: 'linear.app',
      title: 'A Linear workspace',
      status: 'joinable',
      category: 'code-hosting',
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
      status: 'joinable' as const,
      category: 'code-hosting' as const,
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
          `insert into provider_recipes (kind, provider, title, status, category)
           values ('social', 'silent.example', 'Silent', 'refused', 'social-publishing')`,
        ),
      ).toBe('provider_recipes_refusal_says_why')
    })

    it('refuses a joinable provider with no steps', async () => {
      expect(
        await refusedBy(
          `insert into provider_recipes (kind, provider, title, status, category, proves)
           values ('social', 'empty.example', 'Empty', 'joinable', 'social-publishing', 'rung')`,
        ),
      ).toBe('provider_recipes_joinable_has_steps')
    })

    it('refuses a joinable provider that never says how it is proved', async () => {
      expect(
        await refusedBy(
          `insert into provider_recipes (kind, provider, title, status, category, steps)
           values ('social', 'unproved.example', 'Unproved', 'joinable', 'social-publishing', '[{"actor":"agent","instruction":"sign up"}]')`,
        ),
      ).toBe('provider_recipes_joinable_has_steps')
    })

    it('refuses a refusal that carries steps anyway', async () => {
      expect(
        await refusedBy(
          `insert into provider_recipes (kind, provider, title, status, category, refusal, steps)
           values ('social', 'busy.example', 'Busy', 'refused', 'social-publishing', 'no honest route',
                   '[{"actor":"agent","instruction":"sign up"}]')`,
        ),
      ).toBe('provider_recipes_unjoinable_is_empty')
    })

    /**
     * The state `#588` exists for: an entry the Atlas lists and nobody has
     * walked. It is the row the two constraints it replaced rejected outright,
     * which is why `#590` had nothing it could seed.
     */
    it('takes an entry with no steps, no proof and no refusal', async () => {
      await db.execute(
        `insert into provider_recipes (kind, provider, title, status, category)
         values ('mailbox', 'fastmail.com', 'Fastmail', 'unwritten', 'mailbox')`,
      )

      const found = await providerRecipe(db, kind('mailbox'), 'fastmail.com')

      expect(found).toMatchObject({ status: 'unwritten', refusal: null, proves: null })
      expect(found?.steps).toHaveLength(0)
    })

    /**
     * **Rejected by the database rather than by application code**, which is the
     * whole point of putting it here: a partial recipe wearing the honest label
     * is one that fails at step three for whoever trusts it, and the seed and a
     * psql prompt both write through neither Zod schema.
     */
    it('refuses an unwritten entry that carries steps anyway', async () => {
      expect(
        await refusedBy(
          `insert into provider_recipes (kind, provider, title, status, category, steps)
           values ('mailbox', 'half.example', 'Half', 'unwritten', 'mailbox',
                   '[{"actor":"agent","instruction":"sign up"}]')`,
        ),
      ).toBe('provider_recipes_unjoinable_is_empty')
    })

    it('refuses an unwritten entry that carries a refusal', async () => {
      expect(
        await refusedBy(
          `insert into provider_recipes (kind, provider, title, status, category, refusal)
           values ('mailbox', 'both.example', 'Both', 'unwritten', 'mailbox', 'no honest route')`,
        ),
      ).toBe('provider_recipes_refusal_says_why')
    })

    /**
     * `#589`'s acceptance criterion, asserted by inserting every one of them.
     *
     * **The two vocabularies are the same set or this fails**, which is the only
     * check that catches the case that actually happens: a category added in
     * `core`, the migration forgotten, and a write shape that accepts a value the
     * database refuses. Counting them would pass on fourteen of the wrong ones.
     */
    it('takes every category core defines, and nothing else', async () => {
      for (const category of AtlasCategorySchema.options) {
        await db.execute(
          `insert into provider_recipes (kind, provider, title, status, category)
           values ('mailbox', '${category}.example', '${category}', 'unwritten', '${category}')`,
        )
      }

      const stored = await providerRecipeList(db)

      expect(new Set(stored.map((entry) => entry.category))).toEqual(
        new Set(AtlasCategorySchema.options),
      )
    })

    it('refuses a category nobody defined', async () => {
      expect(
        await refusedBy(
          `insert into provider_recipes (kind, provider, title, status, category)
           values ('mailbox', 'shelf.example', 'Shelf', 'unwritten', 'miscellaneous')`,
        ),
      ).toBe('provider_recipes_category_is_known')
    })

    /**
     * **The disagreement is unrepresentable rather than caught** (`#589`). An
     * entry with steps answers the operator question in the steps; a stored
     * answer beside them is `D-002`'s second record, and it would go stale the
     * day somebody edits step three.
     */
    it('refuses a stored operator answer on an entry that has steps', async () => {
      expect(
        await refusedBy(
          `insert into provider_recipes (kind, provider, title, status, category, proves, steps,
                                         operator_guess)
           values ('mailbox', 'both.example', 'Both', 'joinable', 'mailbox', 'rung',
                   '[{"actor":"agent","instruction":"sign up"}]', 'unaided')`,
        ),
      ).toBe('provider_recipes_operator_guess_only_without_steps')
    })

    it('refuses a guess that is not one of the two guessable answers', async () => {
      expect(
        await refusedBy(
          `insert into provider_recipes (kind, provider, title, status, category, operator_guess)
           values ('mailbox', 'vague.example', 'Vague', 'unwritten', 'mailbox', 'unknown')`,
        ),
      ).toBe('provider_recipes_operator_guess_is_known')
    })

    it('refuses a fourth state nobody defined', async () => {
      expect(
        await refusedBy(
          `insert into provider_recipes (kind, provider, title, status, category)
           values ('mailbox', 'maybe.example', 'Maybe', 'probably', 'mailbox')`,
        ),
      ).toBe('provider_recipes_status_is_known')
    })

    it('holds one entry per provider per kind', async () => {
      await db.execute(
        `insert into provider_recipes (kind, provider, title, status, category, refusal)
         values ('social', 'twice.example', 'Twice', 'refused', 'social-publishing', 'no honest route')`,
      )

      expect(
        await refusedBy(
          `insert into provider_recipes (kind, provider, title, status, category, refusal)
           values ('social', 'twice.example', 'Again', 'refused', 'social-publishing', 'still no honest route')`,
        ),
      ).toBe('provider_recipes_kind_provider_unique')
    })
  })

  /**
   * Who has to be there, answered on the way out of storage (`#589`).
   *
   * Asserted here rather than only in `core` because the point is that the one
   * derivation runs where rows come from — a surface that read the column
   * directly could not get a different answer, because there is no column.
   */
  describe('who has to be there', () => {
    it('reads operator-needed off a walked step, with no stored answer anywhere', async () => {
      await writeProviderRecipe(db, {
        kind: kind('github'),
        provider: 'github.example',
        title: 'GitHub',
        status: 'joinable',
        category: 'code-hosting',
        steps: [
          { actor: 'agent', instruction: 'Name the handle.' },
          { actor: 'operator', instruction: 'Accept the terms.', ask: 'Please accept the terms.' },
        ],
        proves: 'rung',
      })

      const found = await providerRecipe(db, kind('github'), 'github.example')

      expect(found?.operatorNeed).toBe('operator-needed')
      expect(found?.operatorNeedIsGuess).toBe(false)
    })

    it('reads unaided when no step is the operator’s', async () => {
      await writeProviderRecipe(db, {
        kind: kind('trello'),
        provider: 'trello.example',
        title: 'Trello',
        status: 'joinable',
        category: 'project-tracking',
        steps: [{ actor: 'agent', instruction: 'Sign up.' }],
        proves: 'provider-mail',
      })

      expect((await providerRecipe(db, kind('trello'), 'trello.example'))?.operatorNeed).toBe(
        'unaided',
      )
    })

    it('answers unknown for an entry nobody has walked and nobody guessed at', async () => {
      await writeProviderRecipe(db, {
        kind: kind('mailbox'),
        provider: 'fastmail.example',
        title: 'Fastmail',
        status: 'unwritten',
        category: 'mailbox',
        steps: [],
      })

      const found = await providerRecipe(db, kind('mailbox'), 'fastmail.example')

      expect(found?.operatorNeed).toBe('unknown')
      expect(found?.operatorNeedIsGuess).toBe(false)
    })

    /** A guess comes back marked, so no surface can render it as an answer. */
    it('marks a seeded guess as a guess', async () => {
      await writeProviderRecipe(db, {
        kind: kind('mailbox'),
        provider: 'guessed.example',
        title: 'Guessed',
        status: 'unwritten',
        category: 'mailbox',
        operatorGuess: 'unaided',
        steps: [],
      })

      const found = await providerRecipe(db, kind('mailbox'), 'guessed.example')

      expect(found?.operatorNeed).toBe('unaided')
      expect(found?.operatorNeedIsGuess).toBe(true)
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
      expect(entries.some((entry) => entry.status === 'joinable' && entry.proves !== 'rung')).toBe(
        true,
      )
      const refusal = entries.find((entry) => entry.status === 'refused')
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
