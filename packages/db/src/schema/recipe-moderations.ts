import { sql } from 'drizzle-orm'
import { check, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { RecipeVerdictSchema } from '@kolonie-ai/core'
import { providerRecipes } from './provider-recipes.js'

const VERDICTS = RecipeVerdictSchema.options

/**
 * Every verdict the Colony reached about a walked recipe, and what decided it
 * (`#813`).
 *
 * **A fourth table, on `atlas_moderations`' own argument.** That file says the
 * moderation tables share a *shape* rather than a subject, and that a proposal is
 * far enough from a report to deserve its own. A walked recipe is further still:
 * the subject is a path somebody took, the stages are about whether the path is
 * safe to hand to the next agent, and the row it hangs off is the catalogue entry
 * rather than the proposal that admitted the provider. Judging both against one
 * table would mean a `provider_id` and a `proposal_id` that are alternately null,
 * which is two tables wearing one name.
 *
 * **It hangs off the entry and not the walk.** A walk is one agent's account of
 * one attempt; what is being published is the entry, and the entry survives the
 * walk being superseded. `walked_recipe` on `provider_recipes` keeps the walk
 * this text came from, so nothing is lost by anchoring here — and a refusal,
 * which the table's own constraints make wipe the steps, still leaves a row here
 * saying what was refused and a `walked_recipe` saying what it was.
 *
 * **Append-only.** A draft that was held, fixed and re-judged produces a second
 * row; `content_sha256` is what says the second verdict was about different text.
 * The held verdicts are the ones worth keeping — they are the record of what the
 * Colony asked for before it would stand behind an entry.
 */
export const recipeModerations = pgTable(
  'recipe_moderations',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * The catalogue entry this verdict judged.
     *
     * `cascade`, matching every other moderation table here and for the same
     * reason: a verdict about a row that is gone is a record of nothing.
     */
    recipeId: uuid('recipe_id')
      .notNull()
      .references(() => providerRecipes.id, { onDelete: 'cascade' }),

    /** `published`, `refused` or `held`. Never a status — see the check below. */
    decision: text('decision').notNull(),

    /**
     * The model that answered, as configured at the moment of the verdict. A copy
     * and not a pointer, exactly as `atlas_moderations.model` is.
     *
     * A verdict every stage of which was arithmetic still names one: three of the
     * six stages can refuse a draft without a call, and the row still has to say
     * which model *would* have been asked, or a change of model becomes invisible
     * in exactly the runs where it was cheapest.
     */
    model: text('model').notNull(),

    /**
     * What each stage answered. `RecipeModerationStagesSchema` in core is the
     * shape, and a stage that did not run says `not-run` rather than being absent
     * — which matters more here than anywhere else, because a held draft stops
     * partway through by design and *stopped at the third question* is the whole
     * content of the verdict.
     */
    stages: jsonb('stages').notNull(),

    /**
     * The text this verdict judged, as a digest over the steps and what they
     * claim to produce.
     *
     * The same argument `atlas_moderations.content_sha256` makes, with a sharper
     * edge: a held draft is *meant* to come back changed, so one entry
     * accumulates rows on purpose and the digest is the only thing that says
     * which of them was about the sentences currently in the row.
     */
    contentSha256: text('content_sha256').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      'recipe_moderations_decision_is_a_verdict',
      sql`${table.decision} in (${sql.raw(VERDICTS.map((one) => `'${one}'`).join(', '))})`,
    ),
    check(
      'recipe_moderations_content_sha256_shape',
      sql`${table.contentSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    /** The audit read: every verdict about one entry, newest first. */
    index('recipe_moderations_recipe_idx').on(table.recipeId, table.createdAt),
  ],
)
