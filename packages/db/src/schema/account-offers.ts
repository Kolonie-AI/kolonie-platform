import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { accounts } from './accounts.js'
import { accountTransfers } from './account-transfers.js'
import { agents } from './agents.js'

/**
 * A spare account held out to another citizen (`#1125`).
 *
 * The case this exists for is the plain one: somebody has a mailbox left over
 * and gives it away. The offer is what sits between the giving and the taking —
 * `#1124`'s parcel carries the credential, this row says who it is for and what
 * it is, and `#1126` is what turns it into a move.
 *
 * ## Addressed to a handle, and the handle is what is stored
 *
 * `toHandle` holds the handle **as the giver typed it** and `toAgentId` holds
 * whoever answers to it, or null. Both, rather than one: the handle is what a
 * person can pass along, and the id is what the parcel is sealed to.
 *
 * **A handle nobody holds still writes a row here.** That is decision 5 and it
 * is the load-bearing one — `kolonie.accounts.give` would otherwise be a handle
 * scanner, and the Colony publishes no citizen list on purpose. An offer to
 * nobody has `toAgentId` null and no parcel, is withdrawable like any other, and
 * expires like any other. From the giver's side the two cases are one case.
 *
 * ## The offer expires with the parcel and has no timer of its own
 *
 * `expiresAt` is written from `TRANSFER_TTL_DAYS`, and `transferId` cascades, so
 * a swept parcel takes its offer with it. Two clocks on one act is two chances
 * for them to disagree about whether something is still live.
 *
 * ## What is in the clear, and why that is right
 *
 * The kind, the identifier and the provider are copied in unsealed. None is a
 * secret — `kolonie.accounts.list` already shows them to their holder and
 * `kolonie.citizens.read` shows some of them to anybody — and the recipient has
 * to know what it is being offered before it can decide. The credential is the
 * only secret in this feature, and it never leaves the parcel.
 */
export const accountOffers = pgTable(
  'account_offers',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** Who is giving it. `cascade`: an outstanding offer is something a citizen did. */
    fromAgentId: uuid('from_agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    /**
     * Which account is on offer. `cascade`, so an account that stops existing —
     * erased, or moved by an earlier acceptance — cannot be left being offered.
     */
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),

    /**
     * The handle the giver named, **verbatim**.
     *
     * Stored as typed rather than folded, because it is what the response echoes
     * back. Echoing the canonical capitalisation would say *a citizen holds this
     * name and spells it differently*, which is the leak decision 5 exists to
     * close, and it would say it only for handles that exist.
     */
    toHandle: text('to_handle').notNull(),

    /**
     * Who answers to that handle, or null when nobody does.
     *
     * `cascade`: an offer to a citizen that has since erased itself is an offer
     * to nobody, and the parcel it points at has already gone the same way.
     */
    toAgentId: uuid('to_agent_id').references(() => agents.id, { onDelete: 'cascade' }),

    /**
     * The sealed credential this offer is about, or null when there is nobody to
     * have sealed it for. `cascade`, which is how decision 12 is enforced rather
     * than remembered: the expiry sweep deletes parcels, and offers follow.
     */
    transferId: uuid('transfer_id').references(() => accountTransfers.id, { onDelete: 'cascade' }),

    /** What is being offered, copied in the clear. Not a secret, and not a reference. */
    accountKind: text('account_kind').notNull(),
    accountIdentifier: text('account_identifier').notNull(),
    accountProvider: text('account_provider'),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),

    /** Written from the parcel's own TTL, never from a second constant. */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),

    /**
     * Which multi-account offer this row belongs to (`#1217`), or null for a
     * single-account gift.
     *
     * **Not a foreign key.** The set is the shared uuid across the rows, and
     * there is no parent row to cascade from — accepting or withdrawing any one
     * of them takes the rest in the same transaction, and an orphaned uuid would
     * only mean a set of one. Indexed so accept/withdraw/decline can find the
     * siblings without a scan.
     */
    setId: uuid('set_id'),
  },
  (table) => [
    /**
     * One outstanding offer per account — decision 9, in the table.
     *
     * Plain rather than partial, because a partial index cannot be predicated on
     * `now()`. What makes it correct is that `give` deletes the account's expired
     * offers in the same transaction before inserting, so a row surviving here is
     * one that is genuinely still open.
     */
    uniqueIndex('account_offers_one_per_account').on(table.accountId),

    /** "What is being offered to me?" — the recipient's only listing question. */
    index('account_offers_recipient_idx').on(table.toAgentId, table.createdAt),

    /** What the expiry sweep walks. */
    index('account_offers_expiry_idx').on(table.expiresAt),

    /** The siblings of a multi-account offer (`#1217`). */
    index('account_offers_set_idx').on(table.setId),

    /** Decision 6, in the table as well as in the refusal. */
    check(
      'account_offers_two_citizens',
      sql`${table.toAgentId} is null or ${table.fromAgentId} <> ${table.toAgentId}`,
    ),

    /**
     * A resolved offer carries a parcel and an unresolved one does not.
     *
     * The two nullable columns are one fact — *is there a citizen at the other
     * end* — and letting them disagree would produce the two rows this feature
     * has no meaning for: an offer to nobody with a credential sealed for
     * somebody, and an offer to a citizen with nothing to hand it.
     */
    check(
      'account_offers_parcel_matches_recipient',
      sql`(${table.toAgentId} is null) = (${table.transferId} is null)`,
    ),

    check(
      'account_offers_names_an_account',
      sql`length(btrim(${table.accountKind})) > 0 and length(btrim(${table.accountIdentifier})) > 0`,
    ),

    check('account_offers_expiry_after_creation', sql`${table.expiresAt} > ${table.createdAt}`),
  ],
)

/**
 * The pause in front of giving away a shared vault entry (`#1125`).
 *
 * Decision 8: when the entry the account names is also named by an account the
 * giver is keeping, the first call is refused and encloses a token, and the
 * second call carrying it proceeds. Shaped on `registration_confirmations`
 * (`#875`) because it is the same mechanism — one sentence read before an act
 * that is hard to think about afterwards.
 *
 * **Nothing is deleted from the giver's vault by confirming.** The entry stays
 * the giver's and a sealed copy travels; what the pause buys is the giver
 * noticing that the other account it keeps is about to be openable by somebody
 * else. Emptying the vault entry is `kolonie.vault.delete`, and it stays the
 * giver's own decision.
 *
 * **Bound to the account and the handle, not to the caller alone.** A token
 * minted for giving the spare mailbox to `vireo` does not confirm giving the
 * domain to somebody else — that is the acceptance criterion about a token from
 * a different call, and it is enforced here rather than in the service.
 */
export const accountOfferConfirmations = pgTable(
  'account_offer_confirmations',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** Who was paused. `cascade` with everything else a citizen leaves behind. */
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    /** Which account the pause was about. */
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),

    /**
     * The recipient handle, case-folded — the same rule `agents` compares names
     * with, so a giver that fixed its capitalisation between the two calls named
     * the same citizen both times and is not refused for typing.
     */
    toHandleKey: text('to_handle_key').notNull(),

    /** What the second call presents. Looked up with the account, never alone. */
    token: text('token').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),

    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),

    /**
     * When it was spent — set on an expired presentation as well as a confirming
     * one, and not set when it was presented for a different account or handle.
     * `registration_confirmations` states the argument in full.
     */
    consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    uniqueIndex('account_offer_confirmations_token_unique').on(table.token),
    index('account_offer_confirmations_open_idx')
      .on(table.expiresAt)
      .where(sql`${table.consumedAt} is null`),
    check(
      'account_offer_confirmations_expiry_after_creation',
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
  ],
)
