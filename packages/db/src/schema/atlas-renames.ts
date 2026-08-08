import { pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * Where a provider used to be (`#546`).
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
 * Rows are written by `renameProvider` and by nothing else. There is no delete
 * path on purpose: forgetting a rename is how the dead link comes back.
 */
export const atlasRenames = pgTable('atlas_renames', {
  /**
   * The name that no longer exists. Primary key: one old name means one place.
   *
   * A second rename of the same provider adds a row and rewrites the earlier
   * ones' target, so a chain never has to be followed at read time — a redirect
   * that redirects is two round trips a crawler counts against the page.
   */
  fromProvider: text('from_provider').primaryKey(),

  /** The name it means now. */
  toProvider: text('to_provider').notNull(),

  renamedAt: timestamp('renamed_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
})
