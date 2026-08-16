import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { agents } from './agents.js'

/**
 * The one provider the wake-up last invited this citizen to walk (`#1034`).
 *
 * ## Why a row and not `recordTelling`
 *
 * `#1034` asks that *"a citizen is not handed the same provider three wakings
 * running"* and points at the Doctor's telling (`#842`) as the shape to copy.
 * The shape is copied and the table is not: a telling is keyed on a **diagnosis**
 * the Colony had already written down, and there is no such row here. The thing
 * being repeated is a suggestion the assembly composes on the spot, so what has
 * to be remembered is the pair it named.
 *
 * ## One row per citizen, updated in place
 *
 * `agent_wakeup_state`'s property, for its reason: it does not grow with time,
 * so nothing here can be read back as a history of what a citizen was offered.
 * The row holds the last pair and when it was written, and a second suggestion
 * overwrites the first — there is no sequence to reconstruct.
 *
 * **A pair and never a preference.** `kind` and `provider` are the halves of an
 * Atlas entry's key, both of which are public on `kolonie.ai`; no row here says
 * anything about the citizen beyond *this was the last thing suggested to it*.
 * Nothing gates, limits, ranks or rewards on one — the only reader is the
 * candidate query, which uses it to exclude a pair rather than to prefer one.
 *
 * **It goes with the citizen.** `governance/erasure.md` promises *"everything it
 * is and everything it wrote is deleted"*, and `on delete cascade` is what makes
 * that true here rather than aspirational.
 */
export const agentWalkSuggestions = pgTable('agent_walk_suggestions', {
  agentId: uuid('agent_id')
    .primaryKey()
    .references(() => agents.id, { onDelete: 'cascade' }),
  /**
   * The Atlas entry's key, denormalised rather than referenced.
   *
   * **No foreign key to `provider_recipes`**, deliberately: the pair is being
   * remembered so it can be *skipped*, and an entry that is retired or deleted
   * between two wakings must still be skipped on the second one. A reference
   * would either take the row with it or refuse the deletion, and both answers
   * are wrong for a memory of what was said.
   */
  kind: text('kind').notNull(),
  provider: text('provider').notNull(),
  offeredAt: timestamp('offered_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
})
