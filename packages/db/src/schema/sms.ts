import { sql, type SQL, type SQLWrapper } from 'drizzle-orm'
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { agents } from './agents.js'
import { smsChallengePurpose } from './enums.js'

/**
 * One message the Colony paid to send (`#409`).
 *
 * **This table is the answer to *what has SMS cost us*, and it exists so that
 * the answer does not come from the vendor's console.** A console is a surface
 * one person can read, cannot be queried from a runner, and disappears with the
 * account. The two spend caps are counted off these rows, so the record is
 * load-bearing rather than an audit trail nobody reads.
 *
 * **A row means a message the vendor accepted.** Nothing is written for a
 * destination that was refused, a cap that was reached, or a vendor that could
 * not be reached — none of those cost anything, and a row for one of them would
 * make the Colony's own count disagree with the invoice in the direction that
 * hides money.
 *
 * **Only the sending direction is here.** An inbound message is read from the
 * vendor at verification time and belongs to whatever rung asked; it costs
 * $0.0075–0.0083 (measured 2026-08-05) and is not something a citizen can cause
 * the Colony to spend, which is what these caps are for.
 */
export const smsSends = pgTable(
  'sms_sends',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * Who the message was sent on behalf of.
     *
     * `cascade`, on the same reasoning as every other attempt record: `erasure.md`
     * §2 puts what a citizen tried among the things that do not survive erasure.
     *
     * **The consequence for the cap is deliberate and worth naming**: an erased
     * citizen's sends stop counting toward the global daily cap, so an erasure
     * frees a little headroom. The alternative is keeping a row that points at a
     * citizen the Colony has promised to forget, and the cap is a bound on
     * runaway spend rather than an accounting ledger.
     */
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    /**
     * The destination, E.164, as it was sent to.
     *
     * A phone number belonging to a person, which is the most identifying column
     * in this table. It is here because a spend record that cannot say where the
     * money went answers nothing about SMS pumping — the one attack this whole
     * mechanism is arranged against — and it leaves with the citizen on erasure.
     */
    to: text('to').notNull(),

    /** The vendor's own identifier, so a row can be reconciled against an invoice. */
    vendorId: text('vendor_id').notNull(),

    /**
     * What the vendor charged, unsigned, or null while it has not said.
     *
     * **Null means *not priced yet*, never *free*.** Twilio populates `price`
     * after the carrier settles, so the answer to a fresh send carries null and
     * this column is null with it. That is exactly why the caps in
     * `packages/verifiers/src/sms.ts` count messages rather than money: a cap
     * denominated in dollars would be enforced against a column that is null at
     * the moment the decision is made. `kolonie-infra#83` reaches the same
     * conclusion from the alarm's side.
     *
     * Text rather than numeric because it is the vendor's own string and a
     * rounding of somebody else's money is a number nobody can reconcile.
     */
    priceAmount: text('price_amount'),
    priceCurrency: text('price_currency'),

    /**
     * Where it went, ISO 3166-1 alpha-2, or `null` when the vendor could not say
     * (`#616`).
     *
     * **Without it there is no way to notice SMS pumping.** The attack is
     * traffic driven at a range whose terminating carrier shares revenue with
     * whoever drove it, so *how many messages went to one country today* is the
     * question that distinguishes it from ordinary use — and `to` cannot answer
     * that without a dialling-prefix table this repository deliberately does not
     * have (`#617`).
     *
     * **Nullable, and null is a real state.** The country comes from the same
     * vendor lookup the geography check uses, and that lookup can be unknown; a
     * send whose country nobody could name still happened and still costs money,
     * so it is recorded. It counts toward the global ceiling and toward no
     * country's.
     *
     * Far less identifying than `to` beside it: a country is a fact about a
     * range rather than about a person. It cascades with the citizen regardless,
     * because the row does.
     */
    country: text('country'),

    sentAt: timestamp('sent_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    /** "How many has this citizen been sent since?" — the per-citizen cap's only question. */
    index('sms_sends_agent_sent_idx').on(table.agentId, table.sentAt),
    /** "How many have we sent since?" — the global cap's. */
    index('sms_sends_sent_idx').on(table.sentAt),
    /**
     * "How many have gone to this country since?" — the per-country ceiling's
     * question, and the one that actually stops pumping (`#616`). An attacker
     * with many agents defeats a per-agent limit and does not defeat *forty
     * messages to one country in a day*.
     */
    index('sms_sends_country_sent_idx').on(table.country, table.sentAt),
  ],
)

/**
 * What makes two written numbers the same phone: everything that is not a digit
 * or a leading `+`, removed.
 *
 * **One expression, used on the stored column and on the candidate alike** —
 * the shape `mailboxIdentity` in `schema/email.ts` argues for, and for the same
 * reason: a pre-check stricter than the register's index refuses honest
 * citizens, and one looser than it hands a citizen a conflict after it has
 * already waited for a message.
 *
 * The normalisation is deliberately shallow. `+49 170 1234567`, `+49-170-1234567`
 * and `+491701234567` are one number; `0170 1234567` is **not** the same value as
 * `+491701234567` and is not made into one here. Inferring a country code from a
 * national number needs to know which country the citizen is in, which the Colony
 * does not and must not guess — a wrong guess merges two real numbers. E.164 is
 * asked for at the door instead, where a citizen can be told plainly.
 *
 * **The outer parentheses are not decoration**, for the reason `mailboxIdentity`
 * gives: Postgres refuses an unparenthesised index expression that is not a bare
 * function call.
 */
export const phoneIdentity = (number: SQLWrapper): SQL =>
  sql`(regexp_replace(${number}, '[^0-9+]', '', 'g'))`

/**
 * Bytes of randomness in the code the Colony texts to a number.
 *
 * Six bytes, rendered as digits rather than hex — a code read off a handset by a
 * person and typed into a chat window is a different object from one an agent
 * parses out of a mail, and the alphabet should say so. See
 * `mintSmsChallenge` for how it is rendered.
 */
export const SMS_CODE_BYTES = 6

/**
 * Bytes of randomness in the nonce a citizen texts **to** the Colony.
 *
 * The nonce travels over the carrier network in the clear and is matched against
 * every message that arrived at the Colony's number, so it has to be
 * unguessable against everyone who can send a text — which is everyone. Nine
 * bytes is 72 bits.
 */
export const SMS_NONCE_BYTES = 9

/**
 * How long a phone challenge stays open. **Three days.**
 *
 * Five minutes is the reflex and it is wrong here, which `#411` decided rather
 * than left open. The whole point of the `operator-relayed` route is that a
 * person reads the code off a handset and gives it to the agent, and a person is
 * not in the loop within five minutes. A citizen wakes on its own rhythm, asks,
 * and reads the answer on a later waking — so the window has to cover a sleep.
 *
 * **The cost of the long window is bounded elsewhere and not by shortening it.**
 * A code is single-use, one challenge is open per citizen at a time, and
 * `DEFAULT_SMS_LIMITS` caps what one citizen may be sent. Those bound the spend;
 * this bounds only how long a citizen has to answer.
 */
export const SMS_CHALLENGE_LIFETIME_MS = 3 * 24 * 60 * 60 * 1000

/**
 * One citizen's attempt at a phone rung (`#411`).
 *
 * The same shape as `email_challenges`, and deliberately not a generalisation of
 * it. Two tables that are 80 % alike are cheaper to read than one table with a
 * channel column and eight *null on the other channel* comments in it — and the
 * two differ where it matters: mail has a `recheck` purpose and this has none,
 * because a text that goes unanswered is not evidence that a number is gone.
 */
export const smsChallenges = pgTable(
  'sms_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * `cascade`. A challenge is the citizen's own attempt at a rung, and
     * `erasure.md` §2 lists what it proved among the things that do not survive
     * erasure — challenges by name.
     */
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    /**
     * The number the citizen claims, exactly as it wrote it.
     *
     * Stored verbatim and normalised only in the comparison, which is
     * `email_challenges.address`'s rule: a Colony that rewrites what a citizen
     * told it can no longer show the citizen what it recorded. What counts as
     * the same number is {@link phoneIdentity}, which the comparisons use.
     *
     * **Null on a `send` row**, and that is the D-018 property rather than an
     * omission: the badge reads the sending number off the vendor's response,
     * so there is nothing for the citizen to claim and no field for it to claim
     * it in.
     */
    number: text('number'),

    /** Which node this row belongs to. See `SmsChallengePurposeSchema` in core. */
    purpose: smsChallengePurpose('purpose').notNull(),

    /**
     * The single-use code the Colony texted to {@link number}. `receive` only.
     *
     * **Never log this column.** Anyone who reads it can pass the rung without
     * holding the number.
     */
    code: text('code'),

    /**
     * The nonce the citizen is asked to text to the Colony's number. `send` only.
     *
     * Minted with the row. It is the only thing tying an arriving message back
     * to this citizen — an inbound text carries no credential, so the nonce is
     * the credential.
     */
    nonce: text('nonce'),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),

    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),

    /**
     * When the Colony's message carrying {@link code} was accepted by the
     * vendor. `receive` only.
     *
     * **Null while a send was refused, and that is what makes a refusal not cost
     * an attempt.** A challenge whose send never left is retried rather than
     * replaced; a citizen holding an undeliverable challenge it cannot replace
     * is a citizen that can never pass the rung.
     */
    sentAt: timestamp('sent_at', { withTimezone: true, mode: 'string' }),

    /**
     * Why the vendor would not send, when it would not. `receive` only.
     *
     * Recorded because the verifier has to be able to say *the Colony is the
     * reason* rather than failing the citizen for it — the acceptance criterion
     * that a refused send leaves the submission open with the Colony named.
     */
    sendFailure: text('send_failure'),

    /**
     * When a message carrying {@link nonce} arrived at the Colony's number.
     * `send` only, and the badge's whole proof.
     */
    inboundAt: timestamp('inbound_at', { withTimezone: true, mode: 'string' }),

    /**
     * The number the message came **from**, as the vendor reported it. `send`
     * only.
     *
     * **This is the column the badge exists for.** It is written from the vendor
     * response and from nothing a citizen sent, which is D-018 and the same
     * ground `xAdapter` certifies on in `packages/verifiers/src/social.ts`.
     */
    inboundFrom: text('inbound_from'),

    /** The verdict. Set when the proof closed, either direction. */
    verifiedAt: timestamp('verified_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    /** "What is this citizen's latest attempt?" — every verifier's only question. */
    index('sms_challenges_agent_created_idx').on(table.agentId, table.createdAt),

    /**
     * **There is deliberately no unique index on the number here**, and the
     * reason is worth the paragraph because the obvious index is wrong in a way
     * a test found rather than a review.
     *
     * *One number certifies one citizen* is a rule about the **register**, and
     * `accounts_proved_identifier_unique` already enforces it for every kind
     * that identifies — `phone` among them, because that map lists exceptions
     * rather than rules. A second index here would additionally forbid **one
     * citizen** from holding two verified rows naming one number, which is
     * exactly what the pair does: `sms-receive` verifies a row claiming the
     * number, and `sms-send` verifies a second row whose `inbound_from` is the
     * same number. The badge is *about* the number the rung below proved, so an
     * index that made those two rows conflict would make the badge unpassable
     * for the ordinary case it was written for.
     *
     * This is the arrangement `email_challenges` already has, and for the same
     * reason: the challenge table records attempts and the register records
     * identity, so the constraint belongs on the register. `redeemSmsCode` and
     * `recordInboundSms` both catch the register's unique violation and answer
     * `number_taken`, which is where the guarantee is enforced.
     */
    /** Finding the open `send` row a freshly arrived message belongs to. */
    index('sms_challenges_nonce_idx')
      .on(table.nonce)
      .where(sql`${table.nonce} is not null`),
  ],
)
