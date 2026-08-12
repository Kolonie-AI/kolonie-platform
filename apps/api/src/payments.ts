import type {
  AgentId,
  ObservedPayment,
  PaymentObserver,
  PaymentQuarantine,
  TransferClaim,
} from '@kolonie-ai/core'
import {
  colonyPaymentBySignature as paymentBySignatureInDatabase,
  colonyPaymentRecorded as paymentRecordedInDatabase,
  colonyPaymentsFrom as paymentsFromInDatabase,
  expireUnpaidQuests as expireUnpaidInDatabase,
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
  /**
   * Record an arrival, and which channel saw it (`kolonie-infra#95`).
   *
   * `observedBy` is appended and optional so nothing that merely records a
   * payment has to claim a channel it does not know. The two callers that do
   * know — the delivery and the pass — both pass it, which is what makes *has
   * the webhook ever delivered* a query instead of a journal line.
   */
  record(payment: ObservedPayment, observedBy?: PaymentObserver): Promise<ColonyPaymentOutcome>
  recorded(signature: string): Promise<boolean>
  /**
   * One arrival in full, by the signature that produced it (`#760`).
   *
   * **Not `recorded` with more fields.** That one answers a question the
   * reconciliation asks about its own work — *had the webhook already seen
   * this* — and a boolean is the whole of it. This one is read on behalf of a
   * sponsor asking what became of money it sent, which needs the amount, the
   * date, and whether the row is being held.
   */
  bySignature(signature: string): Promise<ColonyPaymentRecord | undefined>
  quarantined(): Promise<readonly ColonyPaymentRecord[]>
  from(agentId: AgentId): Promise<readonly ColonyPaymentRecord[]>
  /**
   * Return quests nobody paid for to draft — D-106 (`#504`).
   *
   * **On this desk rather than on a timer of its own**, because it is the same
   * subject: a pass over what has and has not been paid. A second unit firing on
   * its own clock would be a second thing to install, enable and notice the
   * failure of, for a sweep that is one statement.
   */
  expireUnpaid(
    now: Date,
  ): Promise<readonly { readonly taskId: string; readonly forfeited: number }[]>
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
    record: (payment, observedBy) => recordPaymentInDatabase(db, payment, wallet, observedBy),
    recorded: (signature) => paymentRecordedInDatabase(db, signature),
    bySignature: (signature) => paymentBySignatureInDatabase(db, signature),
    quarantined: () => quarantinedInDatabase(db),
    from: (agentId) => paymentsFromInDatabase(db, agentId),
    expireUnpaid: (now) => expireUnpaidInDatabase(db, now),
  }
}

/**
 * What the Colony saw of one transfer, as the sponsor that sent it may read
 * it (`#760`).
 *
 * Three states and no fourth: it has not been seen, it was credited, or it is
 * being held. *Seen and credited to somebody else* is deliberately not one of
 * them — see {@link readSponsorPayment}.
 */
export type SponsorPaymentView =
  | {
      readonly outcome: 'unseen'
      readonly signature: string
    }
  | {
      readonly outcome: 'credited'
      readonly signature: string
      readonly lamports: number
      readonly observedAt: string
      readonly attributedAt: string
    }
  | {
      readonly outcome: 'held'
      readonly signature: string
      readonly lamports: number
      readonly sender: string
      readonly observedAt: string
      readonly quarantine: PaymentQuarantine
      /** Whether a maintainer has settled it. What was decided is not published. */
      readonly settled: boolean
    }

/**
 * *Did you see this transfer, and what became of it?* — the question a sponsor
 * had no way to ask (`#760`).
 *
 * D-106 warns a sponsor before it pays that money from an unverified address
 * *"will be held rather than credited"*, and then gives it nothing to check
 * against: from the sponsor's side a quarantined payment is indistinguishable
 * from one that never arrived — the same silence, the same invoice, the same
 * seven-day clock running down.
 *
 * **A row attributed to another citizen answers exactly as one that was never
 * seen.** The signature of a transfer is public and belongs to whoever cares to
 * copy it off the chain, so answering *this one is somebody else's* would turn
 * this into a way of asking whether a given citizen has paid the Colony. It is
 * the `NO_SUCH_QUEST` idiom, for the same reason.
 *
 * **A held row answers fully to anybody who knows its signature**, which is not
 * an inconsistency: it is attributed to nobody, so there is no citizen for the
 * answer to be about. The address it came from is on the chain already, and it
 * is the one fact that tells the sender what to do next.
 */
export async function readSponsorPayment(
  agentId: AgentId,
  signature: string,
  desk: PaymentDesk,
): Promise<SponsorPaymentView> {
  const record = await desk.bySignature(signature)

  if (record === undefined || (record.quarantine === null && record.agentId !== agentId)) {
    return { outcome: 'unseen', signature }
  }

  if (record.quarantine !== null) {
    return {
      outcome: 'held',
      signature,
      lamports: record.lamports,
      sender: record.sender,
      observedAt: record.observedAt,
      quarantine: record.quarantine,
      settled: record.resolvedAt !== null,
    }
  }

  return {
    outcome: 'credited',
    signature,
    lamports: record.lamports,
    observedAt: record.observedAt,
    // Attributed is what `agentId` being set means — the check constraint holds
    // the two together, so this is a narrowing rather than a fallback.
    attributedAt: record.attributedAt ?? record.observedAt,
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
      const outcome = await desk.record(payment, 'webhook')
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
export async function reconcilePayments(
  deps: PaymentDependencies,
  now: Date = new Date(),
): Promise<{
  readonly attributed: number
  readonly quarantined: number
  /** Arrivals the webhook had not already recorded — whether the live path works. */
  readonly recovered: number
  /** Quests whose seven days ran out and went back to draft (`#504`). */
  readonly expired: number
  readonly failed: number
}> {
  const { desk, watcher } = deps

  /**
   * The expiry runs first and runs whether or not there is a watcher.
   *
   * A deployment with no RPC endpoint still has quests waiting for money that
   * will never be recognised, and leaving them waiting for ever would be the
   * worse half of a degraded deployment — the sponsor's text is stuck in a
   * status it cannot edit out of.
   */
  const expired = (await desk.expireUnpaid(now)).length

  if (watcher === undefined) {
    return { attributed: 0, quarantined: 0, recovered: 0, expired, failed: 0 }
  }

  let attributed = 0
  let quarantined = 0
  let recovered = 0

  try {
    for (const payment of await watcher.paymentsAt(desk.wallet)) {
      // Asked before the write, so the count can say *the webhook missed this
      // one* — the number that says whether the live path is working at all.
      const seen = await desk.recorded(payment.signature)
      const outcome = await desk.record(payment, 'reconciliation')

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
    return { attributed, quarantined, recovered, expired, failed: 1 }
  }

  return { attributed, quarantined, recovered, expired, failed: 0 }
}
