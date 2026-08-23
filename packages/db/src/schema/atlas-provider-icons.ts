import { customType, integer, pgTable, timestamp, varchar } from 'drizzle-orm/pg-core'
import type { AvatarFormat } from '@kolonie-ai/core'

/**
 * `bytea`, declared here for the reason `avatars.ts` declares its own.
 *
 * That file says a shared binary helper *"would be an invitation to store more
 * of them"*, and this table is the second and — on the same reasoning — is meant
 * to be the last. Both hold a small image the Colony fetched from somewhere else
 * and re-serves from its own domain; the argument for a third would have to be
 * made again from scratch rather than by pointing at a helper that already
 * exists.
 */
const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => 'bytea',
  toDriver: (value) => Buffer.from(value),
  fromDriver: (value) => new Uint8Array(value),
})

/**
 * The Colony's own copy of a provider's icon (`#1405`).
 *
 * ## Why the bytes rather than the address
 *
 * `#823` made this argument about avatars and it is sharper here, because there
 * are four hundred providers and one Atlas. **An `<img>` pointing at a
 * provider's host would announce every reader of that provider's page to that
 * provider** — address, user-agent, referrer if the policy allowed one — from a
 * page the Colony serves and puts its name on. A catalogue that tells four
 * hundred companies who is reading about them is a worse thing than a catalogue
 * with no pictures on it.
 *
 * So `ATLAS_HEADERS` keeps `img-src 'self'` untouched and this table is what
 * makes that possible. **Nothing about this issue loosens a policy**, which is
 * the form `#1405` decision 4 takes once the bytes are held here.
 *
 * ## A row per provider, whether or not there is an icon
 *
 * **`bytes` null is a finding and not an absence.** It says the sweep looked and
 * came back with nothing — a host that answered 404, a page declaring an SVG,
 * bytes that were not a PNG. Without it the sweep could not tell *not yet
 * looked* from *looked and there is nothing*, and would re-fetch every iconless
 * provider on every pass forever. That is the failure this column exists to
 * refuse, and `refreshAfter` is what puts a floor under how often the Colony
 * asks a host that has already said no.
 *
 * ## The catalogue is not a citizen, so nothing here cascades
 *
 * A provider is a row in the Colony's own catalogue rather than something a
 * citizen holds, so there is no `onDelete` and no erasure path: `provider` is
 * text and an entry that leaves the Atlas leaves a row here that the sweep stops
 * refreshing. That is the same shape `atlas_renames` has, and it is why a
 * provider that comes back keeps the icon it had.
 */
export const atlasProviderIcons = pgTable('atlas_provider_icons', {
  /**
   * The provider, and the primary key.
   *
   * The catalogue's own identifier — the one in the URL — rather than a
   * generated id, because every reader of this table already has it and a join
   * to learn it would be a join to learn nothing.
   */
  provider: varchar('provider', { length: 128 }).primaryKey(),

  /**
   * The image, rebuilt by `sanitiseAvatar`, or null where there is none.
   *
   * **The same sanitiser as an avatar, and reusing it is a decision rather than
   * a convenience.** It reads the magic number and the container structure,
   * drops every ancillary block, and refuses SVG outright with the sentence this
   * surface would otherwise have had to invent: *it can carry scripts and
   * external references, and the Colony will not serve those from its own
   * domain.* A second image path for a 16-pixel decoration would be a second
   * thing to keep correct, and the one that gets forgotten is the one that
   * serves a stranger's markup from `kolonie.ai`.
   */
  bytes: bytea('bytes'),

  /** `png` or `jpeg`, from `AVATAR_FORMATS`. Null exactly when `bytes` is. */
  format: varchar('format', { length: 8 }).$type<AvatarFormat>(),

  /** Read from the image itself, so a page can reserve the space it will take. */
  width: integer('width'),
  height: integer('height'),

  /**
   * Which of the candidate addresses the bytes came from.
   *
   * **Never served publicly**, exactly as an avatar's is not: it is the Colony's
   * own record of where it looked, and publishing it would put the provider's
   * host back into the page this table exists to keep it out of.
   */
  sourceUrl: varchar('source_url', { length: 2048 }),

  /**
   * Why there is nothing, in one short slug, where `bytes` is null.
   *
   * Not published and not a message to anybody: it is what turns *the sweep
   * found nothing for two hundred providers* from a number into something that
   * can be grouped. `no-homepage`, `unreachable`, `no-candidate`, `refused`.
   */
  absence: varchar('absence', { length: 32 }),

  /** When the sweep last looked, whatever it found. */
  fetchedAt: timestamp('fetched_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),

  /**
   * The earliest the sweep may look again.
   *
   * **A column rather than arithmetic at read time**, so that a provider whose
   * host is refusing can be backed off further than one that simply has no icon
   * without the rule living in a `case` in a query. `#1405` decision 2 sets the
   * floor at seven days and this is where that floor is kept.
   */
  refreshAfter: timestamp('refresh_after', { withTimezone: true, mode: 'string' }).notNull(),
})
