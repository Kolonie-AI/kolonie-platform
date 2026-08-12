import { sql } from 'drizzle-orm'
import { check, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * What a provider name means, where it does not mean itself (`#546`, `#772`).
 *
 * **A 404 where a page used to be is a page that never comes back.** The Atlas
 * is meant to be linked to — by a provider, by a runtime's documentation, by an
 * agent that wrote the URL into its own notes — and a provider does get renamed:
 * `x.com` was `twitter.com`, and the catalogue would have had to choose between
 * a wrong name and a dead link.
 *
 * **A rename table rather than a slug column, and the difference is which fact
 * is stored.** A `slug` on `provider_recipes` would be a second copy of the
 * provider's name, free to disagree with it; this stores the thing that actually
 * happened — *this name used to mean that one* — and the current path stays
 * derived from the provider, as `atlasPath` requires.
 *
 * ## Two facts, one table, because they answer one question (`#772`)
 *
 * A citizen reported that `clawhub.ai` and `clawhub.com` answer `not_found`
 * independently although they are one service. That is not a rename — both names
 * are live, one redirects to the other — but **a reader resolves it with exactly
 * the same lookup**: *what does this name mean?*
 *
 * So an alias is a row here with `reason = 'alias'`, and the distinction lives in
 * that column rather than in a second table. **One table is what makes a
 * contradiction unrepresentable**: the primary key is the name being resolved, so
 * a name cannot be an alias of one provider and a rename of another. Two tables
 * would have to be checked against each other by something that remembers to, and
 * the read would consult both on every provider-keyed call.
 *
 * **The table keeps the name `atlas_renames`.** Renaming it would buy a better
 * word and cost a structural migration on a table two live surfaces read; the
 * column below is what carries the meaning, and every function over it is named
 * for what it does — `canonicalProvider`, `aliasProvider` — rather than for the
 * table.
 *
 * Rows are written by `renameProvider` and `aliasProvider` and by nothing else.
 * There is no delete path on purpose: forgetting a rename is how the dead link
 * comes back.
 */
export const atlasRenames = pgTable(
  'atlas_renames',
  {
    /**
     * The name that does not mean itself. Primary key: one name means one place.
     *
     * A second rename of the same provider adds a row and rewrites the earlier
     * ones' target, so a chain never has to be followed at read time — a redirect
     * that redirects is two round trips a crawler counts against the page.
     */
    fromProvider: text('from_provider').primaryKey(),

    /** The name it means now. */
    toProvider: text('to_provider').notNull(),

    /**
     * Whether the old name is dead or merely a second door (`#772`).
     *
     * **`renamed` says the name no longer exists** — nobody can reach the
     * provider under it, and the rows moved when it was recorded. **`alias` says
     * both names are live** and one of them is the Colony's canonical spelling.
     *
     * The read path treats them identically, and that is deliberate: an agent
     * asking about either name wants the entry. What the column changes is what a
     * curator is told when they read the table, and what a writer is allowed to
     * do — `renameProvider` moves the rows, `aliasProvider` refuses to shadow an
     * entry that exists under the alias.
     *
     * **`text` with a check rather than a `pg_enum`**, on this schema's standing
     * reason: `ALTER TYPE … ADD VALUE` cannot use the new value in the same
     * transaction, so a third state would need its migration split in two.
     *
     * The default is `renamed` because every row that existed before this column
     * did was written by `renameProvider`, which is exactly what it says.
     */
    reason: text('reason').notNull().default('renamed'),

    renamedAt: timestamp('renamed_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check('atlas_renames_reason_is_known', sql`${table.reason} in ('renamed', 'alias')`),

    /**
     * **A name cannot mean itself**, which is the one shape that makes the read
     * loop rather than resolve. Both writers refuse it, and so does the database:
     * a `psql` prompt writes through neither.
     */
    check('atlas_renames_points_elsewhere', sql`${table.fromProvider} <> ${table.toProvider}`),
  ],
)
