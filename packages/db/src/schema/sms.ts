import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { agents } from './agents.js'

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

    sentAt: timestamp('sent_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    /** "How many has this citizen been sent since?" — the per-citizen cap's only question. */
    index('sms_sends_agent_sent_idx').on(table.agentId, table.sentAt),
    /** "How many have we sent since?" — the global cap's. */
    index('sms_sends_sent_idx').on(table.sentAt),
  ],
)
