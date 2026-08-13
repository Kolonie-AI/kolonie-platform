import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  AccountKindSchema,
  AtlasCategorySchema,
  looksLikeCredential,
  WriteProviderRecipeSchema,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import {
  dressProviderRecipeDraft,
  providerRecipe,
  providerRecipeList,
  writeProviderRecipe,
} from './provider-recipes.js'
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

    it('refuses a seventh state nobody defined', async () => {
      expect(
        await refusedBy(
          `insert into provider_recipes (kind, provider, title, status, category)
           values ('mailbox', 'maybe.example', 'Maybe', 'probably', 'mailbox')`,
        ),
      ).toBe('provider_recipes_status_is_known')
    })

    /**
     * The three states `#604` added, one rejection case per constraint.
     *
     * **In SQL and not only in `WriteProviderRecipeSchema`**, for the reason the
     * block above states: the seed and a psql prompt write through neither Zod
     * schema, and every one of these is a shape somebody would reasonably type
     * by hand.
     */
    it('takes a proposal, which carries nothing at all', async () => {
      expect(
        await refusedBy(
          `insert into provider_recipes (kind, provider, title, status, category)
           values ('mailbox', 'asked.example', 'Asked for', 'proposed', 'mailbox')`,
        ),
      ).toBeUndefined()
    })

    it('refuses a proposal that carries steps', async () => {
      expect(
        await refusedBy(
          `insert into provider_recipes (kind, provider, title, status, category, steps)
           values ('mailbox', 'asked2.example', 'Asked', 'proposed', 'mailbox',
                   '[{"actor":"agent","instruction":"sign up"}]')`,
        ),
      ).toBe('provider_recipes_unjoinable_is_empty')
    })

    /**
     * **The one state that carries steps without a proof**, and the reason it is
     * allowed to is that no public surface reads it: a walk that got an account
     * and did not work out how to prove it is a real outcome and a reviewable
     * one. Refusing to store it would leave the walk in a GitHub issue, which is
     * the defect `#601` is named for.
     */
    it('takes a draft with steps and no proof', async () => {
      expect(
        await refusedBy(
          `insert into provider_recipes (kind, provider, title, status, category, steps)
           values ('mailbox', 'walked.example', 'Walked', 'draft', 'mailbox',
                   '[{"actor":"agent","instruction":"sign up"}]')`,
        ),
      ).toBeUndefined()
    })

    it('refuses a draft with no steps, because that is an unwritten entry', async () => {
      expect(
        await refusedBy(
          `insert into provider_recipes (kind, provider, title, status, category)
           values ('mailbox', 'empty.example', 'Empty draft', 'draft', 'mailbox')`,
        ),
      ).toBe('provider_recipes_joinable_has_steps')
    })

    it('takes a withdrawal that keeps its steps, its proof and a reason', async () => {
      expect(
        await refusedBy(
          `insert into provider_recipes
             (kind, provider, title, status, category, steps, proves, retired_at, retired_reason)
           values ('mailbox', 'gone.example', 'Gone', 'retired', 'mailbox',
                   '[{"actor":"agent","instruction":"sign up"}]', 'rung', now(),
                   'the provider began demanding a phone number')`,
        ),
      ).toBeUndefined()
    })

    it('refuses a withdrawal that does not say why', async () => {
      expect(
        await refusedBy(
          `insert into provider_recipes (kind, provider, title, status, category, retired_at)
           values ('mailbox', 'silent-exit.example', 'Silent exit', 'retired', 'mailbox', now())`,
        ),
      ).toBe('provider_recipes_retirement_says_when_and_why')
    })

    it('refuses a withdrawal with no date on it', async () => {
      expect(
        await refusedBy(
          `insert into provider_recipes (kind, provider, title, status, category, retired_reason)
           values ('mailbox', 'undated.example', 'Undated', 'retired', 'mailbox', 'it closed')`,
        ),
      ).toBe('provider_recipes_retirement_says_when_and_why')
    })

    /**
     * The other direction, and it is the one that catches an un-retiring that
     * forgot to clear the columns: a row that says it is joinable while carrying
     * a withdrawal date is two answers to *is this on offer*.
     */
    it('refuses a withdrawal date on an entry that is not withdrawn', async () => {
      expect(
        await refusedBy(
          `insert into provider_recipes
             (kind, provider, title, status, category, steps, proves, retired_at, retired_reason)
           values ('mailbox', 'confused.example', 'Confused', 'joinable', 'mailbox',
                   '[{"actor":"agent","instruction":"sign up"}]', 'rung', now(), 'but also open')`,
        ),
      ).toBe('provider_recipes_retirement_says_when_and_why')
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
  /**
   * **Which states a stranger can see, asserted against the real query** (`#604`).
   *
   * `recipeStatusIsPublic` is the rule and `providerRecipeList` is where it is
   * applied; a unit test of the predicate would pass while the query published
   * everything, which is the failure that matters. So this writes one row in
   * each of the six states and reads the list back twice.
   */
  describe('what a stranger is shown', () => {
    const write = async (provider: string, status: string, extra = '') =>
      db.execute(
        `insert into provider_recipes (kind, provider, title, status, category${extra === '' ? '' : ', ' + extra.split('::')[0]})
         values ('mailbox', '${provider}', '${provider}', '${status}', 'mailbox'${
           extra === '' ? '' : ', ' + extra.split('::')[1]
         })`,
      )

    beforeEach(async () => {
      await write(
        'open.example',
        'joinable',
        `steps, proves::'[{"actor":"agent","instruction":"go"}]', 'rung'`,
      )
      await write('walked.example', 'draft', `steps::'[{"actor":"agent","instruction":"go"}]'`)
      await write('listed.example', 'unwritten')
      await write('closed.example', 'refused', `refusal::'no honest route'`)
      await write('gone.example', 'retired', `retired_at, retired_reason::now(), 'it closed'`)
      await write('asked.example', 'proposed')
    })

    it('shows the four public states and hides the two internal ones', async () => {
      const providers = (await providerRecipeList(db)).map((entry) => entry.provider)

      expect(providers).toEqual(
        expect.arrayContaining([
          'open.example',
          'listed.example',
          'closed.example',
          'gone.example',
        ]),
      )
      expect(providers).not.toContain('walked.example')
      expect(providers).not.toContain('asked.example')
    })

    /**
     * The rejection case for the flag itself: asking for the internal list has
     * to actually change the answer, or the filter above is untested and the
     * curation queue is empty for a reason nobody notices.
     */
    it('shows all six when the caller asks for the internal list', async () => {
      const providers = (await providerRecipeList(db, undefined, { includeInternal: true })).map(
        (entry) => entry.provider,
      )

      expect(providers).toHaveLength(6)
      expect(providers).toContain('walked.example')
      expect(providers).toContain('asked.example')
    })

    /** Joinable first, then the draft, then unwritten, then the two closed states. */
    it('orders them so what can be acted on is at the top', async () => {
      const order = (await providerRecipeList(db, undefined, { includeInternal: true })).map(
        (entry) => entry.status,
      )

      expect(order).toEqual(['joinable', 'draft', 'unwritten', 'refused', 'retired', 'proposed'])
    })

    it('reads a withdrawal back with its date and its reason', async () => {
      const entry = await providerRecipe(db, kind('mailbox'), 'gone.example')

      expect(entry?.status).toBe('retired')
      expect(entry?.retiredReason).toBe('it closed')
      expect(entry?.retiredAt).not.toBeNull()
    })
  })

  /**
   * Withdrawing and un-withdrawing through the write surface (`#604`).
   *
   * **The date is storage's and the reason is the caller's**, and the second
   * half of that is what this asserts: moving a row out of `retired` has to
   * clear both columns, or the constraint refuses the write and the failure
   * reads as a bug in the un-retiring rather than as the leftover it is.
   */
  describe('withdrawing an entry', () => {
    const joinable = {
      kind: kind('mailbox'),
      provider: 'comeback.example',
      title: 'Comeback',
      category: 'mailbox' as const,
      steps: [{ actor: 'agent' as const, instruction: 'sign up' }],
      proves: 'rung' as const,
      status: 'joinable' as const,
    }

    it('stamps the date itself rather than taking one from the caller', async () => {
      await writeProviderRecipe(db, joinable)

      const retired = await writeProviderRecipe(db, {
        ...joinable,
        status: 'retired',
        retiredReason: 'the provider began demanding a phone number',
      })

      expect(retired.status).toBe('retired')
      expect(retired.retiredAt).not.toBeNull()
      expect(retired.retiredReason).toBe('the provider began demanding a phone number')
      /** The steps are kept, which is the whole difference from deleting the row. */
      expect(retired.steps).toHaveLength(1)
    })

    it('clears both columns when the entry comes back', async () => {
      await writeProviderRecipe(db, joinable)
      await writeProviderRecipe(db, {
        ...joinable,
        status: 'retired',
        retiredReason: 'it closed',
      })

      const back = await writeProviderRecipe(db, joinable)

      expect(back.status).toBe('joinable')
      expect(back.retiredAt).toBeNull()
      expect(back.retiredReason).toBeNull()
    })
  })

  /**
   * Writing the Colony's words onto a draft a walk left wordless (`#857`).
   *
   * A walk records that a step happened and who it needed; the sentence stays the
   * Colony's to write (`#517`), so a walked draft arrives with no instruction and
   * no proof method and `whyNotPublishable` holds it forever. What is asserted
   * here is the write that was missing, and the guard on it: it touches a
   * `draft` and it moves no status, so it can never publish anything by itself.
   */
  describe('dressing a walked draft', () => {
    const walked = {
      kind: kind('mailbox'),
      provider: 'wordless.example',
      title: 'Wordless',
      category: 'mailbox' as const,
      status: 'draft' as const,
      steps: [{ actor: 'agent' as const }, { actor: 'operator' as const, ask: 'Please sign in.' }],
    }

    it('writes the sentences and the proof method onto the draft', async () => {
      await writeProviderRecipe(db, walked)

      const dressed = await dressProviderRecipeDraft(db, {
        kind: walked.kind,
        provider: walked.provider,
        steps: [
          { actor: 'agent', instruction: 'Ask the provider for a mailbox.' },
          { actor: 'operator', instruction: 'The operator signs in.', ask: 'Please sign in.' },
        ],
        proves: 'rung',
        provesTask: 'email-inbox',
      })

      expect(dressed).toBe(true)
      const found = await providerRecipe(db, walked.kind, walked.provider)
      expect(found?.steps[0]?.instruction).toBe('Ask the provider for a mailbox.')
      expect(found?.proves).toBe('rung')
      expect(found?.provesTask).toBe('email-inbox')
      /** It describes; it does not decide. The verdict is still a separate act. */
      expect(found?.status).toBe('draft')
    })

    /** A rung is the only proof the Colony checks itself, so it is the only one that names one. */
    it('drops a rung name from a proof that is not a rung', async () => {
      await writeProviderRecipe(db, walked)

      await dressProviderRecipeDraft(db, {
        kind: walked.kind,
        provider: walked.provider,
        steps: [
          { actor: 'agent', instruction: 'Ask the provider for a mailbox.' },
          { actor: 'operator', instruction: 'The operator signs in.', ask: 'Please sign in.' },
        ],
        proves: 'provider-mail',
        provesTask: 'email-inbox',
      })

      expect((await providerRecipe(db, walked.kind, walked.provider))?.provesTask).toBeNull()
    })

    /**
     * The rejection case: a published entry is not a draft, and a write that
     * could reach one would let the curation screen rewrite the catalogue.
     */
    it('leaves an entry that is not a draft alone', async () => {
      await writeProviderRecipe(db, {
        ...walked,
        status: 'joinable',
        steps: [{ actor: 'agent', instruction: 'The published sentence.' }],
        proves: 'provider-post',
      })

      const dressed = await dressProviderRecipeDraft(db, {
        kind: walked.kind,
        provider: walked.provider,
        steps: [{ actor: 'agent', instruction: 'A sentence nobody reviewed.' }],
        proves: 'provider-mail',
      })

      expect(dressed).toBe(false)
      expect((await providerRecipe(db, walked.kind, walked.provider))?.steps[0]?.instruction).toBe(
        'The published sentence.',
      )
    })
  })

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
      // And the password is not in the ask in either direction (`#592`): the
      // operator is neither told to keep one nor asked to send one, because it
      // no longer chooses it — the agent seals it on a handover step.
      expect(handoff[0]?.ask).not.toContain('do not send it to your agent')
      expect(handoff[0]?.ask).not.toContain('Choose the password yourself')
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
   * **This asserted the opposite until 2026-08-09, and the reversal is the whole
   * of `#592`.**
   *
   * It read *tells an operator who must choose a password not to send it*, and
   * it was right about the platform as built: every channel refused a credential
   * travelling agent → operator, and this entry told the operator so. The Colony
   * decided on 2026-08-08 that the credentials of an account a person opened for
   * an agent are **the agent's** — recorded with both sides in
   * `kolonie-docs/state/decisions/who-owns-an-agents-account-credentials.md`.
   *
   * What has to hold either way, and is what this now asserts: **the password
   * still does not travel in words.** It moves through a sealed handover or it
   * does not move, and the token the agent works through still comes back
   * through a sealed drop. If somebody later rewrites this entry to put a
   * credential in an ask, this is what fails.
   */
  it('moves GitHub’s password by a sealed handover and never in words', () => {
    const github = PROVIDER_CATALOGUE.find((entry) => entry.provider === 'github.com')
    const creating = github?.steps.find((step) => step.actor === 'operator' && step.secret !== true)

    // The instruction to keep the password from the agent is gone, and nothing
    // replaced it with an instruction to send one in an ask.
    expect(creating?.ask).not.toContain('do not send it to your agent')
    expect(creating?.ask).not.toContain('Choose the password yourself')

    // The agent seals it instead, on a step the recipe marks as a handover.
    const handover = github?.steps.filter((step) => step.handover === true) ?? []
    expect(handover).toHaveLength(1)
    expect(handover[0]?.actor).toBe('agent')

    // And the thing the agent actually works through still arrives sealed, the
    // other way, through the drop.
    expect(github?.steps.filter((step) => step.secret === true)).toHaveLength(1)
  })
})
