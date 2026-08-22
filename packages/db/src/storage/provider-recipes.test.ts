import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  AccountKindSchema,
  AtlasCategorySchema,
  earnFacetsOf,
  isDualUse,
  looksLikeCredential,
  utilityFacetsOf,
  WriteProviderRecipeSchema,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import {
  dressProviderRecipe,
  providerRecipe,
  providerRecipeList,
  providersForbiddingAgents,
  recordMeasuredProvider,
  writeProviderRecipe,
  writeRecipeEarnFacets,
  addRecipeEarnFacets,
} from './provider-recipes.js'
import { providerRecipeFacets } from '../schema/provider-recipe-facets.js'
import { providerRecipes } from '../schema/provider-recipes.js'
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

    /**
     * **A foreign key rather than a check, since `#1102`.** The rule is the
     * same one and the thing enforcing it moved: the fifteen were written into
     * a check constraint, so a sixteenth was a migration; they are rows in
     * `atlas_categories` now, so a sixteenth is an insert and the column points
     * at them. What is asserted here is the refusal and not the mechanism —
     * except that naming the constraint is what says which mechanism is doing
     * the refusing, and a category nobody defined must still not get in.
     */
    it('refuses a category nobody defined', async () => {
      expect(
        await refusedBy(
          `insert into provider_recipes (kind, provider, title, status, category)
           values ('mailbox', 'shelf.example', 'Shelf', 'unwritten', 'miscellaneous')`,
        ),
      ).toBe('provider_recipes_category_atlas_categories_slug_fk')
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
    /**
     * **Both states the steward gate took with it are refused in SQL** (`#1032`).
     *
     * `draft` held a walk's own route until somebody read it and `proposed` held
     * a guess until the same person did; the gate they fed took two decisions in
     * its lifetime. What replaces them is the entry's computed briefing, so a row
     * arriving in either state is not a stale label to tolerate — it is a writer
     * that has not been migrated, and the constraint says so at the prompt rather
     * than three surfaces later.
     */
    it('refuses the two states the steward gate took with it', async () => {
      for (const status of ['draft', 'proposed']) {
        expect(
          await refusedBy(
            `insert into provider_recipes (kind, provider, title, status, category)
             values ('mailbox', 'gated-${status}.example', 'Gated', '${status}', 'mailbox')`,
          ),
        ).toBe('provider_recipes_status_is_known')
      }
    })

    /**
     * **`measured` is what a walked pair looks like**: the provider exists and
     * citizens have been here, and that is the whole of the entry. The route they
     * took is not lost — it is on the walk, and the briefing computed from
     * `account_walks` is where a reader meets it.
     */
    it('takes a measured entry, which carries figures and no route', async () => {
      expect(
        await refusedBy(
          `insert into provider_recipes (kind, provider, title, status, category)
           values ('mailbox', 'walked.example', 'Walked', 'measured', 'mailbox')`,
        ),
      ).toBeUndefined()
    })

    it('refuses a measured entry that carries steps', async () => {
      expect(
        await refusedBy(
          `insert into provider_recipes (kind, provider, title, status, category, steps)
           values ('mailbox', 'dressed.example', 'Dressed', 'measured', 'mailbox',
                   '[{"actor":"agent","instruction":"sign up"}]')`,
        ),
      ).toBe('provider_recipes_unjoinable_is_empty')
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
   * **Which states a stranger can see, asserted against the real query** (`#604`,
   * `#1032`).
   *
   * `recipeStatusIsPublic` is the rule and `providerRecipeList` is where it is
   * applied; a unit test of the predicate would pass while the query published
   * everything, which is the failure that matters. So this writes one row in
   * each of the five states and reads the list back.
   *
   * **All five are public now**, because the two that were not are gone: an
   * entry was held back exactly while a steward had not read it, and `#1032`
   * retired the reading. The filter stays wired up rather than deleted — the
   * question *may a reader see this* keeps one answer in one place, ready for the
   * first status that answers no.
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
      await write('walked.example', 'measured')
      await write('listed.example', 'unwritten')
      await write('closed.example', 'refused', `refusal::'no honest route'`)
      await write('gone.example', 'retired', `retired_at, retired_reason::now(), 'it closed'`)
    })

    it('shows every state, because none of them waits on a reader', async () => {
      const providers = (await providerRecipeList(db)).map((entry) => entry.provider)

      expect(providers).toEqual([
        'open.example',
        'walked.example',
        'listed.example',
        'closed.example',
        'gone.example',
      ])
    })

    /**
     * The rejection case for the flag itself. It excludes nothing today, and
     * asserting that it excludes nothing is what makes the day it does visible:
     * a status added as internal without this test moving is one that reaches a
     * stranger through the public list.
     */
    it('shows the same list to the internal caller, there being nothing held back', async () => {
      const providers = (await providerRecipeList(db, undefined, { includeInternal: true })).map(
        (entry) => entry.provider,
      )

      expect(providers).toEqual((await providerRecipeList(db)).map((entry) => entry.provider))
      expect(providers).toHaveLength(5)
    })

    /**
     * Joinable first, then what citizens measured, then the shelf, then the two
     * closed states — `measured` above `unwritten` because a pair somebody
     * actually walked is better evidence than one somebody shelved.
     */
    it('orders them so what can be acted on is at the top', async () => {
      const order = (await providerRecipeList(db)).map((entry) => entry.status)

      expect(order).toEqual(['joinable', 'measured', 'unwritten', 'refused', 'retired'])
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
   * Writing the route onto an entry citizens have measured (`#857`, `#1032`).
   *
   * A walk records that a step happened and who it needed, and leaves the entry
   * `measured` with no steps at all — the route it took is published in the
   * entry's computed briefing, under its own name. Dressing is the other act:
   * somebody writes the Colony's own recipe onto the pair.
   *
   * **Since `#1032` that act publishes.** There was a status between the two
   * while a steward's queue existed; the queue is gone, `measured` may hold no
   * steps on the table's own constraint, and so writing the route *is* offering
   * it. What is asserted here is that write, and the guard on it: it touches a
   * `measured` entry and nothing else.
   */
  describe('dressing a measured entry', () => {
    const walked = {
      kind: kind('mailbox'),
      provider: 'wordless.example',
      title: 'Wordless',
      category: 'mailbox' as const,
      status: 'measured' as const,
      steps: [],
    }

    it('writes the sentences and the proof method, and offers the entry', async () => {
      await writeProviderRecipe(db, walked)

      const dressed = await dressProviderRecipe(db, {
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
      /** Describing and deciding are one act now that nothing sits behind them. */
      expect(found?.status).toBe('joinable')
    })

    /** A rung is the only proof the Colony checks itself, so it is the only one that names one. */
    it('drops a rung name from a proof that is not a rung', async () => {
      await writeProviderRecipe(db, walked)

      await dressProviderRecipe(db, {
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
     * The rejection case: an entry that is already offered is not measured, and a
     * write that could reach one would let the curation screen rewrite the
     * catalogue.
     */
    it('leaves an entry that is not measured alone', async () => {
      await writeProviderRecipe(db, {
        ...walked,
        status: 'joinable',
        steps: [{ actor: 'agent', instruction: 'The published sentence.' }],
        proves: 'provider-post',
      })

      const dressed = await dressProviderRecipe(db, {
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

/**
 * A proved account writes its own catalogue row (`#903`).
 *
 * **The claim under test is that the catalogue stops depending on a favour.**
 * Until now the only entrance was `finishWalk`, and a walk is a separate, later,
 * voluntary act — so the shelf stayed empty while the register filled up. These
 * assert the other entrance: a proof, which is a transaction the Colony already
 * runs.
 */
describe('a provider row the Colony measured', () => {
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

  it('puts a provider nobody has written up on the shelf, with no prose', async () => {
    const written = await recordMeasuredProvider(db, {
      kind: kind('phone'),
      provider: 'agent.example',
    })
    expect(written).toBe(true)

    const entry = await providerRecipe(db, kind('phone'), 'agent.example')
    expect(entry?.status).toBe('measured')
    expect(entry?.category).toBe('telephony')

    /**
     * The four claims that would say *somebody investigated this*. A proof says
     * only *a citizen got in here*, so all four stay empty — and the absence is
     * the row's content rather than a gap in it.
     */
    expect(entry?.steps).toEqual([])
    expect(entry?.proves).toBeNull()
    expect(entry?.refusal).toBeNull()
    expect(entry?.cautions).toEqual([])
  })

  it('shows it to a stranger, without a steward', async () => {
    await recordMeasuredProvider(db, { kind: kind('phone'), provider: 'agent.example' })

    const listed = await providerRecipeList(db, kind('phone'))
    expect(listed.map((one) => one.provider)).toContain('agent.example')
  })

  it('ranks it above an entry nobody has walked', async () => {
    await writeProviderRecipe(db, {
      kind: kind('phone'),
      provider: 'shelved.example',
      title: 'Shelved',
      status: 'unwritten',
      category: 'telephony',
      steps: [],
    })
    await recordMeasuredProvider(db, { kind: kind('phone'), provider: 'agent.example' })

    const listed = await providerRecipeList(db, kind('phone'))
    const order = listed.map((one) => one.provider)
    expect(order.indexOf('agent.example')).toBeLessThan(order.indexOf('shelved.example'))
  })

  /**
   * **The rejection case `#903` asks for.** A proof at a provider a steward has
   * written up updates figures and touches nothing else — and since the figures
   * are computed live from `accounts` and `provider_reports` rather than stored
   * on the row, *touches nothing else* is the whole of the behaviour.
   */
  it('leaves a curated entry exactly as it stood', async () => {
    await writeProviderRecipe(db, {
      kind: kind('phone'),
      provider: 'curated.example',
      title: 'Curated',
      status: 'refused',
      category: 'telephony',
      steps: [],
      refusal: 'The signup demands a natural person and says so.',
      cautions: [{ text: 'Read the refusal before spending an afternoon here.', direction: null }],
    })

    const before = await providerRecipe(db, kind('phone'), 'curated.example')
    const written = await recordMeasuredProvider(db, {
      kind: kind('phone'),
      provider: 'curated.example',
    })
    const after = await providerRecipe(db, kind('phone'), 'curated.example')

    expect(written).toBe(false)
    expect(after?.status).toBe('refused')
    expect(after?.cautions).toEqual(before?.cautions)
    expect(after?.refusal).toBe(before?.refusal)
    expect(after?.title).toBe(before?.title)
  })

  /**
   * **A kind with no shelf gets no row, and the proof still succeeds.** The
   * catalogue is filed by shelf and `atlasCategoryForKind` throws rather than
   * guessing; a provider on a wrong shelf is worse than one reachable only by
   * its kind. What must never happen is a proof failing because the Atlas has
   * nowhere to put it.
   */
  it('writes nothing for a kind no shelf claims, and does not throw', async () => {
    const written = await recordMeasuredProvider(db, {
      kind: kind('nothing-has-a-shelf-for-this'),
      provider: 'unshelved.example',
    })

    expect(written).toBe(false)
    expect(
      await providerRecipe(db, kind('nothing-has-a-shelf-for-this'), 'unshelved.example'),
    ).toBeUndefined()
  })

  it('is idempotent, so a second proof at the same provider writes nothing', async () => {
    expect(
      await recordMeasuredProvider(db, { kind: kind('phone'), provider: 'agent.example' }),
    ).toBe(true)
    expect(
      await recordMeasuredProvider(db, { kind: kind('phone'), provider: 'agent.example' }),
    ).toBe(false)
  })

  /**
   * **Refused in SQL and not only in TypeScript.** `recipeStatusAllowsSteps`
   * excludes `measured`, but a writer that bypasses it must not get a second
   * chance — so `provider_recipes_unjoinable_is_empty` refuses the row at the
   * database. This asserts the constraint rather than the function.
   */
  it('refuses a measured row carrying steps, at the database', async () => {
    await expect(
      writeProviderRecipe(db, {
        kind: kind('phone'),
        provider: 'steps.example',
        title: 'Steps',
        status: 'measured',
        category: 'telephony',
        steps: [{ actor: 'agent', instruction: 'Open the signup page and fill it in.' }],
      }),
    ).rejects.toThrow()
  })
})

/**
 * The earn axis (`#1301`).
 *
 * **What is asserted here is that the two taxonomies are additive.** The failure
 * this issue was filed about is a taxonomy that makes a reader choose: a bounty
 * board filed under `data-apis` because no shelf fitted, and a mailbox that pays
 * a referral describable as one or the other and not both. So every test below
 * reads the shelf and the earn facet off one entry at once.
 */
describe('the earn facets on a catalogue entry', () => {
  let db: Database

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
    await seedProviderCatalogue(db)
    await writeProviderRecipe(db, {
      kind: kind('mailbox'),
      provider: 'dual.example',
      title: 'A dual-use mailbox',
      status: 'joinable',
      category: 'mailbox',
      steps: [{ actor: 'agent', instruction: 'Open the signup page and fill it in.' }],
      proves: 'provider-mail',
    })
  })

  it('claims nothing about earning until somebody says so', async () => {
    const entry = await providerRecipe(db, kind('mailbox'), 'dual.example')

    expect(earnFacetsOf(entry?.facets ?? [])).toEqual([])
    /** The shelf is still a facet, so *unset earn* and *no facets* are different. */
    expect(utilityFacetsOf(entry?.facets ?? [])).toEqual(['mailbox'])
    expect(isDualUse(entry?.facets ?? [])).toBe(false)
  })

  /** The acceptance criterion, as one read: the mailbox and the referral together. */
  it('carries a shelf and an earn facet at once', async () => {
    expect(
      await writeRecipeEarnFacets(db, kind('mailbox'), 'dual.example', ['affiliate-referral']),
    ).toBe(true)

    const entry = await providerRecipe(db, kind('mailbox'), 'dual.example')

    expect(entry?.facets).toEqual([
      { axis: 'utility', slug: 'mailbox' },
      { axis: 'earn', slug: 'affiliate-referral' },
    ])
    expect(isDualUse(entry?.facets ?? [])).toBe(true)
    /** And the shelf is untouched: a facet takes nothing away. */
    expect(entry?.category).toBe('mailbox')
    expect(entry?.categories).toEqual(['mailbox'])
  })

  it('takes several facets on the axis, because they are not exclusive either', async () => {
    await writeRecipeEarnFacets(db, kind('mailbox'), 'dual.example', [
      'bounty-board',
      'affiliate-referral',
    ])

    const entry = await providerRecipe(db, kind('mailbox'), 'dual.example')

    /** In the vocabulary's own order, so two reads of one entry agree. */
    expect(earnFacetsOf(entry?.facets ?? [])).toEqual(['affiliate-referral', 'bounty-board'])
  })

  it('replaces rather than merges, so a claim can be withdrawn', async () => {
    await writeRecipeEarnFacets(db, kind('mailbox'), 'dual.example', ['affiliate-referral'])
    await writeRecipeEarnFacets(db, kind('mailbox'), 'dual.example', ['creator-payout'])

    const entry = await providerRecipe(db, kind('mailbox'), 'dual.example')
    expect(earnFacetsOf(entry?.facets ?? [])).toEqual(['creator-payout'])

    await writeRecipeEarnFacets(db, kind('mailbox'), 'dual.example', [])
    const withdrawn = await providerRecipe(db, kind('mailbox'), 'dual.example')
    expect(earnFacetsOf(withdrawn?.facets ?? [])).toEqual([])
  })

  /**
   * **The union beside the replacement** (`#1331`). A walk closing knows one
   * fact about one row and must not be able to withdraw the other four: without
   * this, a `bounty-board` walk against an entry a moderator had also marked
   * `affiliate-referral` would drop the referral, silently, every time somebody
   * walked it.
   */
  it('adds an earn facet without disturbing the ones already held', async () => {
    await writeRecipeEarnFacets(db, kind('mailbox'), 'dual.example', ['affiliate-referral'])

    expect(await addRecipeEarnFacets(db, kind('mailbox'), 'dual.example', ['bounty-board'])).toBe(
      true,
    )

    const entry = await providerRecipe(db, kind('mailbox'), 'dual.example')
    expect(earnFacetsOf(entry?.facets ?? [])).toEqual(['affiliate-referral', 'bounty-board'])
  })

  /** Idempotent, which is what makes it safe on a path that runs once per walk. */
  it('writes nothing when the facet is already on the entry', async () => {
    await writeRecipeEarnFacets(db, kind('mailbox'), 'dual.example', ['bounty-board'])

    expect(await addRecipeEarnFacets(db, kind('mailbox'), 'dual.example', ['bounty-board'])).toBe(
      false,
    )

    const entry = await providerRecipe(db, kind('mailbox'), 'dual.example')
    expect(earnFacetsOf(entry?.facets ?? [])).toEqual(['bounty-board'])
  })

  it('adds nothing for a provider the catalogue has never heard of', async () => {
    expect(await addRecipeEarnFacets(db, kind('mailbox'), 'nobody.example', ['bounty-board'])).toBe(
      false,
    )
  })

  it('reads the facets on a list as well as on one entry', async () => {
    await writeRecipeEarnFacets(db, kind('mailbox'), 'dual.example', ['affiliate-referral'])

    const listed = await providerRecipeList(db, kind('mailbox'))
    const entry = listed.find((one) => one.provider === 'dual.example')

    expect(earnFacetsOf(entry?.facets ?? [])).toEqual(['affiliate-referral'])
  })

  it('writes nothing for a provider the catalogue has never heard of', async () => {
    expect(
      await writeRecipeEarnFacets(db, kind('mailbox'), 'nobody.example', ['bounty-board']),
    ).toBe(false)
  })

  /**
   * **Refused in SQL and not only in TypeScript**, for the reason the wall
   * vocabulary is: this table is meant to be written to at a psql prompt, and a
   * facet spelled a second way is an earn rail nobody's filter finds.
   */
  it('refuses a facet outside the vocabulary, at the database', async () => {
    const [row] = await db
      .select({ id: providerRecipes.id })
      .from(providerRecipes)
      .where(eq(providerRecipes.provider, 'dual.example'))
      .limit(1)

    await expect(
      db
        .insert(providerRecipeFacets)
        .values({ recipeId: row?.id ?? '', axis: 'earn', slug: 'bounty-boards' }),
    ).rejects.toThrow()
  })

  /**
   * The shelves are `provider_recipe_categories` and this table refuses to be a
   * second home for them — two homes for one fact is two answers the first time
   * somebody writes to only one of them.
   */
  it('refuses a utility facet, because the shelves already hold that axis', async () => {
    const [row] = await db
      .select({ id: providerRecipes.id })
      .from(providerRecipes)
      .where(eq(providerRecipes.provider, 'dual.example'))
      .limit(1)

    await expect(
      db
        .insert(providerRecipeFacets)
        .values({ recipeId: row?.id ?? '', axis: 'utility', slug: 'mailbox' }),
    ).rejects.toThrow()
  })
})

/**
 * Which providers no operator can open on an agent's behalf (`#1542`).
 *
 * **The wall that is about permission rather than difficulty.** Every other wall
 * on the list is something a person could get through; `terms-forbid-agents`
 * says the account may not be an agent's at all, so an operator clearing it
 * would be holding the account in their own name and lending it. `#1421` is
 * explicit that such a row stays closed and is not queued.
 */
describe('providers whose terms forbid an agent-held account', () => {
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

  /**
   * Written straight onto the row, because the walls arrive there from the
   * publish pass rather than from `writeProviderRecipe`'s own arguments — and
   * what is under test is the read.
   */
  const write = async (provider: string, walls: readonly { kind: string }[]) => {
    await writeProviderRecipe(db, {
      kind: kind('bounty-board'),
      provider,
      title: provider,
      status: 'measured',
      category: 'data-apis',
      steps: [],
    })
    await db
      .update(providerRecipes)
      .set({ walls: walls as never })
      .where(eq(providerRecipes.provider, provider))
  }

  it('names the one that forbids and not the ones that merely stop an agent', async () => {
    await write('huntr.com', [{ kind: 'terms-forbid-agents' }, { kind: 'human-check' }])
    await write('0din.ai', [{ kind: 'human-check' }])
    await write('bugcrowd.com', [{ kind: 'identity-document' }])

    const forbidden = await providersForbiddingAgents(db, ['huntr.com', '0din.ai', 'bugcrowd.com'])

    expect([...forbidden]).toEqual(['huntr.com'])
  })

  it('is empty for a provider with no walls at all', async () => {
    await write('gain.gg', [])

    expect(await providersForbiddingAgents(db, ['gain.gg'])).toEqual(new Set())
  })

  /**
   * A provider nobody has written down carries no terms, so there is nothing to
   * refuse it on — the wish list is where an unknown provider gets proposed.
   */
  it('says nothing about a provider the Atlas has never heard of', async () => {
    expect(await providersForbiddingAgents(db, ['never-mentioned.example'])).toEqual(new Set())
  })

  it('takes an empty ask without asking the database', async () => {
    expect(await providersForbiddingAgents(db, [])).toEqual(new Set())
  })

  /**
   * **A provider's terms are the provider's.** An entry that recorded the
   * refusal under one shelf is describing the same document as the entry under
   * another, so reading only the asked-for kind would let a citizen reach a
   * forbidden provider by naming the shelf it was not written down on.
   */
  it('disqualifies the provider whichever kind recorded it', async () => {
    await writeProviderRecipe(db, {
      kind: kind('gig-marketplace'),
      provider: 'huntr.com',
      title: 'huntr.com',
      status: 'measured',
      category: 'data-apis',
      steps: [],
    })
    await write('huntr.com', [])
    await db
      .update(providerRecipes)
      .set({ walls: [{ kind: 'terms-forbid-agents' }] as never })
      .where(eq(providerRecipes.kind, kind('gig-marketplace')))

    expect([...(await providersForbiddingAgents(db, ['huntr.com']))]).toEqual(['huntr.com'])
  })

  it('folds case the way a provider token is folded everywhere else', async () => {
    await write('huntr.com', [{ kind: 'terms-forbid-agents' }])

    expect([...(await providersForbiddingAgents(db, ['HUNTR.COM']))]).toEqual(['huntr.com'])
  })
})
