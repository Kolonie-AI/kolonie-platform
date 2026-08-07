import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import {
  INVOICE_EXPIRY_DAYS,
  applyToInvoice,
  invoiceIsSettled,
  type AgentId,
  type TaskId,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { agentSkills, tasks } from '../schema/index.js'

/**
 * A sponsor's payment meeting the quest it was for — D-106 (`#504`).
 *
 * **The Colony never pulls.** Nothing in this file initiates a transfer; it
 * reads a payment that has already arrived and been attributed by `#503`, and
 * decides which waiting quest it settles.
 */

/** What applying an arrival to this sponsor's quests came to. */
export interface InvoiceApplication {
  /** The quest the money went to, if there was one waiting. */
  readonly taskId: TaskId | null
  /** What went onto that quest's invoice. */
  readonly applied: number
  /**
   * What the Colony kept: an over-payment, or a payment from a sponsor with no
   * quest waiting at all.
   *
   * **Not an error and not returned.** D-106 has no refunds, and the invoice
   * says so before the sponsor pays — *anything above the amount is kept and
   * does not extend the quest*. Recording it is what makes the Colony's own
   * numbers add up afterwards.
   */
  readonly surplus: number
  /** Whether this arrival is what put the quest live. */
  readonly settled: boolean
}

/**
 * Apply an arriving payment to this sponsor's oldest waiting quest.
 *
 * **Oldest first, and one quest per arrival.** A sponsor with two quests
 * waiting has an order it published them in, and paying the older one first is
 * the only rule that does not require the sponsor to say which — attribution is
 * by sender address, so a transfer carries no reference to a quest and cannot
 * be asked to.
 *
 * **The surplus does not roll onto the next quest.** That is the invoice's own
 * stated rule and it is deliberately not softened here: a payment that quietly
 * started a second quest would be the Colony deciding what a sponsor bought.
 *
 * Takes a transaction, because the caller books the payment in the same one: a
 * quest that went live on a payment row that then rolled back is exactly the
 * failure the single transaction exists to prevent.
 */
export async function applyPaymentToInvoice(
  tx: Transaction,
  command: { readonly sponsorId: AgentId; readonly lamports: number },
): Promise<InvoiceApplication> {
  const [waiting] = await tx
    .select({
      id: tasks.id,
      invoiceLamports: tasks.invoiceLamports,
      paidLamports: tasks.paidLamports,
    })
    .from(tasks)
    .where(and(eq(tasks.createdBy, command.sponsorId), eq(tasks.status, 'awaiting_payment')))
    .orderBy(asc(tasks.awaitingPaymentSince))
    // Locked for the length of the transaction, so two arrivals in the same
    // second cannot both read the same outstanding amount and both settle it.
    .for('update')
    .limit(1)

  if (waiting === undefined) {
    return { taskId: null, applied: 0, surplus: command.lamports, settled: false }
  }

  const invoice = waiting.invoiceLamports ?? 0
  const { applied, surplus } = applyToInvoice(waiting.paidLamports, invoice, command.lamports)
  const paid = waiting.paidLamports + applied
  const settled = invoiceIsSettled(paid, invoice)

  await tx
    .update(tasks)
    .set({
      paidLamports: paid,
      ...(settled && {
        status: 'active' as const,
        // The clock stops when the waiting does, and the check constraint
        // requires it: a quest that is not awaiting payment carries no
        // awaiting-payment timestamp.
        awaitingPaymentSince: null,
      }),
    })
    .where(eq(tasks.id, waiting.id))

  return { taskId: waiting.id as TaskId, applied, surplus, settled }
}

/**
 * Grant the skill that certifies this agent can send a transaction.
 *
 * **Paying is the proof**, which is why the grant costs nothing extra and why it
 * happens here rather than at a rung with a verifier: holding a verified address
 * proves a signature, and many agents can sign and cannot transfer. It is a
 * skill and not a role.
 *
 * Granted on any attributed arrival, not only one that settles an invoice: a
 * part payment is a transaction that left a funded account, which is the whole
 * of what is being certified.
 */
export async function grantTransferSkill(tx: Transaction, agentId: AgentId): Promise<void> {
  // No submission to name: the transaction is the proof, which is why
  // `agent_skills.submission_id` admits this one skill without one. `on conflict
  // do nothing` for the reason the primary key exists — a second payment grants
  // nothing new and is not an error.
  await tx
    .insert(agentSkills)
    .values({ agentId, skill: 'transfer' })
    .onConflictDoNothing({ target: [agentSkills.agentId, agentSkills.skill] })
}

/** A quest whose seven days ran out, and what was forfeited with it. */
export interface ExpiredInvoice {
  readonly taskId: TaskId
  readonly forfeited: number
}

/**
 * Return quests nobody paid for to draft.
 *
 * **The text survives and the money does not.** The quest goes back to `draft`,
 * where its author can edit it and submit it again, and any part payment is
 * forfeited — said on the invoice before the sponsor pays, because it is the one
 * rule here that costs somebody something they might not expect.
 *
 * `paid_lamports` is reset with the status, so a quest resubmitted later starts
 * from nothing rather than carrying a credit nobody agreed to.
 *
 * **`now` is a parameter rather than the clock**, so the boundary this exists to
 * enforce can be tested at it. The seven days are subtracted here rather than by
 * the caller: a cutoff computed at each call site is a cutoff two call sites
 * eventually disagree about.
 */
export async function expireUnpaidQuests(
  db: Database,
  now: Date,
): Promise<readonly ExpiredInvoice[]> {
  const cutoff = new Date(now)
  cutoff.setUTCDate(cutoff.getUTCDate() - INVOICE_EXPIRY_DAYS)

  return await db.transaction(async (tx) => {
    /**
     * Read before the write, because `returning` answers with the row as it is
     * *after* the update — and the update sets `paid_lamports` to zero. What has
     * to be reported is what was forfeited, which by then no longer exists.
     *
     * Locked, so a payment arriving in the same moment either settles the quest
     * before this pass sees it or waits until after it has been returned to
     * draft. Both are correct; a half of each is not.
     */
    const expiring = await tx
      .select({ id: tasks.id, forfeited: tasks.paidLamports })
      .from(tasks)
      .where(
        and(
          eq(tasks.status, 'awaiting_payment'),
          sql`${tasks.awaitingPaymentSince} < ${cutoff.toISOString()}`,
        ),
      )
      .for('update')

    if (expiring.length === 0) return []

    await tx
      .update(tasks)
      .set({ status: 'draft', awaitingPaymentSince: null, paidLamports: 0, invoiceLamports: null })
      .where(
        inArray(
          tasks.id,
          expiring.map((row) => row.id),
        ),
      )

    return expiring.map((row) => ({ taskId: row.id as TaskId, forfeited: row.forfeited }))
  })
}

/**
 * The moment a quest published now would expire unpaid.
 *
 * Here rather than at each caller so that the API, the console and the
 * expiry pass all read the same seven days from {@link INVOICE_EXPIRY_DAYS}.
 */
export function invoiceExpiryFrom(publishedAt: Date): Date {
  const expiry = new Date(publishedAt)
  expiry.setUTCDate(expiry.getUTCDate() + INVOICE_EXPIRY_DAYS)

  return expiry
}

/** What a sponsor still owes on a quest, or nothing if it is not waiting. */
export async function outstandingInvoice(
  db: Database,
  taskId: TaskId,
): Promise<{ readonly invoiceLamports: number; readonly paidLamports: number } | undefined> {
  const [row] = await db
    .select({ invoiceLamports: tasks.invoiceLamports, paidLamports: tasks.paidLamports })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.status, 'awaiting_payment')))
    .limit(1)

  if (row === undefined) return undefined

  return { invoiceLamports: row.invoiceLamports ?? 0, paidLamports: row.paidLamports }
}
