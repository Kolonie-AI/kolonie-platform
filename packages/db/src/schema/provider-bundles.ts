import { pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * A named set of catalogue entries, with a reason (#531).
 *
 * **The row holds a name and an argument and nothing else.** Every fact about a
 * provider — its steps, its proof method, whether it can be joined at all —
 * belongs to `provider_recipes` and is read from there. A bundle that carried a
 * copy would be a second place for *this provider stopped accepting agents* to
 * be true, and the two would disagree within a month.
 */
export const providerBundles = pgTable('provider_bundles', {
  /** A short stable name — `starter`, `design`, `research`. */
  slug: text('slug').primaryKey(),
  title: text('title').notNull(),
  /**
   * Why these belong together, in a sentence.
   *
   * **The whole value of a bundle over a filter.** *An agent that does design
   * work wants these five* is a recommendation; five provider names is a shorter
   * catalogue.
   */
  reason: text('reason').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
})

/**
 * Which entries a bundle points at, and in what order.
 *
 * ## References rather than a copy, and deliberately without a foreign key
 *
 * `provider_recipes` is keyed on `(kind, provider)` as **text**, for the reason
 * that table gives: a provider the Colony has never heard of must not be a
 * migration. A foreign key here would make a bundle undeployable until its
 * entries existed, which inverts the useful order — a bundle is a statement
 * about what an agent needs, and the catalogue catching up is the work `#534`
 * prioritises.
 *
 * So a bundle may name an entry that does not exist yet. The read joins and says
 * so; it does not hide the row, because *nobody has written this one yet* is a
 * fact an operator should see rather than a gap it cannot account for.
 *
 * ## There is no order column, and that is `#548`'s rule rather than an omission
 *
 * `#531` does require an order — a mailbox and a number first, because those are
 * what take the operator out of the loop. **It is derived on every read** by
 * `inBundleOrder`, exactly as `#545` derives the Atlas's own order from
 * measurements.
 *
 * A stored ordering column would be a placement inside a recommendation that
 * somebody could be sold, and `#543` says paying buys nothing about ordering.
 * `atlas-counterparty.test.ts` enforces that by refusing the words for one in
 * any provider table, on the argument that a field which exists will eventually
 * be set — which is the correct enforcement, and it caught this table on the
 * first draft.
 */
export const providerBundleEntries = pgTable(
  'provider_bundle_entries',
  {
    bundleSlug: text('bundle_slug')
      .notNull()
      .references(() => providerBundles.slug, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    provider: text('provider').notNull(),
  },
  (table) => [primaryKey({ columns: [table.bundleSlug, table.kind, table.provider] })],
)
