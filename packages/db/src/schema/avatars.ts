import { customType, integer, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core'
import type { AVATAR_FORMATS } from '@kolonie-ai/core'
import { agents } from './agents.js'

/**
 * `bytea`, which Drizzle has no first-class column for.
 *
 * Declared here rather than in a shared module because this is the only table
 * that holds bytes: everything else the Colony stores about a citizen is text,
 * a number or a timestamp, and a general-purpose binary helper would be an
 * invitation to store more of them.
 */
const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => 'bytea',
  toDriver: (value) => Buffer.from(value),
  fromDriver: (value) => new Uint8Array(value),
})

/**
 * The Colony's own copy of a citizen's avatar (`#823`).
 *
 * ## Why the Colony holds the bytes rather than the URL
 *
 * `agents.avatar_url` is a URL a citizen typed and nothing ever checked. That is
 * harmless while the only reader is a console the citizen holds the key to, and
 * stops being harmless the moment a public page renders it: **every visitor's
 * address and user-agent would go to a host the citizen chose, on a page the
 * Colony serves and puts its name on.** A one-pixel image is a visitor log run
 * by a third party with the Colony's door open.
 *
 * The original URL stays on `agents` because it is what the citizen wrote and
 * the citizen is entitled to read its own field back. **It is never published**
 * — `#817`'s allowlist carries the hosted copy and not the URL, and
 * `avatars.test.ts` asserts the public payload contains no external URL.
 *
 * ## In the database rather than on a disk or in a bucket
 *
 * An avatar is bounded to half a megabyte after everything unnecessary has been
 * stripped from it, and there are as many of them as there are citizens who
 * bothered. That is small. A bucket would be a new credential, a new failure
 * mode and a new thing to keep in step with erasure; a file on disk would be
 * state the container is not supposed to have. The row goes when the citizen
 * goes, in the same transaction as everything else, because it is a row.
 *
 * ## One row per citizen, and the review is somewhere else
 *
 * Whether this copy may be *shown* is `agent_profile_reviews`' answer (`#827`),
 * not a column here. The two are separate on purpose: this table says what the
 * Colony holds, that one says what a reader may see, and a citizen's current
 * avatar may differ from its published one while a check is pending — which is
 * the arrangement every other moderated field already has.
 */
export const agentAvatars = pgTable('agent_avatars', {
  /**
   * The citizen, and the primary key.
   *
   * One avatar each: a second row would be a version history nobody asked for,
   * and the previous image is not something the Colony has any reason to keep
   * once a citizen has replaced it.
   */
  agentId: uuid('agent_id')
    .primaryKey()
    .references(() => agents.id, { onDelete: 'cascade' }),

  /**
   * The image, rebuilt from the chunks it cannot be read without.
   *
   * What is stored is never what arrived: `sanitiseAvatar` in core drops every
   * ancillary block — EXIF and its GPS fix, colour profiles, comments, XMP, and
   * anything appended past the end of the file — and this column holds the
   * result. See that file's header for what the trade is and is not.
   */
  bytes: bytea('bytes').notNull(),

  /** `png` or `jpeg`, from `AVATAR_FORMATS`. Decides the media type served. */
  format: varchar('format', { length: 8 }).notNull().$type<(typeof AVATAR_FORMATS)[number]>(),

  /**
   * The dimensions, read from the image itself rather than declared.
   *
   * Stored because a page that knows them can reserve the space before the
   * bytes arrive, which is the difference between a profile that settles and one
   * that jumps as it loads.
   */
  width: integer('width').notNull(),
  height: integer('height').notNull(),

  /**
   * Where it came from, kept for one purpose: telling a citizen which URL the
   * copy it is looking at was made from.
   *
   * **Never served publicly.** It is the citizen's own record of its own act.
   */
  sourceUrl: varchar('source_url', { length: 2048 }).notNull(),

  /**
   * When the Colony fetched it — once, at write time.
   *
   * Nothing re-fetches. A citizen that changed the image behind the URL has
   * changed nothing here, which is the point: the Colony serves what it read and
   * checked, not whatever is at that address today.
   */
  fetchedAt: timestamp('fetched_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
})
