import { z } from 'zod'

/**
 * Money arriving at the Colony's own wallet, in SOL — D-106 (`#503`).
 *
 * **This file replaces the premise of `deposits.ts` rather than extending it.**
 * There, the Colony generated an address per sponsor and held the key to it;
 * here there is one address, the Colony's own, and every other party keeps its
 * own money. A payment is recognised **by its sender**, which is the whole
 * mechanism — no memos, no references, and no per-sponsor keypair.
 *
 * **Nothing in this file moves value out.** What leaves the Colony wallet is
 * `#505` paying a citizen and `#507` moving the earned fee to the Treasury, both
 * of which send from a key the Colony genuinely owns. The property that is gone
 * for good is the Colony holding a key to somebody *else's* money.
 */

/** Lamports in one SOL. Nine decimals, fixed by the chain. */
export const LAMPORTS_PER_SOL = 1_000_000_000

/**
 * The variable carrying the Colony wallet's public address.
 *
 * **A name, and never a value.** The address itself is a live financial address
 * and is deliberately in no repository — it is on the deploy host and in the
 * register of facts kept outside the repositories (`#503`).
 */
export const PAYOUT_WALLET_ADDRESS_VAR = 'PAYOUT_WALLET_ADDRESS'

/**
 * The variable carrying the Colony wallet's secret.
 *
 * **The raw 32-byte Ed25519 seed, base58** — the shape `generateDepositKeypair`
 * produced, and *not* the 64-byte `[seed || pubkey]` array `solana-keygen`,
 * Phantom and `Keypair.fromSecretKey` expect. Anything that signs with it
 * expands the seed first.
 *
 * Getting that wrong does not throw. It produces a different keypair, and
 * therefore a different address, and the first symptom is a transfer signed by
 * an account holding nothing — which is why {@link payoutWalletMismatch} exists
 * and is checked at startup rather than at the first payout.
 */
export const PAYOUT_WALLET_SECRET_VAR = 'PAYOUT_WALLET_SECRET'

/**
 * The variable carrying the Treasury's public address (`kolonie-docs#202`).
 *
 * **Only ever an address.** The Colony sends to it and holds no key for it; the
 * seed phrase is the maintainer's and is in the succession arrangement. `#507`
 * asserts on its own exports that no path can send *from* it.
 */
export const TREASURY_ADDRESS_VAR = 'TREASURY_ADDRESS'

/**
 * The commitment a payment may be recognised at, and the only one.
 *
 * `finalized`, for the reason `DEPOSIT_COMMITMENT` gives: a confirmed transfer
 * can still disappear, and a quest that went live on money that evaporated is
 * worse than one that went live thirteen seconds later.
 */
export const PAYMENT_COMMITMENT = 'finalized'

/**
 * Why an arrival at the Colony wallet could not be attributed to anybody.
 *
 * **A closed list, because a maintainer resolves these by hand.** Quarantined
 * money is the Colony holding something it cannot honour, and the reason is what
 * decides whether the answer is *ask the sender for its verified address* or
 * *this was never a payment at all*.
 */
export const PaymentQuarantineSchema = z.enum([
  /**
   * The sender is not an address any citizen has proved it controls.
   *
   * The commonest cause is the one D-106 warns sponsors about before they pay:
   * an exchange withdrawal arrives from the exchange's hot wallet, so the money
   * is real and the payer is invisible.
   */
  'unverified-sender',
  /**
   * The sender is the Colony's own wallet.
   *
   * A refund, a sweep, or a test paying itself. It is not income and must never
   * be attributed — most of all not to whichever citizen once verified an
   * address the Colony happens to hold.
   */
  'colony-sender',
])
export type PaymentQuarantine = z.infer<typeof PaymentQuarantineSchema>

/**
 * What an observation of the chain says, before the Colony decides anything.
 *
 * A schema and not only a type, for the reason `ObservedTransferSchema` is one:
 * one of its readers is a webhook body from a third party, and a quest goes live
 * off what it says. Everything the attribution rests on is in here and is
 * checked.
 */
export const ObservedPaymentSchema = z.object({
  signature: z.string().min(1).max(120),
  /** The address the lamports came from — the whole of the attribution. */
  sender: z.string().min(1).max(64),
  /** The Colony wallet they arrived at, so a misdirected read cannot be credited. */
  recipient: z.string().min(1).max(64),
  /** What arrived, in lamports, exactly as the chain reported it. */
  lamports: z.int().min(0),
  commitment: z.string().min(1).max(32),
})
export type ObservedPayment = z.infer<typeof ObservedPaymentSchema>

/**
 * What recognising one arrival came to.
 *
 * `quarantined` is not an error and not a loss: the row exists, the amount is on
 * it, and a maintainer can read it. What it is not is money anybody's quest can
 * spend.
 */
export const PaymentOutcomeSchema = z.enum([
  'attributed',
  'quarantined',
  /** Seen before. Webhook redelivery is normal operation, not an incident. */
  'already-recorded',
  /** Not `finalized`. Nothing is written at all — the transfer may still vanish. */
  'not-final',
])
export type PaymentOutcome = z.infer<typeof PaymentOutcomeSchema>

/**
 * Why this payment may not be attributed, or `undefined` if it may.
 *
 * **The decision lives here and not at either edge**, so the webhook and the
 * reconciliation cannot answer it differently — the same rule `depositRejection`
 * was written under, and the same reason: two implementations of *may this be
 * credited* are two answers, and the lenient one is the one nobody reads.
 *
 * `sender` is looked up by the caller because that is a database question. What
 * this function owns is what the answer means.
 */
export function paymentQuarantine(
  payment: ObservedPayment,
  sender: {
    /**
     * Whether some citizen has cleared the `solana-wallet` rung with this
     * address.
     *
     * **There is no separate *erased* case and there must not be one.** Erasure
     * deletes the agent row and the challenge cascades with it, so a payment
     * from a citizen that has left is indistinguishable from one from a stranger
     * — which is the correct answer rather than a gap. A reason the code cannot
     * reach is a reason nobody can act on.
     */
    readonly verified: boolean
  },
  colonyAddress: string,
): PaymentQuarantine | 'not-final' | undefined {
  if (payment.commitment !== PAYMENT_COMMITMENT) return 'not-final'
  // Checked before the sender lookup, because the Colony's own address may
  // itself be a verified one and a sweep must never look like income.
  if (payment.sender === colonyAddress) return 'colony-sender'
  if (!sender.verified) return 'unverified-sender'

  return undefined
}

/**
 * Whether the secret on the host derives the address on the host.
 *
 * **Checked at startup and never later.** A mismatch is a deployment that will
 * sign every transfer with a keypair holding nothing, and the failure it
 * produces at the first payout — *insufficient funds* on an account nobody
 * recognises — costs an hour to read back to its cause. `#503` asks for the
 * process to refuse to start, which is what the caller does with this.
 *
 * Returns the reason, or `undefined` when the two agree. A reason rather than a
 * boolean because the two ways this goes wrong want different fixes: a secret in
 * the wrong encoding is a conversion, and a secret from the wrong wallet is a
 * lost key.
 */
export function payoutWalletMismatch(declared: string, derived: string | null): string | undefined {
  if (derived === null) {
    return (
      `${PAYOUT_WALLET_SECRET_VAR} is not a base58 32-byte Ed25519 seed. It is the raw seed ` +
      `and not the 64-byte secret key a wallet exports; a value in that shape has to be cut ` +
      `to its first 32 bytes before it can be used here.`
    )
  }

  if (derived !== declared) {
    return (
      `${PAYOUT_WALLET_SECRET_VAR} derives an address that is not ${PAYOUT_WALLET_ADDRESS_VAR}. ` +
      `One of the two is from a different wallet, and signing with this pair would produce ` +
      `transfers from an account the Colony has never funded.`
    )
  }

  return undefined
}

/**
 * Lamports as SOL, for a sentence a person reads.
 *
 * **Never for arithmetic.** Every amount the Colony books, compares or sends is
 * in lamports and is an integer, because a payment threshold decided in floating
 * point is a payment that is occasionally one lamport short.
 */
export function solFromLamports(lamports: number): string {
  const whole = Math.trunc(lamports / LAMPORTS_PER_SOL)
  const fraction = String(Math.abs(lamports % LAMPORTS_PER_SOL)).padStart(9, '0')

  return `${whole}.${fraction.replace(/0+$/, '') || '0'}`
}
