import { sql } from 'drizzle-orm'
import {
  bigint,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { agents } from './agents.js'
import { operatorRequests } from './operator-requests.js'

/**
 * The Telegram chat an operator answers for one citizen in (`#793`).
 *
 * ## Why a `chat_id` and never a handle
 *
 * **A Telegram bot cannot start a conversation and cannot turn an `@handle` into
 * an address.** No Bot API method resolves a username to a messageable user, and
 * a bot may only write to a chat that already exists. A column holding what an
 * operator typed would therefore be a column that cannot be used — and would look
 * like it worked until the first message.
 *
 * What is messageable is this number, and the only way to obtain it is for the
 * person to open the conversation themselves. That is what
 * {@link operatorTelegramStarts} is for.
 *
 * ## The binding is per citizen, and that is a decision rather than a shortcut
 *
 * The Colony has no record of an operator *as a person*: `operator_addresses` is
 * keyed by `agent_id` and its own comment says a citizen with two humans is
 * deliberately not modelled. The mail address is the only thing that groups
 * citizens under one human, and treating an address as an identity has
 * consequences — a shared address, a changed address — that `#793` deliberately
 * did not take. **So an operator of twelve citizens presses start twelve times,
 * and binding once for several is a later issue rather than an oversight.**
 *
 * ## `bound_at` is a fact and never a score
 *
 * Same rule `operator_pages.last_opened_at` carries: nothing may rank, order,
 * compare or gate on it. An operator who prefers mail has chosen a channel, not
 * failed one.
 */
export const operatorTelegramChats = pgTable(
  'operator_telegram_chats',
  {
    /**
     * One live chat per citizen, so the agent is the key — the shape
     * `operator_addresses` already has, for the same reason: the contract has one
     * author, and a second chat would make *which of them the Colony writes to* a
     * question with no answer on the row.
     */
    agentId: uuid('agent_id')
      .primaryKey()
      .references(() => agents.id, { onDelete: 'cascade' }),

    /**
     * The private chat between the bot and the operator.
     *
     * `bigint` and not `text`: Telegram sends a JSON number and documents it as
     * fitting in at most 52 significant bits, which is exactly what a double
     * holds — so `mode: 'number'` is safe *because* of that guarantee rather than
     * by luck. A negative value is a group or channel and is refused before it
     * reaches this table; the check below is what makes that structural.
     */
    chatId: bigint('chat_id', { mode: 'number' }).notNull(),

    boundAt: timestamp('bound_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),

    /**
     * When the Colony last found this chat unwritable, or `null`.
     *
     * **Written by `#794` and created here**, so that the two issues do not race
     * on a migration of the same table. A blocked bot, a deleted account and a
     * chat the person cleared all answer `403` to a send, and none of them is
     * something the operator will come back to tell us about — so the fallback to
     * mail has to be decidable from a column rather than from a live probe.
     *
     * Set rather than deleted: *this person bound Telegram and it stopped
     * working* and *this person never bound Telegram* are different facts, and
     * only one of them is worth offering the link again for.
     */
    unreachableAt: timestamp('unreachable_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    /**
     * A private chat's id is the user's own id and is positive. A group is
     * negative, and `#793` refuses a `/start` from one — `can_join_groups` is
     * also off at BotFather, and this check is why the code does not have to rely
     * on that having happened.
     */
    check('operator_telegram_chats_private', sql`${table.chatId} > 0`),

    /**
     * Not unique. One person operating five citizens binds the same chat five
     * times, which is the expected case rather than abuse — the same direction
     * `operator_addresses_address_idx` exists for, and what a later
     * bind-once-for-several issue would read.
     */
    index('operator_telegram_chats_chat_idx').on(table.chatId),
  ],
)

/**
 * One unredeemed deep link, waiting for somebody to press it (`#793`).
 *
 * ## Why this is not the durable page token
 *
 * The page token is a bearer credential that can write into an exchange (`#146`,
 * D-081). **A start payload ends up in a chat history on somebody else's
 * servers**, in a message the person did not choose the wording of, and Telegram
 * keeps it there. So it is a token of its own: single use, short-lived, bound to
 * one citizen, and worth nothing after redemption.
 *
 * What it buys whoever holds it is also deliberately small — the ability to bind
 * *their own* Telegram chat to one citizen, which the operator sees on the
 * durable page and can end with `/stop`. It reads nothing.
 */
export const operatorTelegramStarts = pgTable(
  'operator_telegram_starts',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** `cascade`, on the rule every operator-facing row here follows. */
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    /**
     * SHA-256 of the payload, hex. The payload itself is never stored.
     *
     * The same shape `credentials` and `operator_drops` use, for the same reason:
     * a lookup needs to recognise a token and does not need to be able to produce
     * one. A database dump therefore does not hand anybody a live deep link.
     */
    tokenHash: text('token_hash').notNull(),

    issuedAt: timestamp('issued_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),

    /** 24 hours after issue, which is Telegram's own recommendation for this flow. */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),

    /**
     * When it was spent, or `null` while it is live.
     *
     * Kept rather than deleted, so a second press of the same link can be
     * answered with *this one has been used* instead of with silence. A person
     * who pressed twice is not doing anything wrong and should be told which of
     * the two states they are in.
     */
    redeemedAt: timestamp('redeemed_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    uniqueIndex('operator_telegram_starts_token_idx').on(table.tokenHash),

    /**
     * One live link per citizen. A partial unique index, so a spent one piles up
     * behind the live one and re-offering is an insert rather than a
     * resurrection — a re-offered link is a *new* payload, which is the whole
     * point of the old one being single-use.
     */
    uniqueIndex('operator_telegram_starts_live_idx')
      .on(table.agentId)
      .where(sql`${table.redeemedAt} is null`),
  ],
)

/**
 * Which Telegram message the Colony sent about which exchange (`#795`).
 *
 * ## Why this exists at all, and why recency is not an answer
 *
 * A reply arrives as a message with a `reply_to_message`. Resolving *which
 * exchange it answers* from that is exact; resolving it from *the operator's most
 * recent open request* is a guess, and it is wrong in the case this feature is
 * for — **an operator answering four citizens in one evening**. That is not a
 * rare case for the people who operate several, and a rule that breaks on them
 * breaks on the users it was built for.
 *
 * So the Colony records the message it sent and looks the reply up by it.
 *
 * ## One row per ask
 *
 * `request_id` is the key, because the rule one layer up is *exactly one message
 * per ask and never a reminder*. A second row would mean the Colony had sent
 * twice, which is the thing that rule forbids — so the schema cannot hold that
 * state rather than the code remembering not to create it.
 *
 * Rows exist only for asks that went out over Telegram. A mailed ask has none,
 * and that is what it means for a reply to resolve to nothing.
 */
export const operatorTelegramAsks = pgTable(
  'operator_telegram_asks',
  {
    /** `cascade`. The mapping describes an exchange and means nothing without one. */
    requestId: uuid('request_id')
      .primaryKey()
      .references(() => operatorRequests.id, { onDelete: 'cascade' }),

    /** The chat it was sent to, which is not necessarily still bound when a reply arrives. */
    chatId: bigint('chat_id', { mode: 'number' }).notNull(),

    /** Telegram's own id for the message the bot sent. */
    messageId: bigint('message_id', { mode: 'number' }).notNull(),

    sentAt: timestamp('sent_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * How a reply is resolved, and unique because Telegram's message ids are per
     * chat. Unique rather than a plain index deliberately: two rows answering
     * *which exchange is this* would put the choice back where `reply_to_message`
     * was supposed to take it from.
     */
    uniqueIndex('operator_telegram_asks_message_idx').on(table.chatId, table.messageId),
  ],
)
