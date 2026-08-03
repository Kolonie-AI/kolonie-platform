import { z } from 'zod'

/**
 * The way in: a sponsor sends USDC and its balance answers (`#219`).
 *
 * **Only the way in.** A citizen cannot take money out through anything in this
 * file, and must not be able to — that leg is conditional on the VARA advice
 * `kolonie-docs#129` sequences to it. This is a one-way door and it says so.
 */

/**
 * USDC on Solana mainnet.
 *
 * **Verified against Circle's published contract-address page on 2026-08-03**,
 * at `developers.circle.com/stablecoins/usdc-contract-addresses`, rather than
 * copied from the issue that asked for it: an issue is not a source of truth for
 * an address that money is sent to.
 *
 * Checked on every observed transfer. A transfer of any other SPL token to a
 * deposit address is not credited, is not an error the sponsor sees, and is not
 * swept — an unrecognised token arriving at an address the Colony controls is
 * either a mistake or an attempt to be credited for a worthless mint, and both
 * have the same correct response, which is nothing.
 */
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

/**
 * The SPL Token program USDC is issued under, checked alongside the mint.
 *
 * **Both, because the mint alone is not the token.** A mint address is a
 * public key, and a token whose program is not this one is a different asset
 * that happens to name the same string — Token-2022 introduced transfer hooks
 * and fees, and a balance credited from one of those is a balance the Colony
 * cannot be sure it received in full.
 */
export const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'

/** USDC carries six decimals. */
export const USDC_DECIMALS = 6

/**
 * How many USDC base units are one Quest Credit.
 *
 * A credit is one US cent (`#218`) and USDC has six decimals, so a cent is
 * 10,000 base units. Written as the arithmetic rather than as `10_000` so that a
 * reader can check it: `10 ** 6 / 100`.
 */
export const BASE_UNITS_PER_CREDIT = 10 ** USDC_DECIMALS / 100

/**
 * What a deposit is worth, and what is left over.
 *
 * **Floors, and records the remainder.** Rounding up would mint credits from
 * nothing; discarding the remainder silently would make the deposit total and
 * the credit total disagree with no way to see why. The remainder is stored on
 * the deposit row, so the two columns always add back up to what arrived.
 *
 * Below one cent credits nothing and is not an error: the money arrived, the
 * row records it, and the whole amount is remainder.
 */
export function creditsFromUsdc(baseUnits: number): {
  readonly credits: number
  readonly remainder: number
} {
  const credits = Math.floor(baseUnits / BASE_UNITS_PER_CREDIT)
  return { credits, remainder: baseUnits - credits * BASE_UNITS_PER_CREDIT }
}

/**
 * Why an observed transfer was not credited.
 *
 * **A closed list, because the sponsor reads it.** A deposit that arrived and
 * did not become a balance is the single most alarming thing that can happen on
 * this path, and *"a sponsor whose money vanished into a correct system with no
 * visible record is a sponsor lost for a reason nobody can explain
 * afterwards"*.
 */
export const DepositRejectionSchema = z.enum([
  /** Some other SPL token. Not credited, not swept, not an error. */
  'wrong-mint',
  /** The right mint under the wrong program — see {@link SPL_TOKEN_PROGRAM}. */
  'wrong-token-program',
  /** No identity owns that address. Possible only if an address was reused off-Colony. */
  'unknown-address',
  /** Less than one cent. The money is recorded and the whole of it is remainder. */
  'below-one-cent',
  /** The account was erased between the transfer and the observation. */
  'erased-account',
])
export type DepositRejection = z.infer<typeof DepositRejectionSchema>

/** What the sponsor is told about one arrival, credited or not. */
export const DepositSchema = z.object({
  signature: z.string().min(1).max(120),
  /** What arrived, in USDC base units, exactly as the chain reported it. */
  baseUnits: z.int().min(0),
  credits: z.int().min(0),
  /** The sub-cent part, which is why `credits` may be less than the arithmetic suggests. */
  remainder: z.int().min(0),
  observedAt: z.iso.datetime(),
  creditedAt: z.iso.datetime().nullable(),
  /** Absent on a credited deposit, and required on one that was not. */
  rejection: DepositRejectionSchema.nullable(),
})
export type Deposit = z.infer<typeof DepositSchema>

/**
 * The commitment a credit may be booked at, and the only one.
 *
 * **`finalized`, never `confirmed`.** A confirmed-but-not-finalized transfer can
 * still disappear, and a balance that briefly existed and then did not is worse
 * than one that arrived a few seconds later.
 */
export const DEPOSIT_COMMITMENT = 'finalized'

/**
 * What an observation of the chain says, before the Colony decides anything.
 *
 * A schema and not only a type, because one of its readers is a webhook body
 * from a third party — and the Colony credits balances off it. Everything that
 * decides whether it is really USDC is in here and is checked.
 */
export const ObservedTransferSchema = z.object({
  signature: z.string().min(1).max(120),
  address: z.string().min(1).max(64),
  mint: z.string().min(1).max(64),
  tokenProgram: z.string().min(1).max(64),
  baseUnits: z.int().min(0),
  commitment: z.string().min(1).max(32),
})
export type ObservedTransfer = z.infer<typeof ObservedTransferSchema>

/**
 * Why this transfer may not be credited, or `undefined` if it may.
 *
 * The mint and the program are checked here rather than at the edge, so that
 * every path into the credit — the webhook and the reconciliation job — is
 * checked by the same function. Two implementations of *is this really USDC*
 * would be two answers, and the lenient one would be the one nobody was
 * reading.
 */
export function depositRejection(
  transfer: ObservedTransfer,
): DepositRejection | 'not-final' | undefined {
  if (transfer.commitment !== DEPOSIT_COMMITMENT) return 'not-final'
  if (transfer.mint !== USDC_MINT) return 'wrong-mint'
  if (transfer.tokenProgram !== SPL_TOKEN_PROGRAM) return 'wrong-token-program'
  if (creditsFromUsdc(transfer.baseUnits).credits === 0) return 'below-one-cent'

  return undefined
}
