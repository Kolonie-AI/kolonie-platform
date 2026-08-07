import { timingSafeEqual } from 'node:crypto'
import {
  DEPOSIT_COMMITMENT,
  SPL_TOKEN_PROGRAM,
  USDC_MINT,
  type AgentId,
  type ApiError,
  type Deposit,
  type ObservedTransfer,
  type TransferClaim,
} from '@kolonie-ai/core'
import {
  depositAddressFor as depositAddressInDatabase,
  depositHistory as depositHistoryInDatabase,
  depositRecorded as depositRecordedInDatabase,
  existingDepositAddress as existingAddressInDatabase,
  recordDeposit as recordDepositInDatabase,
  watchedDepositAddresses as watchedAddressesInDatabase,
  type Database,
  type DepositAddressOutcome,
  type DepositOutcome,
} from '@kolonie-ai/db'

/**
 * The way in (`#219`): a sponsor sends USDC to its own address, and its balance
 * answers without a steward typing a number.
 *
 * **A deposit is watched, not polled.** A webhook carries the live path and a
 * reconciliation job re-reads each address's recent signatures on a schedule,
 * crediting anything the webhook missed. The reconciliation is what makes a
 * missed webhook a *delay* rather than a loss, and it goes through the same
 * function as the live path — the same one, not a second implementation.
 */

/** Everything the deposit surface needs from the outside world. */
export interface DepositDesk {
  address(agentId: AgentId): Promise<DepositAddressOutcome>
  history(agentId: AgentId): Promise<readonly Deposit[]>
  /**
   * The address this identity already holds, and never a new one (`#470`).
   *
   * A separate method rather than an option on `address`, because the two have
   * different rights: `address` may be called by an identity acting for itself,
   * and this one is what a reader gets. The agent page is a window (`#457`), so
   * it reads through here and cannot create a keypair even by mistake.
   */
  existing(agentId: AgentId): Promise<string | undefined>
  record(transfer: ObservedTransfer): Promise<DepositOutcome>
  watched(): Promise<readonly string[]>
  recorded(signature: string): Promise<boolean>
}

/**
 * Reads what an address has received.
 *
 * A port, so this workspace's tests need no chain and no key — the same
 * arrangement `packages/verifiers` uses for every RPC it makes.
 */
export interface DepositWatcher {
  /** Recent transfers at this address, finalized ones included. */
  transfersAt(address: string): Promise<readonly ObservedTransfer[]>
  /**
   * What this one signature moved into this address, read from the chain.
   *
   * The webhook's half of the port (`#321`). A Helius delivery names a
   * signature and a wallet and carries neither the token program nor a
   * commitment, so the delivery is a *trigger* and this is the answer: the same
   * finalized read the reconciliation makes, aimed at one signature instead of
   * an address's recent history.
   */
  transfersIn(signature: string, address: string): Promise<readonly ObservedTransfer[]>
}

export interface DepositDependencies {
  readonly desk: DepositDesk
  /**
   * The reconciliation's eyes, or nothing.
   *
   * Absent means the job does not run and the webhook still does — a deployment
   * with a webhook and no RPC endpoint is degraded rather than broken, and
   * saying so is better than a job that throws on a schedule.
   */
  readonly watcher?: DepositWatcher | undefined
  /**
   * The shared secret the webhook is authenticated by.
   *
   * **Absent means the route is not mounted at all**, which is the rule
   * `registerInboundMailRoute` already follows and for the same reason: this
   * endpoint turns *money arrived* into a balance, and a version that answered
   * without checking a secret would let anyone on the internet credit any
   * account by asserting a transfer that never happened.
   */
  readonly webhookSecret?: string | undefined
}

/** The deposit desk, backed by Postgres. */
export function databaseDeposits(db: Database, sealingKey: string): DepositDesk {
  return {
    address: (agentId) => depositAddressInDatabase(db, { agentId, sealingKey }),
    history: (agentId) => depositHistoryInDatabase(db, agentId),
    existing: (agentId) => existingAddressInDatabase(db, agentId),
    record: (transfer) => recordDepositInDatabase(db, transfer),
    watched: () => watchedAddressesInDatabase(db),
    recorded: (signature) => depositRecordedInDatabase(db, signature),
  }
}

/** What a sponsor is told when it asks where to send money. */
export interface DepositAddressResponse {
  readonly address: string
  /** The one asset this address credits, so nobody has to look it up. */
  readonly mint: string
  readonly tokenProgram: string
  readonly commitment: string
  /** Said before the sponsor deposits, because it cannot be undone afterwards. */
  readonly notice: string
}

/**
 * The sentence that has to appear before anybody sends anything.
 *
 * **No refunds, and it is not a policy hidden in a document.** A funded balance
 * is not returned to the sponsor's wallet — that is the payout leg wearing a
 * different name, and it is conditional on advice nobody has yet.
 */
export const DEPOSIT_NOTICE =
  'Send only USDC on Solana to this address, and only from a wallet you control. It credits ' +
  'your Colony balance once the transfer is finalized. Credits cannot be sent back out: the ' +
  'way out is not built, and a funded balance stays a balance until you spend it on a quest.'

/**
 * The refusal an account gets before anybody has followed its sign-in link.
 *
 * `conflict` rather than `unauthorized`: the caller is authenticated and is who
 * it says it is. What is missing is a fact about the account, and the remedy is
 * an action — open the mail — rather than a different credential.
 */
export const ADDRESS_UNCONFIRMED: ApiError = {
  code: 'conflict',
  message:
    'This account was opened from the console and its address has not been confirmed yet. ' +
    'Follow the sign-in link that was mailed to it; nothing can be funded until somebody has.',
}

export async function readDepositAddress(
  agentId: AgentId,
  desk: DepositDesk,
): Promise<DepositAddressResponse | { readonly error: ApiError }> {
  const issued = await desk.address(agentId)

  // `#266`: an account nobody has confirmed gets no address, which is where the
  // on-chain half of *confirmed before funded* is actually enforced. See
  // `depositAddressFor`.
  if (issued.outcome === 'address-unconfirmed') return { error: ADDRESS_UNCONFIRMED }

  return {
    address: issued.address,
    mint: USDC_MINT,
    tokenProgram: SPL_TOKEN_PROGRAM,
    commitment: DEPOSIT_COMMITMENT,
    notice: DEPOSIT_NOTICE,
  }
}

/** Every arrival, credited or not, with the reason on the ones that were not. */
export async function readDepositHistory(
  agentId: AgentId,
  desk: DepositDesk,
): Promise<{ readonly deposits: readonly Deposit[] }> {
  return { deposits: await desk.history(agentId) }
}

/**
 * Whether this caller may deliver a webhook.
 *
 * Compared in constant time, because a secret compared with `===` leaks its
 * prefix to anybody willing to time the answer — and this is the endpoint that
 * credits balances.
 */
export function webhookAuthorised(presented: string | undefined, secret: string): boolean {
  if (presented === undefined) return false

  const a = Buffer.from(presented)
  const b = Buffer.from(secret)

  // `timingSafeEqual` throws on a length mismatch, which would itself be a
  // timing signal. The length check is done first and deliberately: it leaks the
  // length of the secret and nothing about its contents.
  return a.length === b.length && timingSafeEqual(a, b)
}

export const WEBHOOK_REFUSED: ApiError = {
  code: 'unauthorized',
  message: 'This endpoint is not for you.',
}

/**
 * What one delivery did, for whoever is reading the logs.
 *
 * Counted rather than listed: a webhook's answer is read by a machine that
 * retries and by a human looking for whether the live path works at all, and
 * neither needs the signatures back.
 */
export interface DeliveryOutcome {
  /** Signature-and-address pairs the delivery named. */
  readonly claims: number
  /** Pairs naming an address the Colony did not generate. Not read, not written. */
  readonly ignored: number
  /** Transfers the chain confirmed and the ledger credited. */
  readonly credited: number
  /** Transfers recorded and refused — the wrong mint, the wrong program, under a cent. */
  readonly rejected: number
  /** Claims the chain could not be asked about. The reconciliation gets these. */
  readonly unverified: number
}

/**
 * A Helius delivery, verified against the chain and credited (`#321`).
 *
 * **The delivery decides nothing.** It names a signature and a wallet; every
 * fact the credit rests on — the mint, the token program, the amount in base
 * units, the commitment — is re-read through {@link DepositWatcher} and judged
 * by the same `depositRejection` the reconciliation goes through. That is what
 * makes a forged delivery harmless: at worst it costs one RPC call that finds
 * nothing.
 *
 * **A claim that cannot be verified is left to the reconciliation rather than
 * failed.** No RPC endpoint configured, an endpoint that is down, a signature
 * the cluster has not finalized yet — all three mean *not yet*, and
 * kolonie-infra#72's hourly pass credits them within the hour. Answering the
 * sender an error would teach it to retry a body that is not the problem.
 *
 * **Unwatched addresses are dropped before anything is written.** Whoever holds
 * the webhook secret chooses which addresses a delivery names, and a row per
 * named stranger would let the sender fill the deposits table. `unknown-address`
 * stays reachable through `record` for an address erased between the two reads.
 */
export async function recordDelivery(
  deps: DepositDependencies,
  claims: readonly TransferClaim[],
): Promise<DeliveryOutcome> {
  return (await readDelivery(deps, claims)).outcome
}

/**
 * One pass over a delivery's claims, and the ones the chain could not answer
 * about yet.
 *
 * The pending list is what {@link settleDelivery} needs and what
 * {@link recordDelivery} throws away. It is a separate function rather than a
 * wider return type on `recordDelivery` because the counts are what a sender and
 * a log line read, and a caller that wanted the claims back would otherwise have
 * to reconstruct them from a number.
 */
export async function readDelivery(
  deps: DepositDependencies,
  claims: readonly TransferClaim[],
): Promise<{ readonly outcome: DeliveryOutcome; readonly pending: readonly TransferClaim[] }> {
  const { desk, watcher } = deps

  if (watcher === undefined) {
    return {
      outcome: {
        claims: claims.length,
        ignored: 0,
        credited: 0,
        rejected: 0,
        unverified: claims.length,
      },
      // No watcher is a deployment that cannot verify anything, ever. Handing
      // these back would schedule a settle that re-reads nothing every time.
      pending: [],
    }
  }

  const watched = new Set(await desk.watched())
  const pending: TransferClaim[] = []
  let ignored = 0
  let credited = 0
  let rejected = 0
  let unverified = 0

  for (const claim of claims) {
    if (!watched.has(claim.address)) {
      ignored++
      continue
    }

    let transfers: readonly ObservedTransfer[]
    try {
      transfers = await watcher.transfersIn(claim.signature, claim.address)
    } catch {
      unverified++
      pending.push(claim)
      continue
    }

    // The chain holding nothing finalized under that signature yet is the
    // ordinary case for a webhook that fires the moment a transaction lands.
    if (transfers.length === 0) {
      unverified++
      pending.push(claim)
      continue
    }

    for (const transfer of transfers) {
      const outcome = await desk.record(transfer)
      if (outcome.outcome === 'credited') credited++
      if (outcome.outcome === 'refused') rejected++
    }
  }

  return {
    outcome: { claims: claims.length, ignored, credited, rejected, unverified },
    pending,
  }
}

/**
 * How long the live path keeps asking, and how often (kolonie-infra#73).
 *
 * **This is the difference between a webhook that credits and one that only
 * looks like it does.** Helius delivers within seconds of a transaction landing
 * and `DEPOSIT_COMMITMENT` is `finalized`, which Solana reaches roughly thirteen
 * seconds later — so the first read after a delivery finds nothing, every time,
 * for reasons that are not a fault. Measured on 2026-08-07: the delivery arrived
 * eight seconds after the transfer, answered `200` with `unverified: 1`, wrote
 * nothing, and the deposit waited fifty-seven minutes for the hourly pass.
 *
 * Four waits over one minute, because finalization is the only thing being
 * waited for and it either happens in that window or something is wrong that
 * more waiting will not fix. `reconcileDeposits` remains the backstop for
 * everything this misses, including a restart mid-settle.
 */
export const DELIVERY_SETTLE_WAITS: readonly number[] = [8_000, 10_000, 15_000, 30_000]

/** Waiting, injectable so a test does not spend a minute proving it waits. */
export type Sleep = (ms: number) => Promise<void>

const realSleep: Sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/**
 * Ask again about the claims the chain had not finalized yet.
 *
 * **Not awaited by the route, on purpose.** The sender gets its `200` in
 * milliseconds and the Colony keeps asking after the answer has gone out;
 * holding a webhook's connection open for a minute is how a sender learns to
 * time out and retry, which would deliver the same claims again rather than
 * sooner.
 *
 * Stops as soon as nothing is pending. Anything still pending at the end is the
 * reconciliation's, exactly as before.
 */
export async function settleDelivery(
  deps: DepositDependencies,
  claims: readonly TransferClaim[],
  options: {
    readonly waits?: readonly number[]
    readonly sleep?: Sleep
    readonly onSettled?: (outcome: DeliveryOutcome, attempt: number) => void
  } = {},
): Promise<DeliveryOutcome> {
  const waits = options.waits ?? DELIVERY_SETTLE_WAITS
  const sleep = options.sleep ?? realSleep

  // Nothing to ask, so nothing is waited for: a deployment with no RPC endpoint
  // leaves every claim to the reconciliation and says so immediately.
  if (deps.watcher === undefined) {
    return {
      claims: claims.length,
      ignored: 0,
      credited: 0,
      rejected: 0,
      unverified: claims.length,
    }
  }

  let pending = claims
  let credited = 0
  let rejected = 0
  let attempt = 0
  let last: DeliveryOutcome = {
    claims: claims.length,
    ignored: 0,
    credited: 0,
    rejected: 0,
    unverified: claims.length,
  }

  for (const wait of waits) {
    if (pending.length === 0) break
    attempt++
    await sleep(wait)

    const read = await readDelivery(deps, pending)
    credited += read.outcome.credited
    rejected += read.outcome.rejected
    pending = read.pending
    last = {
      claims: claims.length,
      ignored: read.outcome.ignored,
      credited,
      rejected,
      unverified: pending.length,
    }
    options.onSettled?.(last, attempt)
  }

  return last
}

/**
 * One pass of the reconciliation.
 *
 * **The same `record` the webhook calls**, so a missed delivery and a live one
 * cannot be credited differently — and the idempotency that makes redelivery
 * safe is the same unique index that makes this safe.
 *
 * Its own failures are swallowed per address: an endpoint that cannot answer
 * about one address must not stop the pass over the others, and the next run
 * picks it up.
 */
export async function reconcileDeposits(deps: DepositDependencies): Promise<{
  readonly addresses: number
  readonly credited: number
  readonly recovered: number
  readonly failed: number
}> {
  const { desk, watcher } = deps
  if (watcher === undefined) return { addresses: 0, credited: 0, recovered: 0, failed: 0 }

  const addresses = await desk.watched()
  let credited = 0
  let recovered = 0
  let failed = 0

  for (const address of addresses) {
    try {
      for (const transfer of await watcher.transfersAt(address)) {
        // Asked before the write so the count can say *the webhook missed this
        // one*, which is the number that says whether the webhook is working.
        const seen = await desk.recorded(transfer.signature)
        const outcome = await desk.record(transfer)

        if (outcome.outcome === 'credited') {
          credited++
          if (!seen) recovered++
        }
      }
    } catch {
      failed++
    }
  }

  return { addresses: addresses.length, credited, recovered, failed }
}
