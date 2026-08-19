import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { providerRecipes } from './provider-recipes.js'

/**
 * The facets an entry carries on every axis but the shelves (`#1301`).
 *
 * **Additive, and never exclusive.** A row here takes nothing away from the row
 * an entry has in `provider_recipe_categories`: a mailbox provider that pays a
 * referral is a mailbox *and* an earn rail, and the whole reason this table is
 * not a column on `provider_recipes` is that a column would have made a caller
 * choose.
 *
 * **The utility axis is refused here, by a check** (`axis <> 'utility'`, written
 * as the closed list below). The shelves are `provider_recipe_categories` and
 * `#1301` does not move them; what it must stop is the same claim being writable
 * in two tables, because two homes for one fact is two answers the first time
 * somebody writes to only one of them. `facetsFrom` in `core` reads the shelves
 * *as* utility facets, which is a projection and costs no row.
 *
 * **The vocabulary is enumerated in SQL as well as in `EarnFacetSchema`**, for
 * the reason `provider_operate_notes.tag` is: this catalogue is meant to be
 * written to at a psql prompt by somebody who has never opened the TypeScript,
 * and an earn facet spelled a second way is an earn rail nobody's filter finds.
 * A count over the axis is the point of the axis.
 *
 * **Nothing seeds it.** The migration creates it empty on purpose: an earn facet
 * is a structured claim somebody made — a scout's intake, a moderated
 * classification — and a migration that read the catalogue's prose and guessed
 * would put guesses in front of readers with nobody having reviewed one. Unset
 * is the ordinary state and stays it.
 */
export const providerRecipeFacets = pgTable(
  'provider_recipe_facets',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    recipeId: uuid('recipe_id')
      .notNull()
      .references(() => providerRecipes.id, { onDelete: 'cascade' }),

    /**
     * Which taxonomy this facet belongs to — `earn` today.
     *
     * **A column and not an assumption**, so that a third axis is a value and a
     * check, rather than a fourth table with the same three columns in it.
     */
    axis: text('axis').notNull(),

    /** The value on that axis, from the axis's own closed vocabulary. */
    slug: text('slug').notNull(),

    addedAt: timestamp('added_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    /** An entry carries a facet once. Twice is not twice as much of it. */
    uniqueIndex('provider_recipe_facets_once').on(table.recipeId, table.axis, table.slug),

    /** The axis read the other way: *who is a bounty board*, which is the filter. */
    index('provider_recipe_facets_by_facet').on(table.axis, table.slug, table.recipeId),

    /**
     * The axes this table holds, which is every axis except the shelves. See the
     * table's own note: `utility` lives in `provider_recipe_categories`, and its
     * absence here is what keeps that fact in one place.
     */
    check('provider_recipe_facets_axis_is_known', sql`${table.axis} in ('earn')`),

    /**
     * The vocabulary, per axis. Closed like a wall kind and unlike a shelf — a
     * shelf is a row because a maintainer must be able to add one without a
     * release, and an earn facet is an enum because a count over it has to mean
     * something.
     */
    check(
      'provider_recipe_facets_slug_is_known',
      sql`${table.axis} <> 'earn' or ${table.slug} in (
            'affiliate-referral', 'bounty-board', 'gig-marketplace', 'creator-payout', 'grant-quest'
          )`,
    ),
  ],
)
