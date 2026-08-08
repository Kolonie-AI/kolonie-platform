import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { ACCOUNT_PROVIDER_MAX_LENGTH, WISH_NOTE_MAX_LENGTH } from '@kolonie-ai/core'
import { agents } from './agents.js'
import { operatorRequestAuthor } from './enums.js'

const noteMax = sql.raw(String(WISH_NOTE_MAX_LENGTH))
const providerMax = sql.raw(String(ACCOUNT_PROVIDER_MAX_LENGTH))

/**
 * The one list an agent and its operator both write to (#527).
 *
 * ## Why this is its own table and not a column on `accounts`
 *
 * `accounts` is the register of what a citizen **holds**. This is what it does
 * not hold and thinks it should, which is a different question with a different
 * lifetime — an entry here is answered by a row appearing there, and the two
 * would fight over `status` if they shared one.
 *
 * ## Why the author is `operator_request_author`
 *
 * The same two parties, and the same distinction that enum was made for. A
 * `wish_author` enum with identical members would be a second vocabulary for one
 * question, and the first surface that had to translate between them would get
 * it wrong. The enum's *name* is about requests and its *members* are about who
 * is speaking — this reuses the second.
 *
 * ## One row per provider per agent
 *
 * A citizen and its operator can want the same thing, and the list should say so
 * once. Whoever writes second finds the row already there; nothing is duplicated
 * and nothing is overwritten, which is what {@link accountWishes.author} being a
 * record of *who first noticed* rather than *whose item this is* means.
 *
 * ## Nothing here is a secret
 *
 * Both free boxes on the operator channels refuse credentials outright, and that
 * refusal is what keeps `operator_drops` meaning *a secret*. This is a third
 * free box on the same trust boundary and it holds to the same rule — enforced
 * at the API layer by the same `credentialFinding` guard, with a test.
 */
export const accountWishes = pgTable(
  'account_wishes',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** `cascade`. A wish is a fact about one citizen's plan and nobody else's. */
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    /** Who runs it, in the form the Atlas prints — `trello.com`. */
    provider: text('provider').notNull(),

    /** Which side first put it on the list. */
    author: operatorRequestAuthor('author').notNull(),

    /**
     * What the agent was doing when it found the need, in its own words.
     *
     * Null on an operator's entry, where there is nothing to have noticed. This
     * is the half an operator cannot supply and the reason `#527` calls the
     * agent's entry the more valuable one.
     */
    noticedWhile: text('noticed_while'),

    /**
     * When the operator said yes, or null.
     *
     * **The one column that turns a wish into something that may be acted on.**
     * A recipe may not ask this operator for anything on account of an entry
     * that is still null: the operator decides what is attempted and the agent
     * does the work.
     *
     * Written by the operator and by nothing else. There is deliberately no
     * *unwanted* value beside it — an operator that changes its mind removes the
     * row, and a third state would be a thing every reader has to handle for a
     * case a delete already covers.
     */
    wantedAt: timestamp('wanted_at', { withTimezone: true, mode: 'string' }),

    addedAt: timestamp('added_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('account_wishes_agent_provider_unique').on(table.agentId, table.provider),
    index('account_wishes_agent_idx').on(table.agentId, table.addedAt),
    check(
      'account_wishes_provider_length',
      sql`length(${table.provider}) between 1 and ${providerMax}`,
    ),
    check(
      'account_wishes_note_length',
      sql`${table.noticedWhile} is null or length(${table.noticedWhile}) between 1 and ${noteMax}`,
    ),
    /**
     * An operator's entry has nothing it was doing.
     *
     * A constraint rather than a convention, because the column's whole value is
     * that it means *the agent noticed this while working* — a row where an
     * operator had written into it would make every count over the column wrong
     * and would look identical to a legitimate one.
     */
    check(
      'account_wishes_only_a_citizen_noticed',
      sql`${table.author} = 'citizen' or ${table.noticedWhile} is null`,
    ),
  ],
)
