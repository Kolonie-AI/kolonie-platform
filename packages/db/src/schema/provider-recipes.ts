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
  AtlasCategorySchema,
  RECIPE_MAX_RUNTIME_NOTES,
  RECIPE_MAX_STEPS,
  RecipeOperatorGuessSchema,
  RecipeStatusSchema,
  RecipeDirectionSchema,
  DIRECTIONAL_KINDS,
  RECIPE_MAX_CAUTIONS,
  type RecipeReach,
  type RecipeRuntimeNote,
  type RecipeStep,
  type ReferralArrangement,
  AgentApiSchema,
  SignupCodeSchema,
  ProviderTermsSchema,
  RecipeNeedSchema,
  SignupCostSchema,
  type PublishedWall,
  type RecipeCaution,
  type RecipeNeed,
  type WalkedRecipe,
} from '@kolonie-ai/core'

/**
 * The vocabularies, taken from `core` so the table cannot disagree with it.
 *
 * **Read off the schemas rather than repeated here**, which is the whole reason
 * they are in `core` at all: a list typed out twice is a list that is wrong in
 * one place, and the wrong place is whichever one nobody was editing.
 */
const RECIPE_STATUSES = RecipeStatusSchema.options
const ATLAS_CATEGORIES = AtlasCategorySchema.options
const OPERATOR_GUESSES = RecipeOperatorGuessSchema.options
const AGENT_APIS = AgentApiSchema.options
const SIGNUP_CODES = SignupCodeSchema.options
const PROVIDER_TERMS = ProviderTermsSchema.options
const SIGNUP_COSTS = SignupCostSchema.options
const RECIPE_NEEDS = RecipeNeedSchema.options
const RECIPE_DIRECTIONS = RecipeDirectionSchema.options

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
     * Whether an agent can join this provider honestly, cannot, or nobody has
     * looked yet (`#588`).
     *
     * **A refusal is an entry rather than an absence** (`#482`). Bluesky and X have
     * no honest signup route for a phone-less citizen, and a catalogue that omitted
     * that would send agents to fail repeatedly — so the row that says *do not try*
     * is as valuable as one that says how.
     *
     * **And an unwritten entry is an entry rather than an absence too**, which is
     * what the boolean this replaced could not hold: the two check constraints
     * below rejected every row with no steps and no refusal, so the Atlas could
     * not list a provider it had not investigated. It listed three and read as
     * empty.
     *
     * **`text` with a check rather than a `pg_enum`**, and the reason is
     * operational: `ALTER TYPE … ADD VALUE` cannot use the new value in the same
     * transaction, so a fourth state would need its migration split in two, and
     * the value could never be removed. `proves` beside it is text-with-a-check
     * for the same reason and this follows it rather than inventing a second
     * convention in one table.
     *
     * **`#604` is the case that argument was written for, and it collected.** It
     * added three states and warned that the migration would have to be split
     * around `ALTER TYPE`; because `#588` chose text-with-a-check, the migration
     * is one `ALTER TABLE … DROP CONSTRAINT` and one `ADD CONSTRAINT`, in one
     * transaction, and reversible.
     */
    status: text('status').notNull().default('joinable'),
    refusal: text('refusal'),

    /**
     * Which direction the status above is a verdict about (`#976`).
     *
     * **Nullable, and the null is a state rather than a gap to be filled.** It
     * says the verdict was recorded without anybody scoping it, which every row
     * written before this column was. `directionAnswers` in `core` reads that as
     * answering whichever direction is asked for — the conservative reading, so
     * adding the column hid no warning from anybody the day it landed.
     *
     * Text with a check, for the reason `status` above is: the vocabulary is
     * generated from `RecipeDirectionSchema` so there is one list, and a value
     * added there is a constraint swap rather than a split migration.
     */
    direction: text('direction'),

    /**
     * When the Colony withdrew this entry, and why (`#604`).
     *
     * **The row is kept rather than deleted**, which is the whole of what these
     * two columns buy. Deleting it destroys the record of why the Colony ever
     * recommended the provider and answers a reader arriving from an old link
     * with nothing — `growth/README.md`'s standing rule is that *a refusal is a
     * page, not an omission*, and a withdrawal is the same class of fact.
     *
     * Both null unless `status = 'retired'` and both required when it is, by the
     * constraint below. `retired_at` is stamped by storage rather than supplied:
     * a caller-chosen date could be backdated, and being read against *when did
     * I last look at this* is the date's only job.
     */
    retiredAt: timestamp('retired_at', { withTimezone: true, mode: 'string' }),
    retiredReason: text('retired_reason'),

    /**
     * What sort of thing this is (`#589`).
     *
     * **A separate column from `kind`, which keeps its job as half of the key.**
     * For two of the three seeded rows the kind is the provider spelled again —
     * `github/github.com`, `trello/trello.com` — so it cannot group anything.
     *
     * **No default.** A default would let a row be filed on a shelf nobody chose,
     * and the point of the column is that somebody chose. The vocabulary is
     * `AtlasCategorySchema`'s and the check below is generated from it, so adding
     * a category is a change in `core` and a migration, together.
     */
    category: text('category').notNull(),

    /**
     * A best guess at who has to be there, for an entry nobody has walked
     * (`#589`).
     *
     * **The only place the operator answer is ever stored, and it is refused
     * wherever it could disagree with a walk.** With steps present the answer is
     * derived from `RecipeStepSchema.actor` (see `operatorNeed` in core) — a
     * stored copy beside them is `D-002`'s second record of one fact, and it
     * would go stale the day somebody edits step three. The constraint below
     * makes the disagreement unrepresentable rather than merely discouraged.
     */
    operatorGuess: text('operator_guess'),

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

    /**
     * Which rung proves it, where {@link providerRecipes.proves} is `rung`
     * (`#622`).
     *
     * The Academy task's `type` — its slug and its identity in the seed. Text
     * rather than a foreign key to `tasks`: `tasks.type` is not unique (a quest
     * shares one type with every other quest), so there is no key to point at.
     * What keeps it honest is the seed's own uniqueness among Academy rungs,
     * asserted in `atlas-rung.test.ts` rather than by the database.
     */
    provesTask: text('proves_task'),

    /**
     * What the account is then good for, and the steps that reach it (`#637`).
     *
     * **`jsonb` beside `steps` and not a column pair**, for the reason `steps`
     * is one column: a recipe is read whole by one caller at a time, nothing
     * queries across the steps, and the capability is meaningless without them.
     * The shape is `RecipeReachSchema`, checked at both boundaries and parsed
     * again on the way out of this table.
     *
     * Null on almost every entry, and null is the honest empty answer here —
     * unlike `agent_api` beside it, there is no word for *somebody looked and
     * this account is good for nothing further*, because that finding is the
     * entry having no reach.
     */
    reaches: jsonb('reaches').$type<RecipeReach>(),

    /**
     * The walls a working entry warns about, one per capability (`#1041`).
     *
     * **A set and not a sentence.** It was one `text` column, and `#976` gave
     * the entry's *verdict* a direction while leaving the warning a single
     * value — so an entry could warn about receiving or about sending and never
     * both, and the second finding overwrote the first. `twilio.com` is the
     * worked example: outbound is blocked by A2P 10DLC brand registration,
     * inbound is limited to console-verified numbers, and a citizen wants to
     * read the one it came for before it spends an afternoon.
     *
     * **`jsonb` on the row and not a child table**, which is what `#1041`
     * proposed, for the three reasons `walls` gives beside it: this is the
     * catalogue's hottest path, where `providerRecipeList` would otherwise carry
     * a group-by over another table for all 133 rows; a recipe is read whole by
     * one caller at a time and nothing queries across the cautions; and it lands
     * on the row, so `toRecipe` stays the single place a row becomes a recipe.
     *
     * **`not null default '[]'`, like `walls` and `needs`**, because an entry
     * with nothing to warn about has answered the question.
     */
    cautions: jsonb('cautions').$type<readonly RecipeCaution[]>().notNull().default([]),

    /**
     * The walker's own long-form account of the path (`#769`).
     *
     * **Beside the steps and never as them.** `#517` keeps the sentence a recipe
     * publishes the Colony's, written by a steward; this is what the agent that
     * walked it said, unedited and attributed. Written by `finishWalk` from the
     * walk that proposed or corrected this entry and replaced by the next walk
     * that carries one, so it is *the current walker's account* rather than a
     * pile of them — the pile is on `account_walks`, one row per walk, which is
     * where a reader goes for the history.
     *
     * `jsonb` for the reason `steps` beside it is: read whole, by one caller at
     * a time, and nothing queries across it.
     */
    walkedRecipe: jsonb('walked_recipe').$type<WalkedRecipe>(),

    /**
     * What stopped walkers here, grouped by kind and counted (`#981`).
     *
     * **Stored, and not derived on the way out.** Every other aggregate over
     * `account_walks` is computed per read; this one is not, for three reasons
     * that all point the same way. It is on the catalogue's hottest path, where
     * `providerRecipeList` would otherwise carry a group-by over another table
     * for all 133 rows. It is written at the moment a walk finishes, which is the
     * moment `#981` says the typed half of a wall publishes — unmoderated,
     * immediately, in the same transaction as the verdict. And it lands on the
     * row, so `toRecipe` stays the single place a row becomes a recipe and no
     * surface can answer this differently from the next, which is the failure
     * `#982` and `#984` were both about.
     *
     * **`not null default '[]'`, like `needs`**, because an entry nobody walked
     * hit no walls and that is an answer rather than an absence.
     */
    walls: jsonb('walls').$type<readonly PublishedWall[]>().notNull().default([]),

    /**
     * Whether an agent can work with this account once it holds it (`#680`).
     *
     * **`not null` with an `unknown` default**, rather than nullable. A null and
     * an `unknown` would be two spellings of *nobody has looked*, and the one
     * being read would be whichever the last writer happened to produce — the
     * same argument `operator_guess` makes one screen up, reached the other way
     * because there is an honest word for the empty answer here and there is not
     * one there.
     *
     * The default is what makes the backfill a no-op: every row that existed
     * before this column did was written by somebody who was never asked, and
     * `unknown` is exactly what they said.
     */
    agentApi: text('agent_api').notNull().default('unknown'),

    /**
     * Where this provider's signup code arrives (`#597`).
     *
     * `not null` with an `unknown` default, for the reason `agent_api` above it
     * is: there is an honest word for the empty answer, so a null would be a
     * second spelling of it.
     */
    signupCode: text('signup_code').notNull().default('unknown'),

    /**
     * What an agent must already hold before the first step (`#815`).
     *
     * **`jsonb` beside `runtimes` rather than a join table**, and for the same
     * reason: it is a short closed list read only with its own row, never
     * queried across rows on its own. The check constraint below is what keeps a
     * `jsonb` from becoming the place unvalidated words accumulate.
     *
     * **`not null` with `[]`, and the empty array is a real answer here** — the
     * one place in this group where the default is not the honest *nobody
     * looked*. It cannot be: there is no word for the empty set that is not also
     * the empty set. So the pairing is what carries it. A row whose `terms` and
     * `cost` are both `unknown` has not been asked; a row that has been asked
     * says so in those two, and its empty `needs` means *nothing needed*.
     */
    needs: jsonb('needs').$type<RecipeNeed[]>().notNull().default([]),

    /**
     * What the provider's terms say about an agent holding this (`#815`).
     *
     * `not null` with an `unknown` default, as `agent_api` and `signup_code` are.
     *
     * **Nothing reads this to decide whether to serve the row.** `#815`: a
     * `human-only` entry is not removed, hidden or refused — the value drives a
     * sentence on the page. A future index on this column for filtering would be
     * the first sign that decision has been quietly reversed.
     */
    terms: text('terms').notNull().default('unknown'),

    /**
     * Where in the walk money is required (`#815`).
     *
     * **Not `paid`, twenty lines up.** That column is paid *placement* — the
     * disclosure that a provider paid to be listed — and it is invisible to
     * ranking on purpose. This one is what the account costs the agent. They were
     * proposed as one field and they are two, because collapsing them would have
     * deleted the disclosure.
     */
    cost: text('cost').notNull().default('unknown'),

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

    /**
     * When this recipe was last confirmed to work, and by whom (`#525`).
     *
     * **A wrong recipe is worse than no recipe**: it sends every subsequent
     * agent down a path that does not work, and looks authoritative because the
     * Colony published it. Null means nobody has confirmed it at all, which is
     * treated exactly as *long ago* — `isStale` in core answers both the same
     * way, because a reader can act on neither.
     *
     * **Staleness is derived from this and never stored as a flag.** A `stale`
     * column would need something sweeping it on a schedule, and the day that
     * job stops the catalogue silently claims to be current. A comparison cannot
     * stop running.
     */
    lastConfirmedAt: timestamp('last_confirmed_at', { withTimezone: true, mode: 'string' }),
    lastConfirmedBy: uuid('last_confirmed_by'),

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
     * The six states, in SQL, so a psql prompt cannot invent a seventh (`#588`,
     * `#604`).
     *
     * **`sql.raw` and not an interpolated value**, which `RECIPE_MAX_STEPS`
     * above needs for the same reason: an interpolated one becomes a bind
     * parameter, and `drizzle-kit generate` writes the parameter *marker* into
     * the migration file. The constraint would then be `in ($1, $2, $3)` and the
     * migration would fail on the way in.
     */
    check(
      'provider_recipes_status_is_known',
      sql`${table.status} in (${sql.raw(RECIPE_STATUSES.map((one) => `'${one}'`).join(', '))})`,
    ),

    /**
     * The shelf vocabulary, in SQL, generated from `core`'s list (`#589`).
     *
     * **Written from `AtlasCategorySchema` rather than typed out beside it**, so
     * the two cannot drift: a category added in `core` and forgotten here would
     * be a value the write shape accepts and the database refuses, which surfaces
     * as a failed insert nobody expected. `provider-recipes.test.ts` asserts the
     * two sets are the same by inserting every one of them.
     */
    check(
      'provider_recipes_category_is_known',
      sql`${table.category} in (${sql.raw(ATLAS_CATEGORIES.map((one) => `'${one}'`).join(', '))})`,
    ),

    /**
     * The direction vocabulary, and the kinds it may appear on (`#976`).
     *
     * **Two clauses in one constraint, because the second is what the column is
     * for.** A direction on a mailbox entry is not a smaller mistake than an
     * invented word: it is a scope nothing reads, on a row a reader would then
     * believe had been scoped. `DIRECTIONAL_KINDS` is `core`'s list, written
     * here for the reason the category check is written from
     * `AtlasCategorySchema` — one vocabulary, and a kind gaining an axis is a
     * constraint swap rather than two places to remember.
     */
    check(
      'provider_recipes_direction_is_known',
      sql`${table.direction} is null
          or (${table.direction} in (${sql.raw(
            RECIPE_DIRECTIONS.map((one) => `'${one}'`).join(', '),
          )})
              and ${table.kind} in (${sql.raw(
                DIRECTIONAL_KINDS.map((one) => `'${one}'`).join(', '),
              )}))`,
    ),

    /**
     * The caution vocabulary, and where a scoped one may appear (`#1041`).
     *
     * **The direction check again, one level down.** A caution scoped to a
     * capability the kind does not have is a warning the shelf silently ignores
     * — `directionScoped` would hand it to nobody — so it is refused at the same
     * door and for the same reason the column above is.
     *
     * **`jsonb_path_exists` and not a subquery**, for the reason
     * `provider_recipes_published_steps_are_written` records: PostgreSQL refuses
     * a subquery in a check constraint outright (`cannot use subquery in check
     * constraint`, `0A000`), and a jsonpath is an ordinary function call over the
     * value. The first clause matches an element whose `direction` is neither
     * null nor one of the three words; the second matches any scoped element at
     * all, and is what the kind gate is written against.
     *
     * **Distinctness is the one rule not here**, and it is not an oversight:
     * *each direction at most once* over a `jsonb` array cannot be written
     * without a subquery. It lives in `cautionsAreDistinct` and is refined at
     * both write doors — the entry's and the quest deliverable's.
     */
    check(
      'provider_recipes_cautions_are_scoped',
      sql`jsonb_typeof(${table.cautions}) = 'array'
          and jsonb_array_length(${table.cautions}) <= ${sql.raw(String(RECIPE_MAX_CAUTIONS))}
          and not jsonb_path_exists(
            ${table.cautions},
            '$[*] ? (@.direction != null && ${sql.raw(
              RECIPE_DIRECTIONS.map((one) => `@.direction != "${one}"`).join(' && '),
            )})'
          )
          and (${table.kind} in (${sql.raw(DIRECTIONAL_KINDS.map((one) => `'${one}'`).join(', '))})
               or not jsonb_path_exists(${table.cautions}, '$[*] ? (@.direction != null)'))`,
    ),

    check(
      'provider_recipes_operator_guess_is_known',
      sql`${table.operatorGuess} is null
          or ${table.operatorGuess} in (${sql.raw(
            OPERATOR_GUESSES.map((one) => `'${one}'`).join(', '),
          )})`,
    ),

    /** Written from `AgentApiSchema`, for the reason the category check is (`#680`). */
    check(
      'provider_recipes_agent_api_is_known',
      sql`${table.agentApi} in (${sql.raw(AGENT_APIS.map((one) => `'${one}'`).join(', '))})`,
    ),

    /** The same, from `SignupCodeSchema` (`#597`). */
    check(
      'provider_recipes_signup_code_is_known',
      sql`${table.signupCode} in (${sql.raw(SIGNUP_CODES.map((one) => `'${one}'`).join(', '))})`,
    ),

    /** The same again, from `ProviderTermsSchema` (`#815`). */
    check(
      'provider_recipes_terms_is_known',
      sql`${table.terms} in (${sql.raw(PROVIDER_TERMS.map((one) => `'${one}'`).join(', '))})`,
    ),

    /** And from `SignupCostSchema` (`#815`). */
    check(
      'provider_recipes_cost_is_known',
      sql`${table.cost} in (${sql.raw(SIGNUP_COSTS.map((one) => `'${one}'`).join(', '))})`,
    ),

    /**
     * Every entry in `needs` is a word `RecipeNeedSchema` knows (`#815`).
     *
     * **Containment rather than a loop**, because a check constraint may not hold
     * a subquery: `<@` on two `jsonb` arrays is true exactly when every element on
     * the left appears on the right, and `[]` is contained by everything, which is
     * the default and has to pass.
     *
     * **What this does not enforce is uniqueness.** `["email", "email"]` is
     * contained by the vocabulary and would survive here. `RecipeNeedsSchema`
     * refuses it at the boundary, which is where it belongs — a repeat is a
     * malformed request rather than a corrupt row, and the table's job is that no
     * word outside the vocabulary ever lands. The length bound is what keeps a
     * repeat from being unbounded.
     */
    check(
      'provider_recipes_needs_are_known',
      sql`jsonb_typeof(${table.needs}) = 'array'
          and jsonb_array_length(${table.needs}) <= ${sql.raw(String(RECIPE_NEEDS.length))}
          and ${table.needs} <@ ${sql.raw(
            `'[${RECIPE_NEEDS.map((one) => `"${one}"`).join(', ')}]'::jsonb`,
          )}`,
    ),

    /**
     * **A guess and a walk cannot disagree, because the guess is refused where
     * there is a walk** (`#589`).
     *
     * This is the constraint that makes *derived, never typed* true rather than
     * merely intended. An entry with steps answers the operator question in the
     * steps; a stored answer beside them is a second record that nothing keeps in
     * step, and the acceptance criterion asks for the disagreement to be
     * unrepresentable rather than caught.
     */
    check(
      'provider_recipes_operator_guess_only_without_steps',
      sql`${table.operatorGuess} is null or jsonb_array_length(${table.steps}) = 0`,
    ),

    /**
     * A refusal says why; a working entry says how and how it is proved; an
     * unwritten one says neither.
     *
     * Every direction in SQL as well as in `WriteProviderRecipeSchema`, because the
     * seed writes through neither: a hand-written entry with `status = 'refused'` and
     * no reason would be a dead end a reader cannot act on, and nothing in the
     * request shape can stop a psql prompt.
     *
     * **`retired` is exempted here rather than added to the pair** (`#604`). An
     * entry withdrawn while it was refused keeps its reason, and re-checking the
     * old shape at withdrawal time would make some rows unretireable because of
     * a rule written after them. A withdrawal that can fail is one somebody
     * works around by deleting the row, which is the thing these two columns
     * exist to stop.
     */
    check(
      'provider_recipes_refusal_says_why',
      sql`${table.status} = 'retired'
          or (${table.status} = 'refused' and ${table.refusal} is not null)
          or (${table.status} <> 'refused' and ${table.refusal} is null)`,
    ),

    /**
     * A withdrawal says when and why, and nothing else claims to be one
     * (`#604`).
     *
     * The same pair as `refused`/`refusal` one state along: a state whose
     * explanation is optional is one that arrives without an explanation on the
     * row nobody reviewed.
     */
    check(
      'provider_recipes_retirement_says_when_and_why',
      sql`(${table.status} = 'retired'
           and ${table.retiredAt} is not null
           and ${table.retiredReason} is not null)
          or (${table.status} <> 'retired'
              and ${table.retiredAt} is null
              and ${table.retiredReason} is null)`,
    ),

    /**
     * A published entry has a walk and a proof; a draft has a walk (`#604`).
     *
     * **`draft` is the one state that carries steps without `proves`**, and it is
     * safe because no public surface reads a draft. A walk that got an account
     * and did not establish how to prove it is a real outcome and a reviewable
     * one; refusing to store it would leave the walk's output in a GitHub issue,
     * which is the defect `#601` is named for.
     */
    check(
      'provider_recipes_joinable_has_steps',
      sql`${table.status} not in ('joinable', 'draft')
          or (jsonb_array_length(${table.steps}) between 1 and ${sql.raw(String(RECIPE_MAX_STEPS))}
              and (${table.status} = 'draft' or ${table.proves} is not null))`,
    ),

    /**
     * **A step may be wordless only while the entry is a draft** (`#601`).
     *
     * `RecipeStepSchema.instruction` became optional so that a walk can record
     * *this step happened and who it needed* without the Colony inventing the
     * sentence `#517` says is its to write. This is the other half: publishing
     * is exactly the act of a steward having supplied what the walk could not
     * observe, and an entry that left `draft` with a wordless step would be a
     * recipe with a blank line in it, handed to an agent as a path to follow.
     *
     * **In SQL and not only in `WriteProviderRecipeSchema`**, for this table's
     * standing reason: the seed and a `psql` prompt write through neither.
     *
     * `retired` is exempt because it keeps whatever it had — an entry withdrawn
     * while it was still a draft keeps the record of the walk, which is the
     * argument for `retired` existing at all.
     */
    check(
      'provider_recipes_published_steps_are_written',
      /**
       * **`jsonb_path_exists` and not a subquery**, which was the first
       * spelling: PostgreSQL refuses a subquery in a check constraint outright
       * — `cannot use subquery in check constraint`, `0A000` — so the obvious
       * `not exists (select … jsonb_array_elements(…))` cannot be written here
       * at all. A jsonpath is an ordinary function call over the value and is
       * allowed.
       *
       * `!exists(@.instruction)` matches an element with **no such key**, which
       * is the shape an absent optional field takes in `jsonb` — a filter for
       * `== null` would not match it, because the key is missing rather than
       * null. Verified against PostgreSQL 16: it answers true for a step
       * without one, false for a step with one, and false for an empty array.
       */
      sql`${table.status} in ('draft', 'retired')
          or not jsonb_path_exists(${table.steps}, '$[*] ? (!exists(@.instruction))')`,
    ),

    /**
     * A state with no walk behind it has nothing to walk and nothing to prove.
     *
     * **This is the one that carries `unwritten`'s whole meaning.** A row marked
     * *nobody has looked* that carries three steps is a half-written recipe
     * wearing the honest label, and it fails at step three for whoever trusts it.
     * `proposed` is held to the same rule for the same reason, one step earlier.
     *
     * `retired` is exempt: it keeps whatever it had, which is what makes its page
     * a record rather than an empty apology.
     */
    check(
      'provider_recipes_unjoinable_is_empty',
      sql`${table.status} in ('joinable', 'draft', 'retired')
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

    /**
     * A rung may only be named where a rung is the proof (`#622`).
     *
     * The rejection case this issue asks for, in the database — the same shape
     * `refusal` and `retired_reason` have: a column that only means something in
     * one state is refused in every other, rather than left to a writer to
     * remember.
     */
    check(
      'provider_recipes_proves_task_iff_rung',
      sql`${table.provesTask} is null or ${table.proves} = 'rung'`,
    ),

    /**
     * **What the account is for comes after the account** (`#637`).
     *
     * A reach starts from a proved account and carries at least one step, and
     * both halves are the same statement: an entry with a capability and nothing
     * to walk claims the account is good for something and says nothing about
     * how, which is the shape `unwritten` exists to avoid one level up.
     *
     * In SQL as well as in `WriteProviderRecipeSchema`, for this table's
     * standing reason: the seed and a `psql` prompt write through neither.
     */
    check(
      'provider_recipes_reach_follows_a_proof',
      sql`${table.reaches} is null
          or (${table.proves} is not null
              and ${table.reaches} ? 'capability'
              and jsonb_array_length(${table.reaches} -> 'steps') >= 1)`,
    ),

    /**
     * **One budget for both sequences**, because the agent walks one numbered
     * list and the walk report's positions index into it. Two bounds would be
     * the one bound doubled by writing the second half in a different column.
     */
    check(
      'provider_recipes_reach_shares_the_step_budget',
      sql`jsonb_array_length(${table.steps})
            + coalesce(jsonb_array_length(${table.reaches} -> 'steps'), 0)
          <= ${sql.raw(String(RECIPE_MAX_STEPS))}`,
    ),

    /** A reach step is a step: wordless only while the entry is a draft (`#601`, `#637`). */
    check(
      'provider_recipes_published_reach_is_written',
      sql`${table.status} in ('draft', 'retired')
          or ${table.reaches} is null
          or not jsonb_path_exists(${table.reaches} -> 'steps', '$[*] ? (!exists(@.instruction))')`,
    ),

    /**
     * **The person is the account's** (`#637`). A handoff resolves its step by
     * counting into `steps`, so an operator step numbered past the account's own
     * is one the agent is told to open and nothing can find.
     */
    check(
      'provider_recipes_reach_is_walked_by_the_agent',
      sql`${table.reaches} is null
          or not jsonb_path_exists(${table.reaches} -> 'steps', '$[*] ? (@.actor <> "agent")')`,
    ),
  ],
)
