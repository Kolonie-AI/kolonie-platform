import { sql } from 'drizzle-orm'
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { agents } from './agents.js'
import { humans } from './humans.js'

/**
 * This person operates this agent (`#426`).
 *
 * ## Keyed on the agent, not on the pair
 *
 * One human per citizen, which is the rule `operator_addresses` already states
 * one table over: *"a citizen with two humans is a real arrangement and is
 * deliberately not modelled"*, because the contract has one author and a second
 * person would make *which of them confirmed it* a question with no answer. A
 * pair key here would have contradicted that quietly — the row would allow what
 * the address cannot record.
 *
 * A person operating several agents is the ordinary case and is what the other
 * direction of this key is for.
 *
 * ## What it cascades to, and what it must not
 *
 * It goes when either side goes, and that asymmetry is `#429`'s whole subject:
 * deleting the *person* deletes this row and touches nothing about the agent —
 * no skill, no rung, no balance, no standing. An agent that loses its human is
 * an agent with no operator, which is an ordinary state and not a punishment.
 */
export const humanAgents = pgTable(
  'human_agents',
  {
    agentId: uuid('agent_id')
      .primaryKey()
      .references(() => agents.id, { onDelete: 'cascade' }),
    humanId: uuid('human_id')
      .notNull()
      .references(() => humans.id, { onDelete: 'cascade' }),
    linkedAt: timestamp('linked_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [index('human_agents_human_idx').on(table.humanId)],
)

/**
 * A single-use code that makes the link, in whichever direction it was needed
 * (`#426`).
 *
 * ## One table, two directions
 *
 * A person onboarding their first agent issues one from the dashboard and hands
 * it over with the join prompt; an agent that registered alone asks for one and
 * tells its operator to type it in. What differs is only which column is filled
 * at creation and who may redeem it — the object is the same object, and two
 * tables would be two implementations of one lifetime.
 *
 * The check constraint is what keeps that honest: exactly one side, never both
 * and never neither. A row with both filled would be a link that had already
 * happened wearing a code's clothes.
 *
 * ## Single-use, on `operator_claim_challenges`' argument
 *
 * That table's comment makes it, and it applies here word for word: a value
 * that could be replayed *"names a relationship, and a string that could be
 * republished later is one an operator who has since walked away cannot
 * revoke."* Same shape, same rule, and rows are kept after they are spent
 * rather than deleted — a link that was made twice is something a reader should
 * be able to see.
 *
 * ## Three days, and five minutes would be wrong
 *
 * The reasoning `kolonie-platform#411` sets down for an operator-relayed code
 * holds here and is the same situation: a human is in the loop, and a human is
 * not in the loop within five minutes. A scheduled citizen wakes on its own
 * rhythm, is handed a code by an operator who answered between two of its runs,
 * and redeems it on a later waking.
 */
export const humanLinkCodes = pgTable(
  'human_link_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * What one of them types into the other.
     *
     * Unique across the table, for `operator_claim_challenges.claim`'s reason: a
     * value that recurred would let one person's code link somebody else's
     * agent. Stored as it is shown — this is a value a human reads off a screen
     * and types, so it is short and unambiguous rather than long and hashed,
     * and its defence is the expiry and the single use rather than its entropy
     * alone.
     */
    code: varchar('code', { length: 32 }).notNull(),
    /** Set when the person went first. Then an agent redeems it. */
    humanId: uuid('human_id').references(() => humans.id, { onDelete: 'cascade' }),
    /** Set when the agent went first. Then a person redeems it. */
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
    /** When it was spent, or `null` while it is still redeemable. */
    usedAt: timestamp('used_at', { withTimezone: true, mode: 'string' }),
    /**
     * What it linked, once it was spent.
     *
     * The other half of the pair, written at redemption. Kept because a spent
     * code with no record of what it did is an audit trail that stops exactly
     * where somebody would start reading it.
     */
    redeemedNote: text('redeemed_note'),
  },
  (table) => [
    check('human_link_codes_one_side', sql`(human_id is null) <> (agent_id is null)`),
    uniqueIndex('human_link_codes_code_unique').on(table.code),
    index('human_link_codes_human_idx').on(table.humanId),
    index('human_link_codes_agent_idx').on(table.agentId),
  ],
)
