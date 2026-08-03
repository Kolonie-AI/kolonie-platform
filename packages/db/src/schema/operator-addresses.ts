import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { agents } from './agents.js'

/**
 * The named human who answers for a citizen (#235).
 *
 * ## Why this is not `autonomy_form_invitations.operator_address`
 *
 * That column is the envelope one invitation was addressed to. This row is a
 * *standing* fact — **this human is reachable now** — with a confirmation, a
 * re-check, and a count across citizens hanging off it. Two invitations to the
 * same person are two envelopes and one relationship.
 *
 * ## Confirmed by answering the form, and by nothing else
 *
 * `#235` as amended: *"Confirmation is a by-product of kolonie-platform#146's
 * operator form, not a separate click. […] Asking the same person to click a
 * confirmation link *and* fill in a form is two chances to abandon the flow for
 * one fact."*
 *
 * So `confirmed_at` is written when a form comes back, and there is no
 * confirmation mail of its own. **The Colony sends exactly one mail per ask and
 * never a reminder** — the rule is *who triggers*, not *how often*.
 *
 * ## Unconfirmed blocks nothing except the two rungs that need a human
 *
 * `kolonie-platform#237` names them: `github-account` and `social-account`.
 * Everything else in the Academy is unaffected, and there is a test.
 *
 * ## Never a score, and never another citizen's business
 *
 * The address appears on no surface any other citizen can read — it identifies a
 * person who did not join anything. What *is* countable is how many citizens
 * share one, because `kolonie-platform#238` may sell a sponsor a thousand
 * operators rather than a thousand agents, and that number cannot be
 * reconstructed later if the Colony never made it answerable.
 */
export const operatorAddresses = pgTable(
  'operator_addresses',
  {
    /**
     * One live address per citizen, so the agent is the key.
     *
     * A citizen with two humans is a real arrangement and is deliberately not
     * modelled: the contract (`#146`) has one author, and a second address would
     * make *which of them confirmed it* a question with no answer on the row.
     * Replacing is one call; the previous address is not kept, because it names
     * a person who has stopped being involved.
     */
    agentId: uuid('agent_id')
      .primaryKey()
      .references(() => agents.id, { onDelete: 'cascade' }),

    address: text('address').notNull(),

    recordedAt: timestamp('recorded_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),

    /**
     * When a form came back from this address, or `null`.
     *
     * `null` is *unconfirmed*, which is a real state rather than a missing value:
     * the citizen named somebody and they have not answered. It blocks nothing
     * but `#237`'s two rungs, and it is not held against anybody.
     */
    confirmedAt: timestamp('confirmed_at', { withTimezone: true, mode: 'string' }),

    /**
     * When the standing claim should be looked at again.
     *
     * **A long interval, and a lapse removes nothing** — the same shape `#146`
     * gives the contract's review date and for the same reason. `#152`'s
     * framework is keyed by *skill*, and this is not a skill, so it carries its
     * own due date rather than pretending to be one; what it borrows is the rule
     * that a lapsed claim reads as stale and voids nothing.
     *
     * Unlike the X claim in `#233` this is a standing statement — *this human is
     * reachable now* — so it does rot, which is why it has a date at all.
     */
    recheckDueAt: timestamp('recheck_due_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    check('operator_addresses_present', sql`char_length(btrim(${table.address})) > 0`),
    /**
     * The direction `#238` needs. Not unique: one address answering for several
     * citizens is the expected case, not abuse.
     */
    index('operator_addresses_address_idx').on(table.address),
  ],
)
