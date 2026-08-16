import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  foreignKey,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

/**
 * The Atlas taxonomy, as rows (`#1102`).
 *
 * **A table and not a `z.enum`, for the reason the entries themselves are a
 * table**: a shelf the Colony discovers it needs costs a row, not a release
 * across seven skill repositories. `AtlasCategorySchema` in `core` keeps the
 * fifteen it was seeded with as a compile-time convenience for the code that
 * genuinely branches on one of them; what makes a category *valid* is now the
 * foreign key from `provider_recipes.category` into this table.
 *
 * **Exactly two levels, enforced by the database rather than by a comment**
 * (`#1102`, decision 2). A row with a null parent is a top category; one with a
 * parent is a shelf under it. A three-level tree is a different product and
 * nobody asked for one, so the schema refuses it: see the generated columns and
 * the composite self-reference below, which together make *a parent that itself
 * has a parent* unrepresentable rather than merely discouraged.
 */
export const atlasCategories = pgTable(
  'atlas_categories',
  {
    /**
     * The slug, and the primary key.
     *
     * **It is an address before it is an identifier** — `?category=mailbox` is a
     * link somebody has bookmarked — so the key is the slug itself and a rename
     * is deliberately expensive. The fifteen seeded here keep the slugs they had
     * as enum members, which is why the migration owes nobody a redirect.
     */
    slug: text('slug').primaryKey(),

    /** What the shelf is called where a reader sees it, e.g. `Identity and security`. */
    title: text('title').notNull(),

    /** One sentence saying what belongs here, for the reader who has not decided yet. */
    standfirst: text('standfirst').notNull(),

    /**
     * The top category this one hangs from, or null if this *is* a top category.
     *
     * Self-referencing, and constrained below to point only at a row that has no
     * parent of its own.
     */
    parentSlug: text('parent_slug'),

    /**
     * Whether this row is a top category — `parent_slug is null`, said as a
     * column so a foreign key can point at it.
     *
     * **Generated and stored rather than written by a caller**, because a caller
     * that could set it could set it wrongly, and the whole point of the pair
     * below is that the two-level rule holds for a row inserted at a psql prompt
     * by somebody who has never read this file.
     */
    isTop: boolean('is_top').generatedAlwaysAs(sql`("parent_slug" is null)`),

    /**
     * What a parent must be: `true` when this row has one, and null when it does
     * not.
     *
     * **The null is the whole trick.** The composite foreign key below is
     * `MATCH SIMPLE` — Postgres's default — which skips the check entirely when
     * any of its columns is null. So a top category, whose `parent_is_top` is
     * null, references nothing and is free to have no parent; a sub category
     * carries `true` and is therefore forced to name a row whose `is_top` is
     * `true`. A sub category's own `is_top` is `false`, so nothing can hang from
     * it, and the third level does not exist.
     */
    parentIsTop: boolean('parent_is_top').generatedAlwaysAs(
      sql`(case when "parent_slug" is null then null else true end)`,
    ),

    addedAt: timestamp('added_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * What the composite foreign key points at. The slug is already unique as
     * the primary key; this pairs it with `is_top` so that *a row that is a top
     * category* is a thing another row can reference.
     */
    uniqueIndex('atlas_categories_slug_is_top').on(table.slug, table.isTop),

    /** A parent must exist, and must be a top category. Both halves, in one key. */
    foreignKey({
      name: 'atlas_categories_parent_is_top',
      columns: [table.parentSlug, table.parentIsTop],
      foreignColumns: [table.slug, table.isTop],
    }),

    /**
     * A slug is lower case, hyphenated and its own address. Written here rather
     * than trusted to the writer for the reason the vocabulary checks on
     * `provider_recipes` are: this table is meant to be added to by hand.
     */
    check('atlas_categories_slug_is_a_slug', sql`${table.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),

    /** A shelf nobody can be pointed at is not a shelf. */
    check(
      'atlas_categories_says_something',
      sql`length(${table.title}) between 1 and 80 and length(${table.standfirst}) between 1 and 300`,
    ),
  ],
)
