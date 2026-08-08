import { signSolTransfer } from '@kolonie-ai/core'
import type { Database } from '@kolonie-ai/db'
import {
  earnedFeeLamports,
  lastTreasurySweepAt,
  outstandingObligationLamports,
  recordTreasurySweep,
  sweptToTreasuryLamports,
} from '@kolonie-ai/db'
import { FEE_RESERVE_LAMPORTS, type PayoutChain } from './payouts.js'

/**
 * Moving the Colony's earned fee out of the hot wallet — `#507`.
 *
 * ## The thing that cannot be got wrong
 *
 * **The transfer is one-way and the Treasury key is never on the host.** This
 * module sends *to* `TREASURY_ADDRESS` and holds no key for it. `treasury.test.ts`
 * asserts it on these exports rather than on this sentence, so a later change
 * that reaches for the Treasury fails a test instead of a review.
 *
 * The property is structural rather than careful: {@link TreasurySweepDependencies}
 * carries exactly one secret, it is the payout wallet's, and it is the only
 * value {@link signSolTransfer} is ever given as `fromSeed` here. There is no
 * field a Treasury secret could be put in without changing the type.
 *
 * ## Why this exists
 *
 * `#505` pays a citizen the moment a report is accepted and says the Colony's
 * share *"stays in the Colony wallet and is moved to the Treasury separately,
 * not per report."* Nothing moved it. `governance/treasury.md` divides the money
 * because the Colony's earned funds sit behind a key only the maintainer holds
 * and the hot wallet's key is one a compromised host would surrender — a
 * separation that existed in two addresses and in no transfer.
 */

/** What the sweep needs from storage. A port, so a test needs no PostgreSQL. */
export interface TreasuryDesk {
  /** Everything the Colony has earned in fees, ever. */
  earned(): Promise<number>
  /** Everything already moved to the Treasury. */
  swept(): Promise<number>
  /** What is still owed to citizens — unpaid and unforfeited. */
  owed(): Promise<number>
  /** When the last sweep went out, or `undefined`. */
  lastSweepAt(): Promise<string | undefined>
  /** Write the receipt. `false` where the signature was already recorded. */
  record(transfer: {
    readonly lamports: number
    readonly signature: string
    readonly address: string
  }): Promise<boolean>
}

/** The desk, backed by Postgres. */
export function databaseTreasury(db: Database): TreasuryDesk {
  return {
    earned: () => earnedFeeLamports(db),
    swept: () => sweptToTreasuryLamports(db),
    owed: () => outstandingObligationLamports(db),
    lastSweepAt: () => lastTreasurySweepAt(db),
    record: (transfer) => recordTreasurySweep(db, transfer),
  }
}

export interface TreasurySweepDependencies {
  readonly desk: TreasuryDesk
  readonly chain?: PayoutChain | undefined
  /**
   * The wallet the fee is swept **from**, and the secret that signs for it.
   *
   * **The only secret in this type, and it is the payout wallet's.** A Treasury
   * secret has no field here and must never gain one — the Colony's inability to
   * move funds out of the Treasury is a property of what it holds, not of what
   * it chooses to call.
   */
  readonly wallet?: { readonly address: string; readonly secret: string } | undefined
  /** Where the fee goes. An address, never a key. */
  readonly treasuryAddress?: string | undefined
  /**
   * How long between sweeps, from the settings table (`D-104`).
   *
   * **A reader rather than a number, and that is the whole of what makes it a
   * dial.** A value resolved once at startup is an environment variable with
   * extra steps; this is read on every pass, so a maintainer changing the row
   * changes the next sweep and not the next deploy.
   */
  readonly intervalMs?: (() => Promise<number | undefined>) | undefined
  /** For the interval comparison. Injected so a test needs no clock. */
  readonly now?: () => number
}

/** Why a pass sent nothing. Every one of them is an ordinary state. */
export type SweepRefusal =
  /** No wallet, no endpoint, or no Treasury address. The deployment cannot sweep. */
  | 'not-configured'
  /** The last sweep was more recently than the interval. */
  | 'too-soon'
  /** Earned and swept agree: there is no fee sitting in the wallet. */
  | 'nothing-earned'
  /**
   * The wallet cannot spare it.
   *
   * **This is the refusal that protects citizens** and it is not an error. What
   * is available is the balance minus what is owed minus the float, and a sweep
   * sized by *what is on chain* would take money the Colony owes somebody. The
   * fee stays earned and unswept, and the next pass tries again.
   */
  | 'float-would-not-cover-it'
  /** The transfer could not be built or signed. */
  | 'could-not-sign'

export interface TreasurySweepOutcome {
  /** What went out this pass, in lamports. Zero on every refusal. */
  readonly sweptLamports: number
  readonly signature?: string | undefined
  readonly refusal?: SweepRefusal | undefined
  /** Earned but not yet moved, after this pass. What a maintainer watches. */
  readonly outstandingFeeLamports: number
  /** What the wallet holds, or `null` where it could not be read. */
  readonly heldLamports: number | null
  /** What is owed to citizens, and therefore untouchable. */
  readonly owedLamports: number
}

/**
 * How much of the wallet the Colony may move, given everything it owes.
 *
 * Exported and pure, because it is the whole safety argument and a test should
 * be able to state it without a chain: **what may move is the smaller of what
 * has been earned and what the wallet can spare**, and what it can spare is its
 * balance minus every citizen's claim on it minus the float that pays for the
 * next transfers.
 */
export function sweepableLamports(input: {
  readonly earned: number
  readonly swept: number
  readonly balance: number
  readonly owed: number
  readonly reserve: number
}): number {
  const unswept = Math.max(0, input.earned - input.swept)
  const spare = Math.max(0, input.balance - input.owed - input.reserve)

  return Math.min(unswept, spare)
}

/**
 * One pass: move what may be moved, and say why nothing moved when nothing did.
 *
 * **The interval is read per pass rather than scheduled.** The caller is the
 * same host timer that drives `POST /v1/payouts/run`, and it fires far more
 * often than a sweep should; this decides whether the call sends anything. That
 * is what makes the cadence a row in the settings table rather than a unit file
 * — `D-104`'s rule, and `#507` asks for it by name.
 */
export async function runTreasurySweep(
  deps: TreasurySweepDependencies,
): Promise<TreasurySweepOutcome> {
  const { desk, chain, wallet, treasuryAddress, intervalMs } = deps
  const now = deps.now ?? (() => Date.now())

  const [earned, swept, owed] = await Promise.all([desk.earned(), desk.swept(), desk.owed()])
  const unswept = Math.max(0, earned - swept)

  const nothing = (refusal: SweepRefusal, heldLamports: number | null = null) => ({
    sweptLamports: 0,
    refusal,
    outstandingFeeLamports: unswept,
    heldLamports,
    owedLamports: owed,
  })

  if (chain === undefined || wallet === undefined || treasuryAddress === undefined) {
    return nothing('not-configured')
  }

  /**
   * **Paying yourself is refused one layer down and caught here first.**
   * `signSolTransfer` returns `null` when the two addresses match, so a
   * misconfigured `TREASURY_ADDRESS` would surface as `could-not-sign` — a
   * refusal that reads like a key problem. It is a configuration problem and it
   * is named as one.
   */
  if (treasuryAddress === wallet.address) return nothing('not-configured')

  const interval = intervalMs === undefined ? undefined : await intervalMs()
  if (interval !== undefined && interval > 0) {
    const last = await desk.lastSweepAt()
    if (last !== undefined && now() - Date.parse(last) < interval) return nothing('too-soon')
  }

  if (unswept <= 0) return nothing('nothing-earned')

  const balance = await chain.balance(wallet.address)

  /**
   * **The float that stays behind.** `FEE_RESERVE_LAMPORTS` is the payout path's
   * own reserve — a hundred transfers' worth of fees — and it is reused rather
   * than reinvented, because it reserves for exactly the same thing: the
   * wallet's ability to keep sending. A second constant here would be a second
   * number to get wrong the next time the fee changes.
   *
   * The rent-exempt minimum for a *citizen's first payout* is not added on top.
   * It is the recipient account's cost and `#505` already refuses a payout that
   * cannot cover it; reserving it again here would be reserving twice for one
   * thing and would leave the fee unsweepable at small balances for ever.
   */
  const amount = sweepableLamports({
    earned,
    swept,
    balance,
    owed,
    reserve: FEE_RESERVE_LAMPORTS,
  })

  if (amount <= 0) return nothing('float-would-not-cover-it', balance)

  const signed = signSolTransfer({
    fromSeed: wallet.secret,
    fromAddress: wallet.address,
    toAddress: treasuryAddress,
    lamports: amount,
    recentBlockhash: await chain.latestBlockhash(),
  })

  if (signed === null) return nothing('could-not-sign', balance)

  const signature = await chain.send(signed.transaction)

  /**
   * **Recorded after the send returned a signature, never before.** A receipt
   * written ahead of the transfer would, on a failure, subtract money that never
   * moved — stranding it in the hot wallet permanently, because no later pass
   * would ever count it as sweepable again.
   */
  await desk.record({ lamports: amount, signature, address: treasuryAddress })

  return {
    sweptLamports: amount,
    signature,
    outstandingFeeLamports: Math.max(0, unswept - amount),
    heldLamports: balance - amount,
    owedLamports: owed,
  }
}
