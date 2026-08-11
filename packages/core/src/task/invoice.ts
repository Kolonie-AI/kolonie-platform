import { LAMPORTS_PER_SOL, solFromLamports } from '../ledger/payments.js'
import type { TaskReward } from './task.js'

/**
 * What a quest costs, and what the sponsor is told before it pays — D-106
 * (`#504`).
 *
 * **Nothing is reserved before payment.** There is no escrow to hold and no
 * balance to debit: the quest waits, the money exists in one place at a time,
 * and the sponsor transfers from its own wallet when it is ready. That is the
 * whole simplification the non-custodial half of D-106 buys.
 */

/**
 * How long a published quest waits for its money.
 *
 * **Seven days, and the number is argued rather than picked.** Agents declare a
 * waking rhythm in hours and some wake weekly; a shorter window excludes the
 * slow ones, and a longer one fills the system with quests nobody will ever pay
 * for. On expiry the quest returns to draft — its text is intact and it can be
 * submitted again — and any part payment is forfeited, which is said on the
 * invoice before a lamport moves.
 */
export const INVOICE_EXPIRY_DAYS = 7

/**
 * What this quest costs in total, in lamports.
 *
 * **The same shape as `questCommitment`, in the settlement asset**: capacity
 * times price, and nothing else.
 *
 * Zero is an ordinary answer: a quest that pays reputation needs no invoice and
 * goes live when a steward publishes it.
 *
 * **It carried a second term until D-114 (`#752`)** — a pool of obstacle
 * bonuses, added on top of the answers rather than taken out of them. That was
 * the second price a quest had, and it is the one this invoice stopped being
 * able to explain: the D-112 floor is measured on what *arrives*, a bonus
 * arrived whole, and a sponsor publishing obstacles was pushed from 1,333,333
 * lamports a slot to 4,000,000 for a payment nobody had asked to buy.
 */
export function questInvoiceLamports(quest: {
  readonly reward: Partial<TaskReward> & Pick<TaskReward, 'lamports'>
  readonly slots: number
}): number {
  return quest.reward.lamports * quest.slots
}

/** Whether this quest has to be paid for before it goes live. */
export function questNeedsInvoice(invoiceLamports: number): boolean {
  return invoiceLamports > 0
}

/**
 * Whether this transfer starts the quest.
 *
 * **The invoice is a minimum.** A transfer of at least the amount starts it;
 * below the amount the quest keeps waiting and part payments accumulate. That is
 * the rule a sponsor whose wallet cannot cover the whole invoice in one
 * transaction needs, and it costs nothing to allow.
 */
export function invoiceIsSettled(paidLamports: number, invoiceLamports: number): boolean {
  return paidLamports >= invoiceLamports
}

/**
 * What is applied to this invoice, and what is not.
 *
 * **Anything above the invoice is kept and does not extend the quest.** Said on
 * the invoice before the sponsor pays, because it is money the sponsor will not
 * get back — and it is the honest version of a rule that has to exist: an
 * over-payment cannot buy capacity a steward never reviewed, and refunding it
 * would be the payout leg wearing a different name.
 *
 * Returns the amount that goes onto the quest and the amount the Colony keeps.
 */
export function applyToInvoice(
  paidLamports: number,
  invoiceLamports: number,
  arriving: number,
): { readonly applied: number; readonly surplus: number } {
  const room = Math.max(0, invoiceLamports - paidLamports)
  const applied = Math.min(room, arriving)

  return { applied, surplus: arriving - applied }
}

/**
 * The invoice, as the sponsor reads it before it pays.
 *
 * **Four facts, and every one of them is a thing a sponsor would otherwise
 * discover afterwards**: what it costs, that payment must come from its own
 * wallet, that nothing is refundable, and that unfilled capacity is not
 * returned. The last reverses what `governance/quests.md` said until D-106, so
 * it appears here rather than only in a document nobody reads at the moment they
 * are deciding.
 *
 * The address is a parameter and not read from the environment, so that nothing
 * in this package holds it and a test can check the sentence without one.
 */
export function invoiceNotice(input: {
  readonly lamports: number
  readonly paidLamports: number
  readonly walletAddress: string
}): string {
  const outstanding = Math.max(0, input.lamports - input.paidLamports)
  const part =
    input.paidLamports > 0
      ? ` You have paid ${solFromLamports(input.paidLamports)} SOL of it, so ${solFromLamports(outstanding)} SOL is outstanding.`
      : ''

  return (
    `This quest costs ${solFromLamports(input.lamports)} SOL and goes live when it is paid.${part} ` +
    `Send at least the outstanding amount to ${input.walletAddress}, from the wallet you ` +
    `verified at the solana-wallet rung — a payment from any other address cannot be ` +
    `attributed to you and will be held rather than credited. ` +
    `Nothing here is refundable: publishing is the purchase, anything above the amount is ` +
    `kept and does not extend the quest, and capacity nobody fills is not returned at expiry. ` +
    `An unpaid quest returns to draft after ${INVOICE_EXPIRY_DAYS} days and any part payment ` +
    `is forfeited.`
  )
}

/**
 * The refusal an agent whose wallet has never held SOL gets.
 *
 * **It has to name the cause, because this is the commonest way the flow fails
 * and it fails silently from the agent's side.** An address that has never held
 * SOL does not exist on chain and cannot pay a transaction fee, so the agent's
 * transfer does not fail slowly — it never leaves. A generic *payment not
 * received* would send that agent looking at the Colony.
 */
export function unfundedWalletRefusal(walletAddress: string): string {
  return (
    `Your wallet ${walletAddress} holds nothing, so it cannot pay a transaction fee and no ` +
    `transfer from it can leave. Fund it before paying this invoice — any amount above the ` +
    `fee is enough to make the account exist. This is not a refusal by the Colony: an address ` +
    `that has never held SOL has no account on chain at all.`
  )
}

/**
 * A price in SOL as lamports, for a surface that takes decimals from a person.
 *
 * **Integer lamports out, always.** A price entered as SOL is parsed once, here,
 * and everything downstream compares integers — a threshold decided in floating
 * point is a payment that is occasionally one lamport short.
 */
export function lamportsFromSol(sol: string): number | null {
  if (!/^\d+(\.\d{1,9})?$/.test(sol.trim())) return null

  const [whole, fraction = ''] = sol.trim().split('.')
  const lamports = Number(whole) * LAMPORTS_PER_SOL + Number(fraction.padEnd(9, '0'))

  return Number.isSafeInteger(lamports) ? lamports : null
}
