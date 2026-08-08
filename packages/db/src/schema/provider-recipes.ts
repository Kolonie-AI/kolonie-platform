import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import {
  RECIPE_MAX_RUNTIME_NOTES,
  RECIPE_MAX_STEPS,
  type RecipeRuntimeNote,
  type RecipeStep,
  type ReferralArrangement,
} from '@kolonie-ai/core'

/**
 * One provider, as a recipe (`#521`).
 *
 * **A table and not a TypeScript list, which is the whole of the issue.** A
 * provider that changes its signup form on Tuesday costs one row. The seed writes
 * the starting entries so they are reviewable in Git like the Academy tasks are,
 * and the read paths go to this table — so a row inserted by hand is served
 * immediately, with no build and no release across seven skill repositories.
 *
 * **`kind` and `provider` are text for the reason they are text on `accounts`**:
 * the vocabulary is what the Colony is trying to learn, and a provider the Colony
 * has never heard of must not be a migration.
 */
export const providerRecipes = pgTable(
  'provider_recipes',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    kind: text('kind').notNull(),
    provider: text('provider').notNull(),
    title: text('title').notNull(),

    /**
     * What the provider is, and why an agent would want an account there (`#547`).
     *
     * Nullable: a recipe is worth publishing before somebody has written its
     * prose, and a page with steps and no paragraph is more useful than no page.
     */
    about: text('about'),

    /**
     * Where a named runtime's walk genuinely differs (`#547`).
     *
     * **`jsonb` on the row rather than a `recipe_runtimes` table**, for the
     * reason `steps` beside it is: this is read whole, with the entry, by one
     * caller at a time, and nothing queries across it. It is also the field most
     * likely to be empty — which is the correct answer — and an empty child table
     * is a join that returns nothing on almost every read.
     */
    runtimes: jsonb('runtimes').$type<RecipeRuntimeNote[]>().notNull().default([]),

    /**
     * Whether this entry is paid for (`#543` rule 3).
     *
     * **Nothing reads it except the page that shows it.** It cannot reach
     * `atlasRank`, which is what makes *paying buys no ordering* structural: the
     * ranking function is not given the field, so no future edit can quietly
     * weight it.
     */
    paid: boolean('paid').notNull().default(false),

    /**
     * A referral arrangement, where one exists (`#548`).
     *
     * **Held whole as `jsonb` so the link cannot exist without the check.** Most
     * affiliate programmes forbid this use — an agent signing up is not the
     * traffic they are paying for — and the check is per programme and is the
     * maintainer's, before any link is stored. Four nullable columns would let
     * three of them be filled and one left empty; one object with a required
     * `termsNote` inside `ReferralArrangementSchema` cannot be half-written, and
     * the constraint below refuses a half-written one at the database too.
     */
    referral: jsonb('referral').$type<ReferralArrangement>(),

    /**
     * How to reach whoever runs this service about their own entry (`#548`).
     *
     * Separate from `provider_claims.contact`: this one is what the Colony found
     * or was given, and that one is what a *proved* provider left. An entry we
     * wrote from an agent's report has the first and not the second.
     */
    contact: text('contact'),

    /**
     * Whether an agent can currently join this provider honestly.
     *
     * **A refusal is an entry rather than an absence** (`#482`). Bluesky and X have
     * no honest signup route for a phone-less citizen, and a catalogue that omitted
     * that would send agents to fail repeatedly — so the row that says *do not try*
     * is as valuable as one that says how.
     */
    joinable: boolean('joinable').notNull().default(true),
    refusal: text('refusal'),

    /**
     * The ordered steps, as JSON.
     *
     * **`jsonb` rather than a `recipe_steps` table**, and the trade is worth
     * stating: a child table would give per-step constraints and ordering that
     * Postgres enforces, and it would make *one entry* something a reader has to
     * assemble from two places. A recipe is read whole, always, by one caller at a
     * time — nothing queries across steps — so the row is the unit. The shape is
     * enforced by `RecipeStepSchema` at both boundaries, which is where the
     * `operator` step's ask and the secret rule live.
     */
    steps: jsonb('steps').$type<RecipeStep[]>().notNull().default([]),

    /** How the account is proved once it exists — a rung, or one of `#520`'s two. */
    proves: text('proves'),

    /** A wall a working entry warns about, from `provider-report` findings. */
    caution: text('caution'),

    /**
     * How many accounts one operator may create here in a day (`#532`).
     *
     * Null means the configured default applies. **It can only lower the ceiling**,
     * which is enforced in `paceCeiling` rather than here: a catalogue entry is
     * content, edited more often and by more hands than a setting is, and letting
     * content raise a safety limit would mean the conservative default could be
     * undone by an edit nobody reviewed as a limit change.
     */
    pacePerDay: integer('pace_per_day'),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /**
     * One entry per provider per kind. A catalogue with two answers has none.
     *
     * **On the plain column and not on `lower(provider)`**, which the register's own
     * index needs and this one does not: `AccountProviderSchema` lowercases as it
     * parses, so every value that reaches this table is already normalised. The
     * expression index would also make `onConflictDoUpdate` inexpressible, and a
     * hand-written upsert to work around an index nothing needs is the wrong half of
     * the trade.
     */
    uniqueIndex('provider_recipes_kind_provider_unique').on(table.kind, table.provider),

    /**
     * A refusal says why; a working entry says how and how it is proved.
     *
     * Both directions in SQL as well as in `WriteProviderRecipeSchema`, because the
     * seed writes through neither: a hand-written entry with `joinable = false` and
     * no reason would be a dead end a reader cannot act on, and nothing in the
     * request shape can stop a psql prompt.
     */
    check(
      'provider_recipes_refusal_says_why',
      sql`(${table.joinable} = true and ${table.refusal} is null)
          or (${table.joinable} = false and ${table.refusal} is not null)`,
    ),

    check(
      'provider_recipes_joinable_has_steps',
      sql`${table.joinable} = false
          or (jsonb_array_length(${table.steps}) between 1 and ${sql.raw(String(RECIPE_MAX_STEPS))}
              and ${table.proves} is not null)`,
    ),

    /** A refusal has nothing to walk and nothing to prove. */
    check(
      'provider_recipes_refusal_is_empty',
      sql`${table.joinable} = true
          or (jsonb_array_length(${table.steps}) = 0 and ${table.proves} is null)`,
    ),

    /**
     * **No referral link without a recorded check of that programme's terms.**
     *
     * `#548`'s hardest requirement, and it is here rather than only in the write
     * shape because a psql prompt writes through neither. A link stored with no
     * note is one nobody can tell *checked and fine* from *nobody looked* — and
     * the second is the case that breaks a programme's terms in the Colony's
     * name.
     */
    check(
      'provider_recipes_referral_records_its_check',
      sql`${table.referral} is null
          or (${table.referral} ? 'url'
              and ${table.referral} ? 'termsNote'
              and ${table.referral} ? 'checkedBy'
              and ${table.referral} ? 'checkedAt'
              and length(${table.referral} ->> 'termsNote') > 0)`,
    ),

    /** The bound the write shape carries, in SQL as well — a psql prompt writes through neither. */
    check(
      'provider_recipes_runtime_notes_bounded',
      sql`jsonb_array_length(${table.runtimes}) <= ${sql.raw(String(RECIPE_MAX_RUNTIME_NOTES))}`,
    ),

    check(
      'provider_recipes_proves_is_known',
      sql`${table.proves} is null
          or ${table.proves} in ('rung', 'provider-mail', 'provider-post')`,
    ),
  ],
)
