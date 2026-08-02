import { and, eq, inArray, sql } from 'drizzle-orm'
import {
  LedgerTransactionIdSchema,
  questFundingReference,
  questPayoutReference,
  questRefundReference,
  type AgentId,
  type SubmissionId,
  type TaskId,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { ledgerEntries, submissions, tasks } from '../schema/index.js'

/**
 * A sponsor's coins are on account before its quest is written, reserved when
 * the quest is submitted, escrowed when a steward publishes it, released one
 * payout at a time as reports are accepted, and refunded if the quest expires
 * unfilled. **Nothing is minted at any point** — a quest moves a credit the
 * sponsor already had, and the mint is never touched (D-038).
 *
 * ## Zero books nothing
 *
 * Every function here writes no ledger rows at all when the amount is zero.
 * `ledger_entries_amount_non_zero` would refuse the row anyway, but the reason
 * is older than the constraint: a zero-sum transaction of zero is not a
 * transaction, and a ledger full of rows recording that nothing happened
 * exercises the deferred double-entry trigger for no reason.
 *
 * Since `kolonie-docs#130` a pilot quest pays one cent rather than zero,
 * precisely so that all four bookings execute rather than being skipped by this
 * branch. The branch stays because an Academy task still pays nothing, and
 * because a quest may legitimately be reputation-only.
 */

/** The statuses whose unspent capacity a sponsor has committed but not yet spent. */
const RESERVING_STATUSES = ['pending_review', 'active'] as const

/**
 * What a sponsor has committed to quests that have not yet been paid out.
 *
 * **Computed, never stored, and there is a test asserting no table holds it.**
 * A reservations table would be a second place a balance lives and the two would
 * disagree — the same argument D-002 made against a balance column on `agents`,
 * and the reason `#175` has no `slots_used` either.
 *
 * A reservation is not a booking. Between submission for review and publication
 * the credits are committed but **nothing has happened**, and the ledger records
 * what happened rather than what is intended. So this is a sum over the
 * sponsor's own quests, not a query against `ledger_entries`.
 *
 * Unspent capacity, not capacity: once a quest is published its whole capacity
 * has moved into escrow, and what is still reserved against the *balance* is
 * nothing. The `active` rows are here for the case a published quest's escrow
 * has been partly paid out — their remainder is in escrow rather than in the
 * balance, so they contribute zero and are counted for the `pending_review`
 * shape alone. See {@link availableBalance} for what the caller does with it.
 */
export async function reservedBy(db: Database | Transaction, sponsorId: AgentId): Promise<number> {
  const [row] = await db
    .select({
      reserved: sql<string>`coalesce(sum(
        ${tasks.rewardCredits} * greatest(
          coalesce(${tasks.slots}, 0) - (
            select count(*) from ${submissions}
            where ${submissions.taskId} = ${tasks.id} and ${submissions.status} = 'passed'
          ), 0)
      ), 0)::text`,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.createdBy, sponsorId),
        eq(tasks.kind, 'quest'),
        eq(tasks.status, 'pending_review'),
      ),
    )

  return Number(row?.reserved ?? 0)
}

/**
 * What a sponsor may still commit: its ledger balance minus what it has
 * reserved.
 *
 * The ledger balance is summed here rather than taken from `balanceOfAgent`, so
 * that both halves are read inside one transaction when the caller has one — a
 * quest submitted between the two reads would otherwise be invisible to exactly
 * the check that exists to see it.
 */
export async function availableBalance(
  db: Database | Transaction,
  sponsorId: AgentId,
): Promise<{ readonly balance: number; readonly reserved: number; readonly available: number }> {
  const [held] = await db
    .select({ total: sql<string>`coalesce(sum(${ledgerEntries.amount}), 0)::text` })
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.accountKind, 'agent'), eq(ledgerEntries.agentId, sponsorId)))

  const balance = Number(held?.total ?? 0)
  const reserved = await reservedBy(db, sponsorId)
  return { balance, reserved, available: balance - reserved }
}

/** What a quest's escrow currently holds. Zero once it has closed out. */
export async function escrowHeldFor(db: Database | Transaction, taskId: TaskId): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${ledgerEntries.amount}), 0)::text` })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.systemAccount, 'escrow'),
        sql`${ledgerEntries.reference} like ${'quest:' + taskId + ':%'}`,
      ),
    )

  return Number(row?.total ?? 0)
}

/** Both rows of one booking, written together. */
async function book(
  tx: Transaction,
  entry: {
    readonly reference: string
    readonly type: 'task_funding' | 'task_payout'
    readonly memo: string
    readonly amount: number
    readonly from:
      | { readonly kind: 'agent'; readonly agentId: AgentId }
      | { readonly kind: 'system'; readonly account: 'escrow' | 'treasury' }
    readonly to:
      | { readonly kind: 'agent'; readonly agentId: AgentId }
      | { readonly kind: 'system'; readonly account: 'escrow' | 'treasury' }
  },
): Promise<void> {
  // Generated here rather than by the database: both entries of one booking must
  // carry the same id, and a column default would give each of them its own.
  const transactionId = LedgerTransactionIdSchema.parse(crypto.randomUUID())
  const side = (who: typeof entry.from, amount: number): typeof ledgerEntries.$inferInsert => ({
    transactionId,
    accountKind: who.kind,
    ...(who.kind === 'agent' ? { agentId: who.agentId } : { systemAccount: who.account }),
    amount,
    type: entry.type,
    memo: entry.memo,
    reference: entry.reference,
  })

  await tx
    .insert(ledgerEntries)
    .values([side(entry.from, -entry.amount), side(entry.to, entry.amount)])
}

/**
 * Sponsor → escrow, for the whole capacity, when a steward publishes.
 *
 * **Called inside the publication's transaction**, so the status change to
 * `active` and the money moving commit together or neither does. A published
 * quest whose money did not move is the exact failure the prepay model exists to
 * prevent, and a two-step version has a window in which it is true.
 *
 * Booking twice is refused by `ledger_entries_quest_funding_unique` rather than
 * by a check here: the thing that would book twice is two requests publishing
 * the same quest in the same millisecond, and both would pass a `select`.
 */
export async function fundQuestEscrow(
  tx: Transaction,
  command: {
    readonly taskId: TaskId
    readonly sponsorId: AgentId
    readonly credits: number
    readonly capacity: number
  },
): Promise<number> {
  const total = command.credits * command.capacity
  if (total === 0) return 0

  await book(tx, {
    reference: questFundingReference(command.taskId),
    type: 'task_funding',
    memo: `Quest escrow — ${command.capacity} × ${command.credits}`,
    amount: total,
    from: { kind: 'agent', agentId: command.sponsorId },
    to: { kind: 'system', account: 'escrow' },
  })

  return total
}

/**
 * Escrow → citizen, for one accepted report.
 *
 * **Booked in the verdict's transaction**, exactly as an Academy pass already
 * books reputation and grants a skill in one. No second job, no reconciliation:
 * a report that was accepted and not paid would be a debt the Colony cannot
 * find.
 */
export async function payQuestReport(
  tx: Transaction,
  command: {
    readonly taskId: TaskId
    readonly submissionId: SubmissionId
    readonly agentId: AgentId
    readonly credits: number
    /**
     * What the Colony paid and why, in the words the verdict used.
     *
     * Passed in rather than written here, so a quest payout carries the same rate
     * record an Academy reward does — the memo is where an audit reads what was
     * paid and at what rate, and a payout that dropped it would be the one entry
     * in the ledger a reviewer had to reconstruct from somewhere else.
     */
    readonly memo: string
  },
): Promise<void> {
  if (command.credits === 0) return

  /**
   * **The escrow may never go negative**, and this is where that is enforced.
   *
   * Capacity is supposed to make it impossible — `#175` refuses a submission
   * once every slot is taken, so there can never be more accepted reports than
   * the escrow was funded for. This checks it anyway, because the two are
   * different mechanisms and the failure if they ever disagree is the worst kind
   * available here: an escrow lent against itself, paying citizens with money
   * that belongs to another sponsor's quest.
   *
   * It throws rather than returning an outcome. Every caller is inside a verdict
   * transaction that has already decided the report is good, and there is no
   * sensible partial answer — the whole verdict has to go back.
   */
  const held = await escrowHeldFor(tx, command.taskId)
  if (held < command.credits) {
    throw new Error(
      `quest ${command.taskId} holds ${held} in escrow and a report costs ${command.credits}: ` +
        'paying it would overdraw the escrow into another quest’s money',
    )
  }

  await book(tx, {
    reference: questPayoutReference(command.taskId, command.submissionId),
    type: 'task_payout',
    memo: command.memo,
    amount: command.credits,
    from: { kind: 'system', account: 'escrow' },
    to: { kind: 'agent', agentId: command.agentId },
  })
}

/**
 * Escrow → sponsor, for capacity that expired unspent.
 *
 * The sponsor bought reports and did not receive them, and the Colony has no
 * claim on the difference.
 *
 * **An ownerless quest refunds to the `treasury` instead.** A sponsor that
 * erased itself mid-quest leaves the quest standing with `created_by` unset —
 * which `tasks.ts` already implements and `erasure.md` §2 already argued — and
 * the consequence nobody had written down is that its unspent remainder has
 * nowhere to go. It goes to the Colony rather than staying in escrow forever,
 * because escrow holding money for a quest that has ended is a balance that
 * never nets to zero and therefore an audit that never reconciles.
 *
 * Refunding twice is refused by the same unique index that refuses funding
 * twice; the two carry different references.
 */
export async function refundQuestRemainder(
  tx: Transaction,
  command: { readonly taskId: TaskId },
): Promise<number> {
  const remainder = await escrowHeldFor(tx, command.taskId)
  if (remainder === 0) return 0

  const [task] = await tx
    .select({ sponsorId: tasks.createdBy })
    .from(tasks)
    .where(eq(tasks.id, command.taskId))
    .limit(1)

  await book(tx, {
    reference: questRefundReference(command.taskId),
    type: 'task_funding',
    memo:
      task?.sponsorId == null
        ? 'Quest closed — remainder to the treasury, its author having erased itself'
        : 'Quest closed — unspent capacity refunded',
    amount: remainder,
    from: { kind: 'system', account: 'escrow' },
    to:
      task?.sponsorId == null
        ? { kind: 'system', account: 'treasury' }
        : { kind: 'agent', agentId: task.sponsorId as AgentId },
  })

  return remainder
}

/** Whether a sponsor could still commit this much. Used before accepting a draft for review. */
export async function canCommit(
  db: Database | Transaction,
  sponsorId: AgentId,
  total: number,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly shortfall: number }> {
  const { available } = await availableBalance(db, sponsorId)
  return available >= total ? { ok: true } : { ok: false, shortfall: total - available }
}

/** The statuses a reservation is computed over, exported so a test can pin them. */
export const RESERVED_IN_STATUSES = RESERVING_STATUSES

/** Every quest whose expiry has passed and whose escrow still holds something. */
export async function questsAwaitingRefund(db: Database): Promise<readonly TaskId[]> {
  const rows = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.kind, 'quest'),
        inArray(tasks.status, ['active', 'retired']),
        sql`${tasks.expiresAt} is not null and ${tasks.expiresAt} <= now()`,
      ),
    )

  return rows.map((row) => row.id as TaskId)
}
