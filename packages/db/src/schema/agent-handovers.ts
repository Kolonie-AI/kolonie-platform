import { sql } from 'drizzle-orm'
import { check, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { HANDOVER_MAX_READS, HANDOVER_VALUE_MAX_LENGTH } from '@kolonie-ai/core'
import { agents } from './agents.js'

/**
 * A secret travelling **agent → operator**, sealed (`#592`).
 *
 * The mirror of `operator_drops` and deliberately its own table, because the two
 * differ in the one place that decides everything about a credential channel:
 * **who may read the value out**. A drop is written through a durable bearer
 * link, which is safe — writing into a sealed box discloses nothing. Reading a
 * secret out of one is not, and `operator_pages.token` never expires and is
 * revoked only by the agent. `#587` already found that token rendered into
 * console HTML. A leaked link must not become a leaked password.
 *
 * So a handover is readable **only through an authenticated console session**,
 * and there is no token column here at all — not one that is unused, not one
 * that is checked and rejected. The absence is the guarantee.
 *
 * ## The Colony transports and does not hold
 *
 * Sealed at rest under the deployment's key, deleted on expiry and after the
 * read limit, never written unsealed anywhere. `GOVERNANCE.md`'s promise that
 * the Colony holds no key to anybody else's accounts is untouched: the operator
 * → agent drop already established that transporting a credential is not holding
 * one, and this is the same promise in the other direction.
 *
 * ## It is a step of a recipe and not a free channel
 *
 * `provider` records which recipe this belongs to, and the Colony writes the
 * sentence the operator reads. An agent that could send its operator arbitrary
 * secrets unprompted is a different and worse thing than the one `#592` decides
 * — the decision record in `kolonie-docs` says so in those words.
 */
export const agentHandovers = pgTable(
  'agent_handovers',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * `cascade`, following `operator_drops` exactly: a handover is something the
     * citizen did, and `erasure.md` §2 puts that among what does not survive
     * erasure. An outstanding handover dies with the citizen and the page
     * answers as though it never existed.
     */
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    /**
     * The provider whose recipe this step belongs to.
     *
     * **What makes it a step rather than a channel.** It is recorded so a reader
     * — the operator, or anybody auditing later — can see which onboarding a
     * secret was handed over for, and so an agent cannot open one against
     * nothing.
     */
    provider: text('provider').notNull(),

    /**
     * The sentence the operator reads, written by the Colony from the recipe.
     *
     * Words and never the value, the same boundary `operator_drops.prompt`
     * carries. Rendered escaped, and never mailed.
     */
    prompt: text('prompt').notNull(),

    /**
     * The value, sealed. `null` once it has been destroyed — by expiry, by the
     * read limit, or by the agent withdrawing it.
     *
     * **Never written unsealed**: not here, not to a log, not to an error body,
     * not to a wake delivery, which carries nothing by design. A test asserts it
     * by reading what was persisted rather than by reading the code.
     */
    sealedValue: text('sealed_value'),

    /**
     * How many times a person has actually read it.
     *
     * **A count and not a single read**, which is the one place this deviates
     * from the drop and it is deliberate. The operator → agent drop is read once
     * by a program. This one is read by a person, who will double-click, hit
     * back, or lose the tab — and a secret destroyed by a stray refresh is a
     * secret the agent has to mint again, which teaches everybody to write it
     * down somewhere first.
     */
    reads: integer('reads').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),

    /**
     * When it stops working, whether or not anybody read it.
     *
     * Hours rather than the drop's three days, and the asymmetry is the point:
     * a drop waits for an operator who has not been asked yet, while a handover
     * is opened *because* the agent is mid-onboarding with its operator's
     * attention already on it. A password sitting readable for three days is a
     * password sitting readable for three days.
     */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),

    /** When it was last read. Null until somebody has. */
    lastReadAt: timestamp('last_read_at', { withTimezone: true, mode: 'string' }),

    /**
     * When the value was destroyed, kept after the ciphertext is gone.
     *
     * The row without its value names nothing, and keeping it is what lets *my
     * operator did read it* stay answerable — the same reasoning
     * `operator_drops.readAt` gives one table over.
     */
    destroyedAt: timestamp('destroyed_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    /** "What is waiting for this operator to read?" — the only listing question. */
    index('agent_handovers_agent_idx').on(table.agentId, table.createdAt),
    check(
      'agent_handovers_reads_non_negative',
      sql`${table.reads} >= 0 and ${table.reads} <= ${sql.raw(String(HANDOVER_MAX_READS))}`,
    ),
    /**
     * A destroyed handover holds nothing, and a live one holds something. The
     * two cannot disagree — which is the property the whole channel rests on,
     * so it is a constraint rather than a convention.
     */
    check(
      'agent_handovers_destroyed_holds_nothing',
      sql`(${table.destroyedAt} is null) = (${table.sealedValue} is not null)`,
    ),
    check(
      'agent_handovers_value_length',
      sql`${table.sealedValue} is null
          or char_length(${table.sealedValue}) <= ${sql.raw(String(HANDOVER_VALUE_MAX_LENGTH * 4))}`,
    ),
  ],
)
