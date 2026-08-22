import { customType, index, pgTable, text, timestamp, varchar } from 'drizzle-orm/pg-core'

const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => 'bytea',
  toDriver: (value) => Buffer.from(value),
  fromDriver: (value) => new Uint8Array(value),
})

/**
 * A provider's own mark, fetched once and served from here (`#1405`).
 *
 * ## Why the Colony holds the bytes rather than pointing at the provider
 *
 * Decision 2, and the reason is about the reader rather than about the
 * provider's bandwidth. **A hotlinked icon tells that provider who is reading
 * the Atlas and when** — every tile on a shelf would be a request from a
 * reader's browser to a company the Colony is describing, carrying a referer
 * that names the page. A catalogue does not do that to the people reading it.
 *
 * The Atlas CSP is `img-src 'self'`, so serving from here needs no change to it;
 * pointing at the provider would have needed one, per source, for ever.
 *
 * ## A row rather than a bucket or a file
 *
 * `agent_avatars` made this argument and it holds here for the same reasons: a
 * bucket is a new credential and a new failure mode, a file on disk is state the
 * container is not supposed to have, and an icon is a few kilobytes. The row is
 * also what makes the cache honest — it has an expiry, and a sweep can find a
 * stale one without walking a filesystem.
 *
 * ## Both outcomes are cached, and the failure is the important one
 *
 * A provider whose icon could not be fetched gets a row with **no bytes** and a
 * reason. Without it every render of every shelf would retry every provider that
 * has no icon — measured 2026-08-22, that is most of them: two of eight sampled
 * entries carried a homepage at all, and a homepage is the only place an icon
 * comes from. Caching only successes would have turned a missing icon into a
 * fetch per page view.
 */
export const providerIcons = pgTable(
  'provider_icons',
  {
    /**
     * The provider, as the Atlas names it — a host, and the primary key.
     *
     * **Not the recipe's kind and provider**, which is how figures are keyed: a
     * provider has one mark whatever kinds of account it offers, and a second row
     * would be the same PNG twice with the same expiry.
     */
    provider: varchar('provider', { length: 128 }).primaryKey(),

    /**
     * The image, or null where the fetch did not produce one.
     *
     * What is stored is never what arrived: `sanitiseAvatar` rebuilds the file
     * from structurally necessary bytes and drops everything else, and it accepts
     * only `png` and `jpeg` — which is what keeps a third party's SVG from being
     * served under the Colony's own origin.
     */
    bytes: bytea('bytes'),

    /** `png` or `jpeg`, from `AVATAR_FORMATS`. Decides the media type served. */
    format: varchar('format', { length: 8 }),

    /** Where it came from, so a reader of the row can go and look. */
    sourceUrl: text('source_url'),

    /**
     * Why there is no image, in the Colony's own words.
     *
     * Present exactly when `bytes` is null. It is read by nobody at render time —
     * the page draws a monogram — and it is the whole value of the row to
     * somebody asking *why does this provider have no mark*.
     */
    refusal: text('refusal'),

    fetchedAt: timestamp('fetched_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),

    /**
     * When this stops being believed.
     *
     * `#1405` asks for at least seven days. The row is not deleted at expiry: a
     * stale icon is a better answer than no icon while the refetch is happening,
     * and the sweep replaces rather than removes.
     */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    /** The sweep's query: what has expired, oldest first. */
    index('provider_icons_expires_at_idx').on(table.expiresAt),
  ],
)
