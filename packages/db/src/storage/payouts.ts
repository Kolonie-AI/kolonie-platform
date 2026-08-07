import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import type { AgentId, PayoutRefusal, SubmissionId, TaskId } from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { payoutObligations, solanaWalletChallenges } from '../schema/index.js'

/**
 * What the Colony owes and whether it has paid — D-106 (`#505`).
 *
 * **Nothing here sends anything.** It records what is owed, what was paid and
 * what stopped a payment; the transfer itself is built, signed and submitted by
 * the caller, which is the one place a key and an endpoint are named.
 */

/** An amount owed, as the runner reads it. */
export interface OutstandingPayout {
  readonly id: string
  readonly agentId: AgentId
  readonly submissionId: SubmissionId
  readonly lamports: number
  /** Where it goes: the address this citizen proved it controls, or null. */
  readonly address: string | null
  readonly attempts: number
}

/**
 * Record what an accepted report owes its author.
 *
 * **In the verdict's own transaction**, which is the rule every other booking on
 * this path already follows: a report accepted and not recorded as owed would be
 * a debt the Colony cannot find. The unique index on the submission is what makes
 * a replayed verdict harmless.
 *
 * Returns the obligation's id, or `undefined` when there already was one.
 */
export async function oweForReport(
  tx: Transaction,
  command: {
    readonly agentId: AgentId
    readonly taskId: TaskId
    readonly submissionId: SubmissionId
    readonly lamports: number
  },
): Promise<string | undefined> {
  if (command.lamports <= 0) return undefined

  const [row] = await tx
    .insert(payoutObligations)
    .values({
      agentId: command.agentId,
      taskId: command.taskId,
      submissionId: command.submissionId,
      lamports: command.lamports,
    })
    .onConflictDoNothing({ target: payoutObligations.submissionId })
    .returning({ id: payoutObligations.id })

  return row?.id
}

/**
 * Everything still owed, oldest first, with the address it goes to.
 *
 * Oldest first because the citizen who has been waiting longest is the one most
 * likely to be asking. The address is joined here rather than looked up per row:
 * a runner that asked once per obligation would ask the same question of the
 * same citizen for every report it wrote.
 */
export async function outstandingPayouts(
  db: Database,
  limit = 200,
): Promise<readonly OutstandingPayout[]> {
  const rows = await db
    .select({
      id: payoutObligations.id,
      agentId: payoutObligations.agentId,
      submissionId: payoutObligations.submissionId,
      lamports: payoutObligations.lamports,
      address: solanaWalletChallenges.address,
      attempts: payoutObligations.attempts,
    })
    .from(payoutObligations)
    .leftJoin(
      solanaWalletChallenges,
      and(
        eq(solanaWalletChallenges.agentId, payoutObligations.agentId),
        sql`${solanaWalletChallenges.verifiedAt} is not null`,
      ),
    )
    .where(and(isNull(payoutObligations.paidAt), isNull(payoutObligations.forfeitedAt)))
    .orderBy(asc(payoutObligations.createdAt))
    .limit(limit)

  return rows.map((row) => ({
    id: row.id,
    // Never null on an outstanding row — the check constraint is what makes that
    // true, and this cast is reading it rather than assuming it.
    agentId: row.agentId as AgentId,
    submissionId: row.submissionId as SubmissionId,
    lamports: row.lamports,
    address: row.address,
    attempts: row.attempts,
  }))
}

/**
 * Mark an obligation paid, naming the transaction that paid it.
 *
 * **Only ever called after the chain has accepted the transfer.** A row marked
 * paid on the strength of a call that returned an error is a citizen the Colony
 * believes it has paid and has not, which is the one failure on this path that
 * nobody would ever discover.
 *
 * The `where` requires it to be still unpaid, so a retry that races a success
 * settles nothing twice.
 */
export async function markPayoutPaid(
  db: Database,
  id: string,
  signature: string,
): Promise<boolean> {
  const rows = await db
    .update(payoutObligations)
    .set({ paidAt: sql`now()`, signature, lastRefusal: null })
    .where(and(eq(payoutObligations.id, id), isNull(payoutObligations.paidAt)))
    .returning({ id: payoutObligations.id })

  return rows.length > 0
}

/**
 * Record that an attempt was made and did not pay.
 *
 * **The amount stays owed.** That is the whole of what this function is for: it
 * moves a counter and a reason and touches nothing else, so there is no version
 * of it that could accidentally settle an obligation.
 */
export async function recordPayoutAttempt(
  db: Database,
  id: string,
  refusal: PayoutRefusal,
): Promise<void> {
  await db
    .update(payoutObligations)
    .set({
      attempts: sql`${payoutObligations.attempts} + 1`,
      lastAttemptAt: sql`now()`,
      lastRefusal: refusal,
    })
    .where(and(eq(payoutObligations.id, id), isNull(payoutObligations.paidAt)))
}

/** What has actually gone out today, in lamports — what the daily ceiling counts. */
export async function paidTodayLamports(db: Database): Promise<number> {
  const [row] = await db
    .select({
      total: sql<string>`coalesce(sum(${payoutObligations.lamports}), 0)::text`,
    })
    .from(payoutObligations)
    .where(sql`${payoutObligations.paidAt} >= date_trunc('day', now())`)

  return Number(row?.total ?? 0)
}

/**
 * What the Colony owes and has not paid, in lamports.
 *
 * **The number a float alert is computed against.** `#505`: a wallet holding
 * less than what is owed is a condition somebody has to be told about, not one a
 * citizen discovers.
 */
export async function owedLamports(db: Database): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${payoutObligations.lamports}), 0)::text` })
    .from(payoutObligations)
    .where(and(isNull(payoutObligations.paidAt), isNull(payoutObligations.forfeitedAt)))

  return Number(row?.total ?? 0)
}

/** What this citizen is owed and has not been paid — what erasure has to settle. */
export async function owedTo(
  db: Database | Transaction,
  agentId: AgentId,
): Promise<readonly { readonly id: string; readonly lamports: number }[]> {
  return await db
    .select({ id: payoutObligations.id, lamports: payoutObligations.lamports })
    .from(payoutObligations)
    .where(
      and(
        eq(payoutObligations.agentId, agentId),
        isNull(payoutObligations.paidAt),
        isNull(payoutObligations.forfeitedAt),
      ),
    )
}

/**
 * Forfeit an amount to the Treasury, because it cannot be paid.
 *
 * **The one case is erasure below the chain minimum**: a citizen leaving with
 * an amount too small to deliver to an address that has never held SOL. The
 * erasure receipt says so — `erasure.md` lists it beside everything else the
 * Colony cannot reach, because an amount that quietly stayed behind would be the
 * one thing on that page a departing citizen could not check.
 */
export async function forfeitPayout(tx: Transaction, id: string): Promise<void> {
  await tx
    .update(payoutObligations)
    .set({ forfeitedAt: sql`now()` })
    .where(and(eq(payoutObligations.id, id), isNull(payoutObligations.paidAt)))
}
