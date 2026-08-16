import { sql } from 'drizzle-orm'
import { boolean, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { atlasCategories } from './atlas-categories.js'
import { providerRecipes } from './provider-recipes.js'

/**
 * Which shelves an entry sits on (`#1102`, decision 1).
 *
 * **The n:m that `provider_recipes.category` alone cannot express.** A Google
 * account is storage, and knowledge-docs, and identity-security; the single
 * column can only ever answer one of those, and answering *storage* to a reader
 * who came looking for documents is the catalogue being wrong rather than
 * incomplete.
 *
 * **The primary shelf is a row here too** (`#1102`, decision 4), duplicating
 * `provider_recipes.category` on purpose: the column stays because it is what
 * the URL, the ordering and every existing query use, and a reader that wants
 * *every* shelf then has one place to look rather than a column plus a table it
 * has to remember to union in.
 *
 * **Nothing is populated beyond that** (`#1102`, decision 8). The migration
 * gives every entry exactly the one shelf it has today. A second shelf is a
 * proposal a maintainer accepts, because shipping a migration that guesses which
 * providers are also knowledge-docs would put guesses in front of readers with
 * nobody having reviewed one.
 */
export const providerRecipeCategories = pgTable(
  'provider_recipe_categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    recipeId: uuid('recipe_id')
      .notNull()
      .references(() => providerRecipes.id, { onDelete: 'cascade' }),

    categorySlug: text('category_slug')
      .notNull()
      .references(() => atlasCategories.slug),

    /**
     * Whether this is the shelf the entry is filed under — the one
     * `provider_recipes.category` names, the one the URL uses and the one the
     * ordering runs within. Every other row here is an additional shelf.
     */
    primary: boolean('primary').notNull().default(false),

    addedAt: timestamp('added_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    /** One entry is on a shelf once. Twice is not twice as much on it. */
    uniqueIndex('provider_recipe_categories_once').on(table.recipeId, table.categorySlug),

    /**
     * At most one primary shelf per entry, as a partial unique index.
     *
     * **The database's answer and not the writer's**, which matters because two
     * primaries is not a loud failure: it is a page that renders under whichever
     * of them the planner happened to return, and a URL that works on Tuesday.
     */
    uniqueIndex('provider_recipe_categories_one_primary')
      .on(table.recipeId)
      .where(sql`"primary"`),

    /** The shelves an entry is on, which is how a reader of one entry asks. */
    uniqueIndex('provider_recipe_categories_by_category').on(table.categorySlug, table.recipeId),
  ],
)
