import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import {
  paymentQuarantine,
  type AgentId,
  type ObservedPayment,
  type PaymentObserver,
  type PaymentQuarantine,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { colonyPayments, solanaWalletChallenges } from '../schema/index.js'
import {
  applyPaymentToInvoice,
  grantTransferSkill,
  type InvoiceApplication,
} from './quest-invoices.js'
import { toTimestamp } from './rows.js'

/**
 * The way in, after D-106: a sponsor pays from its own wallet and the Colony
 * recognises it by the address it came from (`#503`).
 *
 * **Nothing here holds a key.** There is no keypair generated in this file, no
 * secret sealed, and no address issued to anybody — the Colony has one wallet
 * and everyone else keeps their own. `colony-payments.test.ts` asserts that the
 * exported surface of this module contains no such operation, which is the
 * property `#506` asks to survive the removal of `deposits.ts`.
 */

/** What a recorded payment came to, and what the caller needs back from it. */
export type ColonyPaymentOutcome =
  | {
      readonly outcome: 'attributed'
      readonly agentId: AgentId
      readonly lamports: number
      /**
       * The quest this arrival went to, and whether it started it (`#504`).
       *
       * Absent means the sponsor had nothing waiting, which is not an error: an
       * arrival with no invoice to meet is kept, exactly as an over-payment is.
       */
      readonly invoice?: InvoiceApplication
    }
  | { readonly outcome: 'quarantined'; readonly quarantine: PaymentQuarantine }
  | { readonly outcome: 'already-recorded' }
  | { readonly outcome: 'not-final' }

/**
 * Record an arrival at the Colony wallet, attributed to its sender or
 * quarantined.
 *
 * **One statement decides and writes.** The lookup and the insert are in one
 * transaction, so a citizen clearing the wallet rung in the same second cannot
 * produce a row that is quarantined and attributable at once.
 *
 * **Idempotent by signature, in the database**, exactly as the deposit path was:
 * webhook redelivery is normal operation, and the unique index is what makes the
 * reconciliation safe to run beside a live delivery.
 *
 * **Nothing is written for a payment that is not `finalized`.** A row saying
 * money arrived, for a transfer that can still vanish, would have to be deleted
 * afterwards — a worse record than no record.
 */
export async function recordColonyPayment(
  db: Database,
  payment: ObservedPayment,
  colonyAddress: string,
  /**
   * Which channel saw it (`kolonie-infra#95`).
   *
   * **Appended and optional**, so every existing caller and test is untouched
   * and a caller that genuinely does not know writes `null` rather than
   * guessing. The two that do know are the webhook and the reconciliation, and
   * both pass it.
   */
  observedBy?: PaymentObserver,
): Promise<ColonyPaymentOutcome> {
  return await db.transaction(async (tx) => {
    /**
     * The citizen that proved it controls this address, if there is one.
     *
     * **Only cleared rows count**, which is the same partial index the wallet
     * rung's uniqueness rests on: an address on an open or failed attempt has
     * proved nothing, and attributing money to it would let anybody be paid for
     * naming somebody else's wallet.
     *
     * A citizen that has erased itself is simply absent — the challenge row
     * cascaded away with the agent — and its payment quarantines as though it
     * came from a stranger. See `paymentQuarantine`.
     */
    const [sender] = await tx
      .select({ agentId: solanaWalletChallenges.agentId })
      .from(solanaWalletChallenges)
      .where(
        and(
          eq(solanaWalletChallenges.address, payment.sender),
          sql`${solanaWalletChallenges.verifiedAt} is not null`,
        ),
      )
      .limit(1)

    const quarantine = paymentQuarantine(payment, { verified: sender !== undefined }, colonyAddress)

    // Not finalized writes nothing at all — see the note above.
    if (quarantine === 'not-final') return { outcome: 'not-final' as const }

    const attributed = quarantine === undefined

    const [row] = await tx
      .insert(colonyPayments)
      .values({
        signature: payment.signature,
        sender: payment.sender,
        recipient: payment.recipient,
        lamports: payment.lamports,
        ...(observedBy === undefined ? {} : { observedBy }),
        ...(attributed ? { agentId: sender!.agentId, attributedAt: sql`now()` } : { quarantine }),
      })
      .onConflictDoNothing({ target: colonyPayments.signature })
      .returning({ id: colonyPayments.id })

    if (row === undefined) return { outcome: 'already-recorded' as const }

    if (attributed) {
      const agentId = sender!.agentId as AgentId

      /**
       * The payment meets its quest in the same transaction that records it
       * (`#504`).
       *
       * A quest that went live on a payment row which then rolled back is the
       * failure the single transaction exists to prevent — the same argument
       * `recordDeposit` made about the deposit row and its ledger credit.
       */
      const invoice = await applyPaymentToInvoice(tx, {
        sponsorId: agentId,
        lamports: payment.lamports,
      })

      // Paying is the proof, and a part payment is a transaction that left a
      // funded account — which is the whole of what is being certified.
      await grantTransferSkill(tx, agentId)

      return {
        outcome: 'attributed' as const,
        agentId,
        lamports: payment.lamports,
        invoice,
      }
    }

    return { outcome: 'quarantined' as const, quarantine: quarantine as PaymentQuarantine }
  })
}

/** Whether this signature has already been recorded, attributed or quarantined. */
export async function colonyPaymentRecorded(db: Database, signature: string): Promise<boolean> {
  const [row] = await db
    .select({ id: colonyPayments.id })
    .from(colonyPayments)
    .where(eq(colonyPayments.signature, signature))
    .limit(1)

  return row !== undefined
}

/** One arrival, as anybody outside this package reads it. */
export interface ColonyPaymentRecord {
  readonly signature: string
  readonly sender: string
  readonly lamports: number
  readonly observedAt: string
  readonly attributedAt: string | null
  readonly quarantine: PaymentQuarantine | null
  readonly resolvedAt: string | null
  readonly resolution: string | null
}

/**
 * Everything quarantined and not yet settled, oldest first.
 *
 * **Oldest first, and that is not a detail.** This is a queue of money the
 * Colony is holding and cannot honour, and the row that has been waiting longest
 * is the one somebody is most likely to be asking about.
 *
 * Exported because `#503` requires quarantined funds to be *"a row a maintainer
 * can read, not a log line"*. A log line is a thing that scrolls away.
 */
export async function quarantinedPayments(
  db: Database,
  limit = 100,
): Promise<readonly ColonyPaymentRecord[]> {
  const rows = await db
    .select()
    .from(colonyPayments)
    .where(and(sql`${colonyPayments.quarantine} is not null`, isNull(colonyPayments.resolvedAt)))
    .orderBy(colonyPayments.observedAt)
    .limit(limit)

  return rows.map(toRecord)
}

/** This citizen's payments to the Colony, newest first. */
export async function colonyPaymentsFrom(
  db: Database,
  agentId: AgentId,
): Promise<readonly ColonyPaymentRecord[]> {
  const rows = await db
    .select()
    .from(colonyPayments)
    .where(eq(colonyPayments.agentId, agentId))
    .orderBy(desc(colonyPayments.observedAt))

  return rows.map(toRecord)
}

/**
 * Settle a quarantined row with a note saying what was done about it.
 *
 * **It cannot attribute.** There is deliberately no `agentId` parameter: money
 * from an address nobody proved they control does not become somebody's on the
 * strength of a claim, and a function that could do it would be the one place
 * the non-custodial argument leaks. Sending it back, keeping it, or leaving it
 * are all outside this database; recording which is not.
 */
export async function resolveQuarantinedPayment(
  db: Database,
  signature: string,
  resolution: string,
): Promise<boolean> {
  const rows = await db
    .update(colonyPayments)
    .set({ resolvedAt: sql`now()`, resolution })
    .where(
      and(
        eq(colonyPayments.signature, signature),
        sql`${colonyPayments.quarantine} is not null`,
        isNull(colonyPayments.resolvedAt),
      ),
    )
    .returning({ id: colonyPayments.id })

  return rows.length > 0
}

function toRecord(row: typeof colonyPayments.$inferSelect): ColonyPaymentRecord {
  return {
    signature: row.signature,
    sender: row.sender,
    lamports: row.lamports,
    observedAt: toTimestamp(row.observedAt),
    attributedAt: row.attributedAt === null ? null : toTimestamp(row.attributedAt),
    quarantine: row.quarantine as PaymentQuarantine | null,
    resolvedAt: row.resolvedAt === null ? null : toTimestamp(row.resolvedAt),
    resolution: row.resolution,
  }
}
