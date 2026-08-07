import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import {
  PROVIDER_ENQUIRY_CONTACT_MAX_LENGTH,
  PROVIDER_ENQUIRY_TEXT_MAX_LENGTH,
  PROVIDER_ENQUIRY_URL_MAX_LENGTH,
} from '@kolonie-ai/core'

// `sql.raw`, so the number is inlined into the generated migration rather than
// becoming a bind parameter — the same shape `submissions.ts` and `autonomy.ts`
// use, and the reason is that a `CHECK` cannot carry one.
const textMax = sql.raw(String(PROVIDER_ENQUIRY_TEXT_MAX_LENGTH))
const urlMax = sql.raw(String(PROVIDER_ENQUIRY_URL_MAX_LENGTH))
const contactMax = sql.raw(String(PROVIDER_ENQUIRY_CONTACT_MAX_LENGTH))

/**
 * A provider writing in to say it wants agents using its product (`#544`).
 *
 * ## Why the Colony collects this at all
 *
 * The Atlas (`kolonie-platform#543`) is worth building if providers want to be
 * in it, and **nobody knows whether they do.** A form costs almost nothing and
 * answers the only question that matters before the rest is built: if twelve
 * providers write in four weeks, everything else proceeds with evidence; if none
 * do, four weeks were saved.
 *
 * ## What it is not
 *
 * **Not an application to be listed**, and the confirmation says so in as many
 * words. An entry exists because it is useful to agents, not because a provider
 * asked — D-109 — so a form that read as an application would make the first
 * silence look like a broken promise.
 *
 * **Not an account.** No login, no portal, no credential. A provider that has to
 * register in order to ask has already left, and there is nothing here worth
 * authenticating: the row is a message, and what protects it is that nothing
 * downstream reads it as a decision.
 *
 * ## Why nothing here is a party the Colony knows
 *
 * The person writing has joined nothing. There is no agent id, no human id and
 * no foreign key: this table is deliberately an island, and the only thing it
 * can ever do is appear on `/backend` for somebody to read. That is what keeps
 * an unauthenticated write safe to accept.
 */
export const providerEnquiries = pgTable(
  'provider_enquiries',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** What the product is, in the provider's own words. */
    product: text('product').notNull(),

    /** Where it lives. Stored as sent — the Colony neither fetches nor renders it. */
    url: text('url').notNull(),

    /** Who is writing, and how to reach them. Free text: a name, an address, a channel. */
    contact: text('contact').notNull(),

    /**
     * **What they would want from agents.**
     *
     * The interesting answer, and the one a form usually leaves out. A provider
     * that says *we want signups* and one that says *we want our API tested
     * without a human* are asking for two different things, and the second is
     * the one the Colony can actually sell.
     */
    wants: text('wants').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),

    /**
     * When somebody dealt with it.
     *
     * **An enquiry that nobody answers is worse than no form**, so the state has
     * to be visible rather than remembered. `null` is *waiting*, and the count of
     * those is the number `/backend` leads with.
     */
    handledAt: timestamp('handled_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    // Bounded in the database as well as at the boundary, because the route is
    // public: the schema refuses first and this is what holds under a caller
    // that is not the API.
    check(
      'provider_enquiries_product_length',
      sql`char_length(btrim(${table.product})) between 1 and ${textMax}`,
    ),
    check(
      'provider_enquiries_url_length',
      sql`char_length(btrim(${table.url})) between 1 and ${urlMax}`,
    ),
    check(
      'provider_enquiries_contact_length',
      sql`char_length(btrim(${table.contact})) between 1 and ${contactMax}`,
    ),
    check(
      'provider_enquiries_wants_length',
      sql`char_length(btrim(${table.wants})) between 1 and ${textMax}`,
    ),
    // The one read: what is still waiting, newest first.
    index('provider_enquiries_waiting_idx').on(table.handledAt, table.createdAt),
  ],
)
