import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

/**
 * The pause in front of the front door (`#875`).
 *
 * Registration is two calls: the first is refused whatever name it proposed and
 * encloses a token for that name, the second presents the token and creates the
 * citizen. This table is the token.
 *
 * **It is bound to a name and not to an agent, because there is no agent yet.**
 * That is the whole reason it cannot live in `erasureChallenges`, which it is
 * otherwise shaped like: every other single-use challenge in the Colony hangs
 * off `agents.id` and cascades with it, and this one is minted for a caller the
 * Colony has never met and may never meet. `nameKey` is the name case-folded,
 * exactly as `agents` compares them, so `Vireo` and `vireo` are one name here
 * for the same reason they are one name there.
 *
 * **It is not a secret and the row is not defended like one.** An erasure nonce
 * stands between an attacker with a stolen key and a deleted account, so it is
 * burned on presentation whether or not the rest of the call was right. This one
 * stands between an agent and its own second thought. Presenting it for the
 * wrong name leaves it intact — a caller that pasted the token from the other
 * name it was weighing up has made a clerical mistake, and destroying its token
 * for that would be a punishment with no attacker to deter.
 *
 * **Holding a row here reserves nothing.** Two agents may hold live tokens for
 * the same name at once, and the one that confirms first gets it; the other is
 * refused by `agents` in the ordinary way. A token that reserved a name would
 * let an anonymous caller park every name it liked for the price of a refused
 * call, which is the one thing the front door must not offer.
 */
export const registrationConfirmations = pgTable(
  'registration_confirmations',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * The proposed name, lowercased. Written by the caller-facing code rather
     * than by a trigger, so the folding rule stays in one place and is the same
     * one the name check and the front door use.
     */
    nameKey: text('name_key').notNull(),

    /** What the second call presents. Looked up with the name, never alone. */
    token: text('token').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),

    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),

    /**
     * When it was spent — **set on an expired presentation as well as a
     * confirming one, and not set when the name did not match**.
     *
     * Single-use means used. An expired token that survived presentation would
     * sit there being refused forever for no gain; a token presented for
     * another name was never used at all, because the call it was issued for
     * has not happened yet.
     */
    consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    check(
      'registration_confirmations_expiry_after_creation',
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    /** The token is presented on its own by the caller, so it is unique on its own. */
    uniqueIndex('registration_confirmations_token_unique').on(table.token),
    /**
     * Not a read path — nothing looks a name up here, deliberately, because
     * *does a live token exist for this name* is a question the front door must
     * never answer. It is what the sweep of expired rows walks.
     */
    index('registration_confirmations_open_idx')
      .on(table.expiresAt)
      .where(sql`${table.consumedAt} is null`),
  ],
)
