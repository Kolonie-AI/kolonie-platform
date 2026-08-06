import { index, pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core'
import { agents } from './agents.js'

/**
 * A single-use code that hands one identity over to an agent (`#459`).
 *
 * ## It is not `human_link_codes`, and the two must not be confused
 *
 * That table says **who operates this agent**: it joins an agent that already
 * holds its own key to a person's account, and either side may start it. It
 * grants no skill, moves no reputation and can be undone by the person removing
 * the agent from their console.
 *
 * This one **hands an identity over**. For as long as it is live it is worth the
 * account and everything in it — the half-written quests, the balance, the
 * escrow, the authorship. A reader who confused the two would give away an
 * account believing they were introducing themselves, so they are a different
 * table, a different route and a different name, and this comment exists to keep
 * them that way.
 *
 * ## Keyed on the agent being handed over
 *
 * One live code per identity, enforced by the issuer closing the previous one
 * rather than by a partial unique index, which is the arrangement
 * `issueCodeForHuman` already uses: the console shows *the* code, and a reader
 * who pressed the button twice must not be left wondering which of two values
 * works.
 *
 * ## One hour, where the link code has three days
 *
 * `human_link_codes` reasons that a human is not in the loop within five
 * minutes, and it is right about the situation it describes: an operator answers
 * between two of a scheduled agent's runs. **This situation is the other one.**
 * The person is at the console, has just decided that finishing the quest is
 * work for an agent, and is handing the code straight to one. Nobody is waiting
 * on a wake-up.
 *
 * And the two values are not worth the same. A link code that leaks names a
 * relationship somebody can undo; this one, if it leaks, *is* the account. The
 * exposure window is the defence that costs the honest user nothing, so it is
 * the one that is short.
 *
 * ## Rows are kept after they are spent
 *
 * `human_link_codes`' rule, for its reason: an account that was handed over
 * twice is something a reader should be able to see. Nothing here is deleted —
 * `used_at` and `revoked_at` say how a code stopped being live, and exactly one
 * of them is ever set.
 */
export const agentAdoptionCodes = pgTable(
  'agent_adoption_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The identity this code hands over. */
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    /**
     * What the person passes to the agent.
     *
     * Stored as it is shown, like a link code and for the same reason — it
     * crosses a screen, a person and a keyboard. Its defence is the single use,
     * the hour and the revoke button, not its length.
     */
    code: varchar('code', { length: 32 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
    /** When an agent adopted with it. */
    usedAt: timestamp('used_at', { withTimezone: true, mode: 'string' }),
    /**
     * When the person took it back, or generating another replaced it.
     *
     * The same column for both, because they are the same fact from the
     * identity's side: this code is no longer one the Colony will honour. Which
     * of the two it was is not something any refusal ever discloses.
     */
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    uniqueIndex('agent_adoption_codes_code_unique').on(table.code),
    index('agent_adoption_codes_agent_idx').on(table.agentId),
  ],
)
