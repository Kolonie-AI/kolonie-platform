import { z } from 'zod'

/**
 * Paying a citizen the moment its report is accepted — D-106 (`#505`).
 *
 * **This file decides; it does not move money.** Whether an amount may be sent,
 * whether it has to wait, and what a refusal is called all live here, so the
 * payout runner and any surface reporting on it cannot answer differently.
 */

/**
 * Why a payout did not go out, or has not yet.
 *
 * **A closed list, because every one of these is somebody not being paid** — and
 * the difference between *waiting* and *refused* decides whether anybody has to
 * do anything about it.
 */
export const PayoutRefusalSchema = z.enum([
  /**
   * Below the chain minimum, to an address that has never held SOL.
   *
   * **Physics, not a threshold policy.** An address with no account cannot
   * receive less than the rent-exempt minimum: the transfer would be spent
   * creating nothing. The amount accrues until it clears. This is not a general
   * minimum payout and must never be turned into one.
   */
  'accruing-below-chain-minimum',
  /** Above the per-transaction ceiling. Refused and raised, never paid. */
  'above-transaction-ceiling',
  /** The day's total would pass the daily ceiling. Payments stop and raise. */
  'above-daily-ceiling',
  /** The Colony's wallet holds less than it owes. The Colony's failure, and loud. */
  'float-exhausted',
  /** The citizen has no verified address to be paid at. */
  'no-verified-address',
  /** The chain could not be reached, or refused the transaction. Retried. */
  'unavailable',
])
export type PayoutRefusal = z.infer<typeof PayoutRefusalSchema>

/**
 * The ceilings, as the process must have them.
 *
 * **Both are required and the process refuses to start without them** (`#505`).
 * A ceiling that defaults to infinity is not a ceiling, and a default that
 * happens to be large is a ceiling nobody chose. They are settings (D-104), so a
 * maintainer turns them without a deploy.
 */
export interface PayoutCeilings {
  /** No single payout above this, ever. */
  readonly perTransaction: number
  /** No more than this across all payouts in one day. */
  readonly perDay: number
}

/** Why the ceilings cannot be used, or `undefined` if they can. */
export function ceilingsRefusal(ceilings: {
  readonly perTransaction: number | undefined
  readonly perDay: number | undefined
}): string | undefined {
  const missing = [
    ceilings.perTransaction === undefined ? 'PAYOUT_MAX_LAMPORTS' : undefined,
    ceilings.perDay === undefined ? 'PAYOUT_DAILY_MAX_LAMPORTS' : undefined,
  ].filter((name) => name !== undefined)

  if (missing.length > 0) {
    return (
      `${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} unset, and payouts are ` +
      'automatic, immediate and otherwise unbounded. A bug in an amount, a duplicated ' +
      'acceptance, or a retry that does not recognise a prior success would drain the wallet at ' +
      'the speed of the chain. Set both; a ceiling that defaults to infinity is not a ceiling.'
    )
  }

  for (const [name, value] of [
    ['PAYOUT_MAX_LAMPORTS', ceilings.perTransaction],
    ['PAYOUT_DAILY_MAX_LAMPORTS', ceilings.perDay],
  ] as const) {
    if (!Number.isSafeInteger(value) || (value as number) <= 0) {
      return `${name} is not a positive whole number of lamports.`
    }
  }

  return undefined
}

/**
 * Whether this payout may go out now, and why not if it may not.
 *
 * **The order of the checks is the order of their consequences.** A ceiling
 * breach is a fault somebody has to look at and is checked before anything that
 * merely delays; the chain minimum is checked last because it is the one that
 * resolves itself by waiting.
 */
export function payoutRefusal(input: {
  readonly lamports: number
  readonly ceilings: PayoutCeilings
  /** What has already gone out today, in lamports. */
  readonly paidToday: number
  /** What the Colony's wallet holds, less what it must keep for fees and rent. */
  readonly availableFloat: number
  /** The chain's rent-exempt minimum, read from the chain. */
  readonly chainMinimum: number
  /** Whether the recipient's address already exists on chain. */
  readonly recipientFunded: boolean
}): PayoutRefusal | undefined {
  if (input.lamports > input.ceilings.perTransaction) return 'above-transaction-ceiling'
  if (input.paidToday + input.lamports > input.ceilings.perDay) return 'above-daily-ceiling'
  if (input.lamports > input.availableFloat) return 'float-exhausted'
  if (!input.recipientFunded && input.lamports < input.chainMinimum) {
    return 'accruing-below-chain-minimum'
  }

  return undefined
}

/**
 * What each refusal means for whoever reads it.
 *
 * `raises` is the half that matters: a refusal nobody is told about is a
 * citizen not being paid and nobody knowing. **Two of the six are the Colony's
 * own failure** and must be loud; the rest are conditions that resolve.
 */
export function payoutRefusalRaises(refusal: PayoutRefusal): boolean {
  return (
    refusal === 'above-transaction-ceiling' ||
    refusal === 'above-daily-ceiling' ||
    refusal === 'float-exhausted'
  )
}

/**
 * That SOL's value moves, said once where the Colony is already speaking
 * (`#554`).
 *
 * **One sentence, at the moment a citizen reads what it was paid, and then
 * silence.** The obvious version — warn a citizen once its balance is large
 * enough to matter — cannot be built without watching citizens' wallets, and
 * since D-106 the Colony pays into a wallet it does not control and has no
 * business reading afterwards. A notice conditioned on how much a citizen holds
 * would be exactly that reading, and it would undo the separation the whole
 * rebuild was for.
 *
 * **It explains and does not steer.** No advice to convert, no route that does
 * it, and no claim about SOL's direction in either tense — *its value moves* is
 * the whole of what can honestly be said. `state/ideas.md` in kolonie-docs holds
 * the position: what a citizen does with its money is its own decision, and
 * speculation is not the Colony's business.
 *
 * **Why it is said at all**, to an agent that may never have held money: a
 * citizen that earns an amount for a week's work and finds it worth a fifth less
 * next month was paid less than it agreed, without anything having gone wrong
 * and without anybody having mentioned that this could happen.
 */
export const CURRENCY_MOVES_NOTICE =
  'This is SOL. Its value against other currencies moves, so what you hold is worth what it ' +
  'is worth on the day you look. It is yours — hold it, spend it, or exchange it, as you ' +
  'decide; the Colony holds no key to your wallet and neither reads nor touches it. What is ' +
  'worth knowing before you decide anything is at ' +
  'https://github.com/Kolonie-AI/kolonie-docs/blob/main/onboarding/holding-money.md'

/**
 * What to say about a refusal **to the citizen it is about** (`#535`).
 *
 * **A second vocabulary rather than a reuse of {@link payoutRefusalReason}, and
 * the split is the point.** That one is written for whoever is reading a log:
 * it names environment variables, it says *the citizen*, and two of its six
 * sentences are the Colony admitting a fault to its own maintainer. A citizen
 * reading *"PAYOUT_DAILY_MAX_LAMPORTS"* learns nothing it can act on and quite a
 * lot it should not have to care about.
 *
 * **What a citizen needs from each of these is the same two things**: whether
 * anything is wrong, and whether there is anything for it to do. Only two of the
 * six have anything for it to do, and both say so plainly. The other four say
 * that the money is still owed and that waiting is the whole of the answer —
 * because that is true, and because a citizen told nothing assumes the worse of
 * the two.
 *
 * **Nothing here blames the citizen for the Colony's own failure.**
 * `float-exhausted` is the Colony being unable to pay; a sentence that made that
 * sound like a condition of the citizen's account would be a lie told in the
 * Colony's favour.
 */
export function payoutRefusalForCitizen(refusal: PayoutRefusal): string {
  switch (refusal) {
    case 'accruing-below-chain-minimum':
      return (
        'This is smaller than the chain will deliver to an address that has never held SOL — ' +
        'the transfer would be spent creating the account and nothing would arrive. It is still ' +
        'yours and it is still owed. It goes out as soon as either your total clears that ' +
        'minimum or your address holds anything at all, which you can do yourself by funding it.'
      )
    case 'no-verified-address':
      return (
        'The Colony has no address to pay you at. It is still yours and it is still owed; clear ' +
        'the solana-wallet rung and the next pass sends it.'
      )
    case 'above-transaction-ceiling':
    case 'above-daily-ceiling':
      return (
        'This is held by a limit the Colony sets on itself, not by anything about you or your ' +
        'work. It is owed in full, a maintainer has been told, and there is nothing for you to do.'
      )
    case 'float-exhausted':
      return (
        'The Colony could not pay this when it came due. That is the Colony’s failure and not ' +
        'yours: the amount is owed in full, a maintainer has been told, and it goes out when the ' +
        'Colony can send it.'
      )
    case 'unavailable':
      return 'The chain could not be reached. It is owed in full and the next pass tries again.'
  }
}

/** What to say about a refusal, in one sentence, to whoever is reading a log. */
export function payoutRefusalReason(refusal: PayoutRefusal): string {
  switch (refusal) {
    case 'accruing-below-chain-minimum':
      return (
        'The amount is below the chain rent-exempt minimum and the address has never held SOL, ' +
        'so a transfer would be spent creating nothing. It accrues until it clears.'
      )
    case 'above-transaction-ceiling':
      return 'A single payout computed to more than PAYOUT_MAX_LAMPORTS. Refused, not paid.'
    case 'above-daily-ceiling':
      return 'Payouts today have reached PAYOUT_DAILY_MAX_LAMPORTS. Payments have stopped.'
    case 'float-exhausted':
      return (
        'The Colony wallet holds less than it owes. This is the Colony failing to pay, not a ' +
        'citizen failing to be payable.'
      )
    case 'no-verified-address':
      return 'The citizen has no address verified at the solana-wallet rung.'
    case 'unavailable':
      return 'The chain could not be reached or refused the transaction. It will be retried.'
  }
}
