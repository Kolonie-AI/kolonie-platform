import {
  ceilingsRefusal,
  payoutRefusal,
  payoutRefusalRaises,
  payoutRefusalReason,
  RENT_EXEMPT_MINIMUM_FALLBACK,
  signSolTransfer,
  type PayoutCeilings,
  type PayoutRefusal,
} from '@kolonie-ai/core'
import type { Database, OutstandingPayout } from '@kolonie-ai/db'
import {
  forfeitPayout as forfeitInDatabase,
  markPayoutPaid as markPaidInDatabase,
  outstandingPayouts as outstandingInDatabase,
  owedLamports as owedInDatabase,
  paidTodayLamports as paidTodayInDatabase,
  recordPayoutAttempt as recordAttemptInDatabase,
} from '@kolonie-ai/db'

/**
 * Paying citizens, one accepted report at a time — D-106 (`#505`).
 *
 * **Immediate rather than a daily run**, decided by the maintainer on
 * 2026-08-07: the per-transaction cost is a rounding error and traceability is
 * worth more than the saving. It is also what removes the balance — an amount
 * that is never held is an amount nobody has to ask permission to convert.
 *
 * *Immediate* here means *in the next pass*, seconds after the verdict, and not
 * *inside the verdict's transaction*. A verdict that waited on a chain round
 * trip would fail when an endpoint did, and the citizen would lose the pass as
 * well as the payment.
 */

/** Everything the payout path needs from the outside world. */
export interface PayoutDesk {
  outstanding(): Promise<readonly OutstandingPayout[]>
  markPaid(id: string, signature: string): Promise<boolean>
  /**
   * Write an amount off to the Treasury.
   *
   * **Reachable in exactly one case**: an accrual below the chain minimum owed
   * to a citizen that has erased itself. While the citizen is here the amount
   * waits — it may clear, or the citizen may fund the address. Once it has gone,
   * nobody will do either, and carrying dust for ever would make *what the
   * Colony owes* a number that never comes down.
   */
  forfeit(id: string): Promise<void>
  recordAttempt(id: string, refusal: PayoutRefusal): Promise<void>
  paidToday(): Promise<number>
  owed(): Promise<number>
}

/** The chain, as this path needs it. A port, so a test needs no key and no network. */
export interface PayoutChain {
  /** What the Colony's wallet holds, in lamports. */
  balance(address: string): Promise<number>
  /** Whether this address exists on chain — an account with no lamports has none. */
  funded(address: string): Promise<boolean>
  /** The rent-exempt minimum for an account holding no data, read from the chain. */
  rentExemptMinimum(): Promise<number>
  /** A recent blockhash, which is what makes a transaction valid for a short while. */
  latestBlockhash(): Promise<string>
  /** Submit a signed transaction. Returns its signature, or throws. */
  send(transaction: string): Promise<string>
}

export interface PayoutDependencies {
  readonly desk: PayoutDesk
  readonly chain?: PayoutChain | undefined
  /** The wallet paying, and the secret that signs for it. */
  readonly wallet?: { readonly address: string; readonly secret: string } | undefined
  readonly ceilings?: PayoutCeilings | undefined
}

/** The payout desk, backed by Postgres. */
export function databasePayouts(db: Database): PayoutDesk {
  return {
    outstanding: () => outstandingInDatabase(db),
    markPaid: (id, signature) => markPaidInDatabase(db, id, signature),
    forfeit: (id) => forfeitInDatabase(db, id),
    recordAttempt: (id, refusal) => recordAttemptInDatabase(db, id, refusal),
    paidToday: () => paidTodayInDatabase(db),
    owed: () => owedInDatabase(db),
  }
}

/**
 * How much SOL the wallet keeps back for its own transaction fees.
 *
 * A transfer costs 5,000 lamports and the wallet pays one per payout. This is
 * roughly two thousand of them — enough that the float running low is noticed as
 * *the float is low* rather than as *transactions stopped being accepted*, which
 * is a far harder thing to diagnose.
 */
export const FEE_RESERVE_LAMPORTS = 10_000_000

/** What one pass of the payout runner came to. */
export interface PayoutPassOutcome {
  readonly considered: number
  readonly paid: number
  readonly lamportsPaid: number
  /** Refused or deferred, by reason — what a maintainer reads to see whether to act. */
  readonly refused: Readonly<Record<string, number>>
  /** Whether the wallet holds less than the Colony owes. Loud on purpose. */
  readonly floatShort: boolean
  /** Amounts written off to the Treasury because nobody is left to receive them. */
  readonly forfeited: number
}

/**
 * One pass: pay everything that may be paid, and record why the rest was not.
 *
 * **A failed payout leaves the amount owed and retries.** It never marks a
 * report paid on the strength of a call that returned an error, and it never
 * drops the obligation — `#132` made the opposite mistake's rule for the
 * verification queue, that a permanent skip is a silent refusal.
 *
 * **The pass stops at the daily ceiling rather than skipping past it.** Once one
 * payout is refused for the day's total, every later one would be too, and
 * continuing would turn one alert into a hundred.
 */
export async function runPayouts(deps: PayoutDependencies): Promise<PayoutPassOutcome> {
  const { desk, chain, wallet, ceilings } = deps
  const refused: Record<string, number> = {}
  const nothing: PayoutPassOutcome = {
    considered: 0,
    paid: 0,
    lamportsPaid: 0,
    refused,
    floatShort: false,
    forfeited: 0,
  }

  // A deployment with no wallet, no endpoint or no ceilings cannot pay. It has
  // said so at startup; a pass that threw on a schedule would say it hourly.
  if (chain === undefined || wallet === undefined || ceilings === undefined) return nothing

  const outstanding = await desk.outstanding()
  if (outstanding.length === 0) {
    // Asked even with nothing outstanding, because a float that has run out is
    // worth knowing about before the next report is accepted rather than after.
    return { ...nothing, floatShort: false }
  }

  const [balance, owed, rentMinimum] = await Promise.all([
    chain.balance(wallet.address),
    desk.owed(),
    chain.rentExemptMinimum(),
  ])

  /**
   * **The float running dry is the Colony's failure and must be loud.** The
   * wallet holding less than what is owed is a condition somebody has to be told
   * about, not one a citizen discovers.
   */
  const floatShort = balance - FEE_RESERVE_LAMPORTS < owed

  let paidToday = await desk.paidToday()
  let forfeited = 0
  let paid = 0
  let lamportsPaid = 0
  let available = Math.max(0, balance - FEE_RESERVE_LAMPORTS)

  for (const obligation of outstanding) {
    if (obligation.address === null) {
      await defer(desk, obligation, 'no-verified-address', refused)
      continue
    }

    const refusal = payoutRefusal({
      lamports: obligation.lamports,
      ceilings,
      paidToday,
      availableFloat: available,
      chainMinimum: rentMinimum,
      recipientFunded: await chain.funded(obligation.address),
    })

    if (refusal !== undefined) {
      /**
       * The one amount that is written off rather than waited on: an accrual
       * too small to deliver, owed to a citizen that has erased itself.
       *
       * **Both halves are required.** A living citizen's accrual waits, because
       * it may clear or the citizen may fund the address; a departed citizen's
       * cannot do either. `governance/erasure.md` says such an amount is
       * forfeited to the Treasury and that the receipt records it, and the
       * receipt already named it as owed at the moment of erasure.
       */
      if (refusal === 'accruing-below-chain-minimum' && obligation.erased) {
        await desk.forfeit(obligation.id)
        forfeited++
        continue
      }

      await defer(desk, obligation, refusal, refused)
      // Every later payout would hit the same wall, and a hundred identical
      // alerts is a hundred fewer people reading them.
      if (refusal === 'above-daily-ceiling') break
      continue
    }

    let signature: string
    try {
      const signed = signSolTransfer({
        fromSeed: wallet.secret,
        fromAddress: wallet.address,
        toAddress: obligation.address,
        lamports: obligation.lamports,
        recentBlockhash: await chain.latestBlockhash(),
      })

      // `null` is a malformed input rather than a chain failure — most likely an
      // address that is not one. Deferred rather than thrown, so one bad row
      // cannot stop the pass over every other citizen.
      if (signed === null) {
        await defer(desk, obligation, 'unavailable', refused)
        continue
      }

      signature = await chain.send(signed.transaction)
    } catch {
      await defer(desk, obligation, 'unavailable', refused)
      continue
    }

    /**
     * Marked paid only after the chain accepted it, and only if it was still
     * unpaid. A row marked paid on a call that errored is a citizen the Colony
     * believes it has paid and has not — the one failure here nobody would ever
     * discover.
     */
    if (await desk.markPaid(obligation.id, signature)) {
      paid++
      lamportsPaid += obligation.lamports
      paidToday += obligation.lamports
      available -= obligation.lamports
    }
  }

  return { considered: outstanding.length, paid, lamportsPaid, refused, floatShort, forfeited }
}

/** Record an attempt that did not pay, and count it for the pass's report. */
async function defer(
  desk: PayoutDesk,
  obligation: OutstandingPayout,
  refusal: PayoutRefusal,
  refused: Record<string, number>,
): Promise<void> {
  refused[refusal] = (refused[refusal] ?? 0) + 1
  await desk.recordAttempt(obligation.id, refusal)
}

/**
 * Why this deployment cannot pay, or `undefined` if it can.
 *
 * Read at startup, so that a process which will never pay says so where an
 * operator is looking rather than at the first accepted report.
 */
export function payoutConfigurationRefusal(input: {
  readonly perTransaction: number | undefined
  readonly perDay: number | undefined
}): string | undefined {
  return ceilingsRefusal(input)
}

export { payoutRefusalReason, payoutRefusalRaises, RENT_EXEMPT_MINIMUM_FALLBACK }
