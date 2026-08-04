import { timingSafeEqual } from 'node:crypto'
import {
  DEPOSIT_COMMITMENT,
  SPL_TOKEN_PROGRAM,
  USDC_MINT,
  type AgentId,
  type ApiError,
  type Deposit,
  type ObservedTransfer,
} from '@kolonie-ai/core'
import {
  depositAddressFor as depositAddressInDatabase,
  depositHistory as depositHistoryInDatabase,
  depositRecorded as depositRecordedInDatabase,
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
