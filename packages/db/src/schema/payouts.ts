import { sql } from 'drizzle-orm'
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { agents } from './agents.js'
import { submissions } from './submissions.js'
import { tasks } from './tasks.js'

/**
 * What the Colony owes a citizen for an accepted report, and whether it has
 * paid — D-106 (`#505`).
 *
 * **A row exists because a report was accepted, not because a payment
 * failed.** Every accepted report on a quest priced in SOL writes one, in the
 * verdict's own transaction, and the ordinary life of a row is *written and
 * settled seconds later*. That is deliberate: a report accepted and not paid
 * has to be a debt the Colony can **find**, and a table that only recorded
 * failures would be a table nobody looks at until somebody complains.
 *
 * **Nothing here is a balance the citizen holds.** It is an amount owed for a
 * specific report, payable to that citizen's own wallet and to nowhere else. It
 * cannot be spent, transferred or converted, and there is no path that turns one
 * of these into another citizen's row — which is the property that keeps the
 * Colony out of the custodial half of D-106 while an accrual waits for the chain
 * minimum.
 */
export const payoutObligations = pgTable(
  'payout_obligations',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * Who is owed, while anybody is.
     *
     * **`set null`, with a check that an *outstanding* row always names its
     * citizen.** The two together are what make an erasure unable to quietly
     * drop a debt: a settled row loses the name and stays as the Colony's own
     * record of what it paid, and an unsettled one cannot lose it — the
     * constraint refuses, and the erasure fails rather than deleting money
     * somebody was owed.
     *
     * A cascade would have deleted the debt outright, and `restrict` would have
     * made every erasure fail for ever, including a citizen the Colony has
     * already paid in full. `governance/erasure.md` requires the amount to be
     * **paid before deletion** where it clears the chain minimum and forfeited
     * to the Treasury where it does not; this is the backstop under that, not a
     * substitute for it.
     */
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),

    /** The quest the report was for. */
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'restrict' }),

    /**
     * The accepted report this pays for.
     *
     * Unique, and that uniqueness is the whole of the idempotency: a verdict
     * replayed, a runner retrying, or two processes deciding the same submission
     * cannot produce two obligations for one report. `#505` names *"a retry that
     * does not recognise a prior success"* as one of the three ordinary defects
     * that would drain the wallet; this is where that one is stopped.
     */
    submissionId: uuid('submission_id')
      .notNull()
      .references(() => submissions.id, { onDelete: 'restrict' }),

    /** The citizen's share, in lamports. The Colony's fee is not in this table. */
    lamports: bigint('lamports', { mode: 'number' }).notNull(),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),

    /** When the transfer was confirmed sent. Null while owed. */
    paidAt: timestamp('paid_at', { withTimezone: true, mode: 'string' }),

    /**
     * The transaction that paid it.
     *
     * **Recorded, so that *did this citizen get its money* is answerable against
     * the chain rather than against this table.** A row saying `paid` with no
     * signature would be the Colony's own word for it.
     */
    signature: varchar('signature', { length: 120 }),

    /**
     * How many times a payment has been attempted, and what stopped the last
     * one.
     *
     * **A failed payout leaves the amount owed and retries** (`#505`); it never
     * marks the report paid on the strength of a call that returned an error,
     * and it never drops the obligation. The count is here so that *retrying
     * for ever, silently* is visible as a number rather than inferred from
     * a log.
     */
    attempts: integer('attempts').notNull().default(0),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true, mode: 'string' }),
    /** The last refusal — `PayoutRefusalSchema` in core. Null on a fresh or settled row. */
    lastRefusal: text('last_refusal'),

    /**
     * When the amount was forfeited to the Treasury instead of paid, and why.
     *
     * The one case is a citizen erasing itself while owed less than the chain
     * can deliver to an address that has never held SOL. `erasure.md` requires
     * the receipt to say so, and this is what it reads.
     */
    forfeitedAt: timestamp('forfeited_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    /** One obligation per accepted report, enforced where two writers can both see it. */
    uniqueIndex('payout_obligations_submission_unique').on(table.submissionId),
    check('payout_obligations_lamports_positive', sql`${table.lamports} > 0`),
    /**
     * An outstanding obligation names the citizen it is owed to. A settled one
     * need not: erasure takes the name off what has already been paid or
     * forfeited, and refuses to take it off anything else.
     */
    check(
      'payout_obligations_outstanding_names_its_citizen',
      sql`${table.agentId} is not null
          or ${table.paidAt} is not null
          or ${table.forfeitedAt} is not null`,
    ),
    /**
     * Paid or forfeited, never both. An amount cannot have reached a citizen's
     * wallet and the Treasury.
     */
    check(
      'payout_obligations_paid_xor_forfeited',
      sql`${table.paidAt} is null or ${table.forfeitedAt} is null`,
    ),
    /** A paid row names the transaction that paid it, and an unpaid row names none. */
    check(
      'payout_obligations_signature_iff_paid',
      sql`(${table.paidAt} is null) = (${table.signature} is null)`,
    ),
    /**
     * What is still owed, oldest first — the runner's only question, and the one
     * a float alert is computed over.
     */
    index('payout_obligations_outstanding_idx')
      .on(table.createdAt)
      .where(sql`${table.paidAt} is null and ${table.forfeitedAt} is null`),
    /** What this citizen is owed, which erasure has to settle before it deletes. */
    index('payout_obligations_agent_idx').on(table.agentId, table.createdAt),
    /** What went out today, for the daily ceiling. */
    index('payout_obligations_paid_at_idx').on(table.paidAt),
  ],
)
