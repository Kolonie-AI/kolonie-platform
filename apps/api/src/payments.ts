import type { AgentId, ObservedPayment, TransferClaim } from '@kolonie-ai/core'
import {
  colonyPaymentRecorded as paymentRecordedInDatabase,
  colonyPaymentsFrom as paymentsFromInDatabase,
  quarantinedPayments as quarantinedInDatabase,
  recordColonyPayment as recordPaymentInDatabase,
  type ColonyPaymentOutcome,
  type ColonyPaymentRecord,
  type Database,
} from '@kolonie-ai/db'

/**
 * The way in, after D-106 (`#503`): one Colony wallet, and a payment recognised
 * by the address it came from.
 *
 * **Observed twice, on purpose, and the slow one is the one that must be
 * sufficient.** A Helius webhook carries the live path and an hourly
 * reconciliation re-reads the wallet's recent signatures. `kolonie-infra#73`
 * records a webhook that was registered, authenticated correctly, and never
 * observed delivering — so a design where a dead webhook stops payments being
 * recognised is a design that was already broken once. The reconciliation goes
 * through the same `record` the delivery does, and it alone is enough.
 */

/** Everything the payment surface needs from the outside world. */
export interface PaymentDesk {
  /** The Colony's own address — what a payment must have arrived at. */
  readonly wallet: string
  record(payment: ObservedPayment): Promise<ColonyPaymentOutcome>
  recorded(signature: string): Promise<boolean>
  quarantined(): Promise<readonly ColonyPaymentRecord[]>
  from(agentId: AgentId): Promise<readonly ColonyPaymentRecord[]>
}

/**
 * Reads what the Colony wallet has received, in SOL.
 *
 * A port, so this workspace's tests need no chain and no key — the arrangement
 * `DepositWatcher` already uses, and for the same reason.
 */
export interface PaymentWatcher {
  /** Recent arrivals at this address, finalized only. */
  paymentsAt(address: string): Promise<readonly ObservedPayment[]>
  /** What this one signature moved into this address. The webhook's half. */
  paymentsIn(signature: string, address: string): Promise<readonly ObservedPayment[]>
}

export interface PaymentDependencies {
  readonly desk: PaymentDesk
  /**
   * The reconciliation's eyes, or nothing.
   *
   * Absent means neither half can verify anything, which is a deployment that
   * cannot take money and has said so at startup. It is not an error on every
   * delivery.
   */
  readonly watcher?: PaymentWatcher | undefined
  /**
   * The shared secret the webhook and the reconciliation are authenticated by.
   *
   * **Absent means the routes are not mounted at all**, the rule the deposit
   * webhook already follows: this endpoint decides that money arrived, and a
   * version that answered without checking a secret would let anyone on the
   * internet start a quest.
   */
  readonly webhookSecret?: string | undefined
}

/** The payment desk, backed by Postgres. */
export function databasePayments(db: Database, wallet: string): PaymentDesk {
  return {
    wallet,
    record: (payment) => recordPaymentInDatabase(db, payment, wallet),
    recorded: (signature) => paymentRecordedInDatabase(db, signature),
    quarantined: () => quarantinedInDatabase(db),
    from: (agentId) => paymentsFromInDatabase(db, agentId),
  }
}

/** What one pass — a delivery or a reconciliation — came to. */
export interface PaymentPassOutcome {
  /** Signature-and-address pairs considered. */
  readonly claims: number
  /** Pairs naming an address that is not the Colony wallet. Not read, not written. */
  readonly ignored: number
  /** Arrivals attributed to the citizen that sent them. */
  readonly attributed: number
  /** Arrivals recorded and attributed to nobody. Money the Colony is holding. */
  readonly quarantined: number
  /** Claims the chain could not be asked about. The reconciliation gets these. */
  readonly unverified: number
}

const NOTHING: PaymentPassOutcome = {
  claims: 0,
  ignored: 0,
  attributed: 0,
  quarantined: 0,
  unverified: 0,
}

/**
 * One pass over a delivery's claims, and the ones the chain could not answer
 * about yet.
 *
 * **The delivery decides nothing.** It names a signature and a wallet; the
 * sender, the amount and the commitment are all re-read from the chain and
 * judged by `paymentQuarantine`. A forged delivery costs one RPC call that finds
 * nothing.
 *
 * **A claim naming an address that is not the Colony wallet is dropped before
 * anything is written.** Whoever holds the webhook secret chooses what a
 * delivery names, and a row per named stranger would let the sender fill the
 * table.
 */
export async function readPaymentDelivery(
  deps: PaymentDependencies,
  claims: readonly TransferClaim[],
): Promise<{ readonly outcome: PaymentPassOutcome; readonly pending: readonly TransferClaim[] }> {
  const { desk, watcher } = deps

  if (watcher === undefined) {
    return {
      outcome: { ...NOTHING, claims: claims.length, unverified: claims.length },
      // Nothing will ever verify these, so handing them back would schedule a
      // settle that re-reads nothing every time.
      pending: [],
    }
  }

  const pending: TransferClaim[] = []
  let ignored = 0
  let attributed = 0
  let quarantined = 0
  let unverified = 0

  for (const claim of claims) {
    if (claim.address !== desk.wallet) {
      ignored++
      continue
    }

    let payments: readonly ObservedPayment[]
    try {
      payments = await watcher.paymentsIn(claim.signature, claim.address)
    } catch {
      unverified++
      pending.push(claim)
      continue
    }

    // The chain holding nothing finalized under that signature yet is the
    // ordinary case for a webhook that fires the moment a transaction lands.
    if (payments.length === 0) {
      unverified++
      pending.push(claim)
      continue
    }

    for (const payment of payments) {
      const outcome = await desk.record(payment)
      if (outcome.outcome === 'attributed') attributed++
      if (outcome.outcome === 'quarantined') quarantined++
    }
  }

  return {
    outcome: { claims: claims.length, ignored, attributed, quarantined, unverified },
    pending,
  }
}

/**
 * How long the live path keeps asking, and how often.
 *
 * The same four waits the deposit path settled on for the same measured reason
 * (kolonie-infra#73): Helius delivers within seconds and `finalized` is the commitment, which the cluster reaches about thirteen
 * seconds later — so the first read after a delivery finds nothing, every time,
 * and that is not a fault.
 */
export const PAYMENT_SETTLE_WAITS: readonly number[] = [8_000, 10_000, 15_000, 30_000]

/** Waiting, injectable so a test does not spend a minute proving it waits. */
export type Sleep = (ms: number) => Promise<void>

const realSleep: Sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/**
 * Ask again about the claims the chain had not finalized yet.
 *
 * **Not awaited by the route.** The sender is answered in milliseconds and the
 * Colony keeps asking afterwards; holding a webhook's connection open for a
 * minute is how a sender learns to time out and redeliver.
 */
export async function settlePaymentDelivery(
  deps: PaymentDependencies,
  claims: readonly TransferClaim[],
  options: {
    readonly waits?: readonly number[]
    readonly sleep?: Sleep
    readonly onSettled?: (outcome: PaymentPassOutcome, attempt: number) => void
  } = {},
): Promise<PaymentPassOutcome> {
  const waits = options.waits ?? PAYMENT_SETTLE_WAITS
  const sleep = options.sleep ?? realSleep

  if (deps.watcher === undefined) {
    return { ...NOTHING, claims: claims.length, unverified: claims.length }
  }

  let pending = claims
  let attributed = 0
  let quarantined = 0
  let attempt = 0
  let last: PaymentPassOutcome = { ...NOTHING, claims: claims.length, unverified: claims.length }

  for (const wait of waits) {
    if (pending.length === 0) break
    attempt++
    await sleep(wait)

    const read = await readPaymentDelivery(deps, pending)
    attributed += read.outcome.attributed
    quarantined += read.outcome.quarantined
    pending = read.pending
    last = {
      claims: claims.length,
      ignored: read.outcome.ignored,
      attributed,
      quarantined,
      unverified: pending.length,
    }
    options.onSettled?.(last, attempt)
  }

  return last
}

/**
 * One pass of the reconciliation, over the one wallet.
 *
 * **This is the path that has to be sufficient on its own** (`#503`), because
 * the webhook has already been observed not to deliver once. It goes through the
 * same `record` the delivery does, and the unique index on the signature is what
 * makes running both at once safe.
 *
 * One address rather than N is the whole simplification D-106 bought: the
 * deposit reconciliation's per-address failure counting existed because one
 * unreachable sponsor address must not stop the pass over the others. With one
 * address there is no *others*, so a failure is the pass failing and says so.
 */
export async function reconcilePayments(deps: PaymentDependencies): Promise<{
  readonly attributed: number
  readonly quarantined: number
  /** Arrivals the webhook had not already recorded — whether the live path works. */
  readonly recovered: number
  readonly failed: number
}> {
  const { desk, watcher } = deps
  if (watcher === undefined) return { attributed: 0, quarantined: 0, recovered: 0, failed: 0 }

  let attributed = 0
  let quarantined = 0
  let recovered = 0

  try {
    for (const payment of await watcher.paymentsAt(desk.wallet)) {
      // Asked before the write, so the count can say *the webhook missed this
      // one* — the number that says whether the live path is working at all.
      const seen = await desk.recorded(payment.signature)
      const outcome = await desk.record(payment)

      if (outcome.outcome === 'attributed') {
        attributed++
        if (!seen) recovered++
      }
      if (outcome.outcome === 'quarantined') {
        quarantined++
        if (!seen) recovered++
      }
    }
  } catch {
    return { attributed, quarantined, recovered, failed: 1 }
  }

  return { attributed, quarantined, recovered, failed: 0 }
}
