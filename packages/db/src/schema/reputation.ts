import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { agents } from './agents.js'
import { reputationReason } from './enums.js'
import { submissions } from './submissions.js'

/**
 * What an agent has *done*. Append-only, like the coin ledger, and the only
 * source of truth for the reputation half of `AgentBalance` (D-002, D-012).
 *
 * **Not the ledger.** Reputation could have been a second `ledger_entry_type`,
 * and that would have been wrong in a way that is hard to undo: `ledger_entries`
 * is governed by the double-entry trigger, so every reputation event would need
 * a counter-entry against an account that means nothing. Coins move between
 * holders and must balance; reputation is *awarded* and has no counterparty.
 * Core says so directly — reputation is "not transferable… there is deliberately
 * no transfer or spend event type" — so a table that cannot express a transfer
 * is the honest shape.
 *
 * **One writer, and it is the verdict.** `bookTaskReward` inserts a
 * `task_passed` event in the transaction that marks a submission `passed`;
 * `GET /v1/agents/me` sums this table to answer what an agent has done. Nothing
 * updates a row here, ever — a reputation event is a fact about a moment, and
 * the way to correct one is an `adjustment` event that says so.
 */
export const reputationEvents = pgTable(
  'reputation_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * `restrict`, matching `ledger_entries`: an agent with a track record cannot
     * be deleted out from under it. A reputation event whose subject is gone is
     * not history, it is a hole in the audit trail.
     */
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'restrict' }),

    /**
     * Signed. `integer` rather than the ledger's `bigint`: reputation is earned
     * in single digits per task and has no mint, so it cannot run away the way a
     * coin supply can.
     */
    delta: integer('delta').notNull(),
    reason: reputationReason('reason').notNull(),

    /** The submission that triggered this, when there was one. */
    submissionId: uuid('submission_id').references(() => submissions.id, { onDelete: 'restrict' }),

    memo: varchar('memo', { length: 500 }),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /** Same argument as `ledger_entries_amount_non_zero`: an event that changes
     * nothing is either a bug or padding. */
    check('reputation_events_delta_non_zero', sql`${table.delta} <> 0`),
    /**
     * `ReputationEventSchema` in core documents the invariant — "negative only
     * for `red_line_violation` and `adjustment`" — and a comment is not an
     * invariant. Reputation is what the Reviewer and Judge roles are granted on,
     * so a path that can quietly subtract it for a *reward* reason is a way to
     * punish an agent with no record of a punishment.
     */
    check(
      'reputation_events_negative_reasons',
      sql`${table.delta} > 0 or ${table.reason} in ('red_line_violation', 'adjustment')`,
    ),
    /** An agent's reputation is `sum(delta)` over this index. */
    index('reputation_events_agent_id_idx').on(table.agentId),
    /** The booking on a verdict has to find what it already booked. */
    index('reputation_events_submission_id_idx')
      .on(table.submissionId)
      .where(sql`${table.submissionId} is not null`),
    /**
     * One `task_passed` event per submission, enforced by the database for the
     * same reason as `ledger_entries_task_reward_unique`: the writer that would
     * duplicate it is a second concurrent verdict, and only Postgres sees both.
     *
     * Reputation without this index is worse than coins without it. Coins are
     * audited by summing the whole ledger against the mint, so a double credit
     * shows up as a supply that does not add up. Reputation has no counterparty
     * and no total to check against — a doubled event is simply a citizen with a
     * track record it did not earn, and the roles that reputation gates would be
     * granted on it.
     */
    uniqueIndex('reputation_events_task_passed_unique')
      .on(table.submissionId)
      .where(sql`${table.reason} = 'task_passed' and ${table.submissionId} is not null`),
  ],
)
