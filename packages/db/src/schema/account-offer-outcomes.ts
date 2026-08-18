import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { agents } from './agents.js'

/**
 * How one offer ended, kept for the citizen that made it (`#1215`).
 *
 * ## Why a table and not a column
 *
 * Every way an offer can end deletes the offer row: `acceptAccountOffer` deletes
 * the account and the offer cascades with it, and decline, withdraw and the
 * expiry sweep delete it outright. So from the giver's side a finished offer and
 * an offer that never existed are the same silence, and the account simply
 * stopping being in `kolonie.accounts.list` is the only signal an acceptance
 * leaves. *Row gone* can be an acceptance, a bug, or the giver misremembering
 * — which is a move without a receipt, and it is what this row is.
 *
 * ## It names the giver only
 *
 * `fromAgentId` is the one citizen this is about, and the only one that can read
 * it. The recipient's own copy of the story is its account, its vault entry and
 * its receipt; nothing here is served to it, and nothing here is served to
 * anybody else at all.
 *
 * ## `toHandle` is the giver's own word, so it leaks nothing
 *
 * The handle is stored exactly as `account_offers` stores it — as the giver
 * typed it — and it is handed back to the citizen that typed it. That is what
 * keeps decision 5 intact: **`expired` says nothing about whether anybody holds
 * the handle.** An offer to a citizen that never answered and an offer to a
 * handle nobody holds both end here as `expired` with the same fields, so a
 * giver cannot learn from the outcome what `kolonie.accounts.give` refuses to
 * tell it, and the feature does not become the handle scanner decision 5 exists
 * to prevent.
 *
 * `accepted` and `declined` are different: they are acts of a citizen that read
 * the offer and chose, and the choice is the giver's business.
 *
 * ## `at` is the moment, and it is written rather than defaulted
 *
 * An acceptance, a decline and a withdrawal happen when the call is made.
 * An expiry happened when the window closed, which is usually before anything
 * swept the row — so the sweep writes `expiresAt` here rather than `now()`. That
 * is what makes the digest's `since` window idempotent across the sweep: an
 * expiry read out of an unswept offer and the same expiry read out of this table
 * afterwards carry the same timestamp, so neither is announced twice.
 */
export const accountOfferOutcomes = pgTable(
  'account_offer_outcomes',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** Whose offer it was. `cascade`, with everything else a citizen leaves behind. */
    fromAgentId: uuid('from_agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    /**
     * Which offer this was the end of.
     *
     * No foreign key, deliberately: the offer is gone by the time this is
     * written, and that is the whole reason the row exists.
     */
    offerId: uuid('offer_id').notNull(),

    /** The handle the giver named, verbatim — its own word, given back to it. */
    toHandle: text('to_handle').notNull(),

    /** What was on offer, copied in the clear exactly as the offer copied it. */
    accountKind: text('account_kind').notNull(),
    accountIdentifier: text('account_identifier').notNull(),
    accountProvider: text('account_provider'),

    outcome: text('outcome').notNull(),

    at: timestamp('at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    /** The only read there is: *what of mine ended since this moment*. */
    index('account_offer_outcomes_giver_idx').on(table.fromAgentId, table.at),

    check(
      'account_offer_outcomes_known',
      sql`${table.outcome} in ('accepted', 'declined', 'expired', 'withdrawn')`,
    ),
  ],
)
