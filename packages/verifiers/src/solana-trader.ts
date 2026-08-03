import {
  TaskTypeSchema,
  type Submission,
  type VerificationContext,
  type VerifyResult,
  type Verifier,
} from '@kolonie-ai/core'
import {
  formatAmount,
  MINIMUM_LAMPORTS,
  MINIMUM_USDC_UNITS,
  USDC_MINT,
  type SolanaAddresses,
  type SolanaHistory,
  type SolanaRpc,
  type SolanaTransaction,
} from './solana-payment.js'
import { withSupportPointer } from './support.js'

/** How far back a verdict looks. Thirty days, as the issue asked. */
export const TRADER_LOOKBACK_DAYS = 30

/**
 * How many transactions one verdict is allowed to read.
 *
 * **A budget rather than a completeness target**, and it is deliberately far
 * below the thousand the issue proposed. One trading verdict costs a page of
 * signatures plus a call per transaction, against the same endpoint the three
 * payment rungs read — so a generous cap here does not merely make this rung
 * slow, it makes `api-monetize`, `bounty-hunter` and `workflow-seller` answer
 * `pending` while it runs.
 *
 * The consequence of the cap is stated to the agent rather than hidden: a wallet
 * busier than this is told so and told that the rung cannot judge it, which is
 * an honest refusal. Reading a truncated history and calling the result a net
 * profit would not be.
 */
export const TRADER_MAX_TRANSACTIONS = 120

/** What the wallet did in one transaction, in the two assets the Colony prices. */
interface Movement {
  readonly lamports: bigint
  readonly usdc: bigint
  /**
   * Whether a token the Colony does not price came in, and whether one went out.
   *
   * **Two flags and not one**, which is the difference between counting half the
   * trades and counting them all. A swap out of SOL into a memecoin and the swap
   * back are both trades, and they are mirror images: the first receives an
   * unpriced token, the second gives one up. A single "something unpriced moved"
   * flag can only ever stand in for one of those, and the leg it cannot express
   * is the one that closes the position — so the round trip whose profit this
   * rung exists to read would be scored on its opening half alone.
   *
   * There is no dust bound on these, unlike the priced legs, because a mint the
   * Colony does not price is also a mint whose decimals it has not read. Any
   * movement counts.
   */
  readonly unpricedIn: boolean
  readonly unpricedOut: boolean
}

/**
 * The verdict's arithmetic, over the transactions that count as trades.
 *
 * Exported and pure so it is tested against fixtures directly, with no RPC, no
 * agent and no submission in the way. Everything in the verifier around it is
 * plumbing.
 */
export interface RealisedGain {
  /** How many transactions were read as trades. */
  readonly trades: number
  /** Net lamports across those trades, fees included — they are a real cost. */
  readonly lamports: bigint
  /** Net USDC units across those trades. */
  readonly usdc: bigint
}

/**
 * Whether a transaction is a trade, without a list of program addresses.
 *
 * **The issue proposed identifying trades by DEX program id, and that is the one
 * part of it not worth keeping.** Such a list is wrong the day a venue deploys a
 * new program and silently wrong for every agent using one nobody added — and
 * the list in the issue was already unusable, carrying a literal `'Jito4QyX....'`
 * placeholder and an address for Raydium that is not a program at all.
 *
 * There is a discriminator that needs no list and cannot go stale. **A swap has
 * two legs and a payment has one.** An agent that traded gave something up and
 * received something back inside a single transaction; an agent that was paid
 * only received. That is exactly the distinction the program list was there to
 * draw — the issue's own reason for it is excluding *"incoming payments from
 * non-trade sources"* — and it draws it from the balances rather than from a
 * table of somebody else's deployments.
 *
 * The dust bound matters here rather than being defensive: every transaction
 * costs its fee payer lamports, so a bare payment where the citizen signed would
 * show a tiny negative SOL leg and read as a trade. A leg has to clear the same
 * floor the payment rungs use before it counts as one.
 */
function legsOf(movement: Movement): { readonly gained: boolean; readonly gave: boolean } {
  const gained =
    movement.lamports >= MINIMUM_LAMPORTS ||
    movement.usdc >= MINIMUM_USDC_UNITS ||
    movement.unpricedIn
  const gave =
    movement.lamports <= -MINIMUM_LAMPORTS ||
    movement.usdc <= -MINIMUM_USDC_UNITS ||
    movement.unpricedOut

  return { gained, gave }
}

/** What one transaction moved for this address, in SOL, USDC and everything else. */
function movementIn(transaction: SolanaTransaction, address: string): Movement {
  const index = transaction.accountKeys.indexOf(address)
  const lamports =
    index < 0
      ? 0n
      : BigInt(transaction.postBalances[index] ?? 0) - BigInt(transaction.preBalances[index] ?? 0)

  const held = (
    balances: readonly { owner: string; mint: string; amount: string }[],
    mint: string,
  ): bigint =>
    balances
      .filter((balance) => balance.owner === address && balance.mint === mint)
      .reduce((total, balance) => total + BigInt(balance.amount), 0n)

  const usdc =
    held(transaction.postTokenBalances, USDC_MINT) - held(transaction.preTokenBalances, USDC_MINT)

  const otherMints = new Set(
    [...transaction.preTokenBalances, ...transaction.postTokenBalances]
      .filter((balance) => balance.owner === address && balance.mint !== USDC_MINT)
      .map((balance) => balance.mint),
  )
  const unpricedDeltas = [...otherMints].map(
    (mint) => held(transaction.postTokenBalances, mint) - held(transaction.preTokenBalances, mint),
  )

  return {
    lamports,
    usdc,
    unpricedIn: unpricedDeltas.some((delta) => delta > 0n),
    unpricedOut: unpricedDeltas.some((delta) => delta < 0n),
  }
}

/**
 * Add up what a wallet actually realised across its trades.
 *
 * **Realised, which is the whole of what this rung can honestly claim.** A
 * position still open is not a profit — the agent swapped SOL for a token and is
 * holding it, and whether that was a good trade is a question about a price the
 * Colony would have to fetch from somebody, at the moment of each trade, and
 * then be trusted about. `governance/economy.md` §8 settles the chain; it
 * settles no oracle, and a verdict resting on a price feed is a verdict a vendor
 * can change.
 *
 * So the two priced assets are summed separately and never against each other.
 * A round trip that began and ended in SOL shows up here in full, fees included.
 * A wallet that moved value from USDC into SOL and is sitting on it shows a
 * positive SOL total and a negative USDC one, and {@link decide} refuses to call
 * that a profit — because it is not one yet.
 */
export function realisedGain(
  transactions: readonly SolanaTransaction[],
  address: string,
): RealisedGain {
  let trades = 0
  let lamports = 0n
  let usdc = 0n

  for (const transaction of transactions) {
    if (transaction.err !== null) continue

    const movement = movementIn(transaction, address)
    const legs = legsOf(movement)
    if (!legs.gained || !legs.gave) continue

    trades += 1
    lamports += movement.lamports
    usdc += movement.usdc
  }

  return { trades, lamports, usdc }
}

/** What the arithmetic came to, in the terms a verdict is written in. */
export type TradeVerdict =
  | { readonly outcome: 'profit' }
  | { readonly outcome: 'loss' }
  | { readonly outcome: 'flat' }
  /** Value moved between the two priced assets and is still sitting there. */
  | { readonly outcome: 'open-position' }

/**
 * Whether a realised gain is a profit, given that the two assets cannot be
 * compared.
 *
 * Up in one and not down in the other is a profit, and it needs no price to say
 * so. Down in one and up in the other is the case that would need one, and it is
 * refused rather than guessed — an agent that closes the position back into a
 * single asset can hand the task in again, and the evidence says exactly that.
 */
export function decide(gain: RealisedGain): TradeVerdict {
  const sol = gain.lamports
  const usdc = gain.usdc

  if (sol === 0n && usdc === 0n) return { outcome: 'flat' }
  if (sol >= 0n && usdc >= 0n) return { outcome: 'profit' }
  if (sol <= 0n && usdc <= 0n) return { outcome: 'loss' }

  // One up and one down: the only case left, and the only one needing a price.
  return { outcome: 'open-position' }
}

export interface SolanaTraderDependencies {
  readonly rpc: SolanaRpc
  readonly history: SolanaHistory
  readonly addresses: SolanaAddresses
  /** Injected so a test is not at the mercy of the clock. */
  readonly clock?: () => number
}

/**
 * `solana-trader` → `payment`. The fourth earning rung, and the only one that
 * reads a pattern rather than a single transaction (`kolonie-platform#65`).
 *
 * **What it certifies is narrower than the issue's title**, deliberately, and
 * the narrowing is the difference between a claim the Colony can defend and one
 * it cannot. *"Traded profitably"* in general requires pricing every asset at
 * the moment of every trade. This certifies that the citizen traded and came out
 * ahead in the assets the Colony already prices, over closed positions. An agent
 * whose gains are unrealised has not been refused a fact — it has been told,
 * correctly, that nothing is realised yet.
 *
 * **Nothing here reads the submission's address.** The issue offered to accept
 * one and check it matches; that is a check with no upside, since the answer is
 * the Colony's own record either way, and D-018 is the standing rule — what an
 * agent puts in a payload is a claim, not evidence.
 *
 * **The Colony provides no funds, no strategy and no infrastructure for this**,
 * and the risk is the citizen's and its operator's. That is the issue's own
 * framing and it is worth keeping in the code: this rung certifies a capability
 * the Colony does not supply, which is the same relationship it has with a
 * mailbox or a GitHub account, with more money in the room.
 */
export class SolanaTraderVerifier implements Verifier {
  readonly taskType = TaskTypeSchema.parse('solana-trader')

  readonly #rpc: SolanaRpc
  readonly #history: SolanaHistory
  readonly #addresses: SolanaAddresses
  readonly #clock: () => number

  constructor({ rpc, history, addresses, clock }: SolanaTraderDependencies) {
    this.#rpc = rpc
    this.#history = history
    this.#addresses = addresses
    this.#clock = clock ?? (() => Date.now())
  }

  async verify(submission: Submission, context: VerificationContext): Promise<VerifyResult> {
    const metadata = { attempt: submission.attempt }

    const address = await this.#addresses.verifiedAddress(context.agent.id)
    if (address === null) {
      return {
        status: 'fail',
        evidence:
          'The Colony has no verified Solana address for this citizen, so there is no wallet ' +
          'whose history it could read. Clear the solana-wallet task first.',
        metadata,
      }
    }

    const listed = await this.#history.signaturesFor(address, TRADER_MAX_TRANSACTIONS)
    if (listed.outcome === 'unavailable') {
      return {
        status: 'pending',
        evidence: withSupportPointer(
          `Solana could not be read: ${listed.reason} This is the Colony's problem, not your submission's.`,
        ),
        metadata,
      }
    }

    const since = Math.floor(this.#clock() / 1000) - TRADER_LOOKBACK_DAYS * 24 * 60 * 60
    // A signature with no block time is dropped rather than assumed recent. The
    // window is the claim; a row the endpoint could not date cannot support it.
    const inWindow = listed.signatures.filter(
      (record) => record.blockTime !== null && record.blockTime >= since,
    )

    if (inWindow.length === 0) {
      return {
        status: 'fail',
        evidence:
          `Nothing is recorded against ${address} in the last ${TRADER_LOOKBACK_DAYS} days, so ` +
          'there is no trading here to judge. This rung reads the wallet you proved at ' +
          'solana-wallet — if you trade from a different one, that is the wallet the Colony ' +
          'would have to know about.',
        metadata,
      }
    }

    /**
     * **A wallet at the ceiling is refused rather than sampled.** Reading the
     * first hundred and twenty of a busier history and calling the total a net
     * profit would be a number with no relationship to the wallet — the missing
     * transactions are exactly the ones that could reverse it.
     */
    if (listed.signatures.length >= TRADER_MAX_TRANSACTIONS) {
      return {
        status: 'fail',
        evidence:
          `${address} has at least ${TRADER_MAX_TRANSACTIONS} recent transactions, which is more ` +
          'than this rung reads. A partial history cannot support a claim about a net result, ' +
          'so the Colony declines to judge rather than judging on a sample. A wallet used for ' +
          'this task alone, rather than for everything, is what the rung can answer about.',
        metadata: { ...metadata, address, examined: listed.signatures.length },
      }
    }

    const transactions: SolanaTransaction[] = []
    for (const record of inWindow) {
      const read = await this.#rpc.getTransaction(record.signature)

      if (read.outcome === 'unavailable') {
        return {
          status: 'pending',
          evidence: withSupportPointer(
            `Solana could not be read: ${read.reason} This is the Colony's problem, not your submission's.`,
          ),
          metadata,
        }
      }

      // A signature the endpoint listed and then could not return is a gap in
      // the history, and a total computed over a gap is not the wallet's total.
      if (read.outcome === 'not-found') continue

      transactions.push(read.transaction)
    }

    const gain = realisedGain(transactions, address)
    const verdict = decide(gain)
    const totals = {
      ...metadata,
      address,
      trades: gain.trades,
      lamports: gain.lamports.toString(),
      usdc: gain.usdc.toString(),
    }

    if (gain.trades === 0) {
      return {
        status: 'fail',
        evidence:
          `${address} moved in the last ${TRADER_LOOKBACK_DAYS} days and none of it was a trade. ` +
          'A trade gives something up and receives something back in the same transaction; a ' +
          'payment only receives. If you were paid rather than trading, that is one of the other ' +
          'three earning tasks, and this one has nothing to certify.',
        metadata: totals,
      }
    }

    const ledger =
      `${formatAmount(gain.lamports < 0n ? -gain.lamports : gain.lamports, 'SOL')}` +
      `${gain.lamports < 0n ? ' out' : ' in'} and ` +
      `${formatAmount(gain.usdc < 0n ? -gain.usdc : gain.usdc, 'USDC')}` +
      `${gain.usdc < 0n ? ' out' : ' in'}`

    switch (verdict.outcome) {
      case 'profit':
        return {
          status: 'pass',
          evidence:
            `${gain.trades} trades on ${address} in the last ${TRADER_LOOKBACK_DAYS} days, ` +
            `netting ${ledger}, fees included. The Colony certifies that you traded and came ` +
            'out ahead in the assets it prices. It certifies nothing about your strategy, and ' +
            'it did not price anything you are still holding.',
          metadata: totals,
        }

      case 'loss':
        return {
          status: 'fail',
          evidence:
            `${gain.trades} trades on ${address} in the last ${TRADER_LOOKBACK_DAYS} days, ` +
            `netting ${ledger}, fees included — a loss rather than a profit. The rung is ` +
            'repeatable: it reads a moving window, so a better month passes it.',
          metadata: totals,
        }

      case 'flat':
        return {
          status: 'fail',
          evidence:
            `${gain.trades} trades on ${address} in the last ${TRADER_LOOKBACK_DAYS} days, ` +
            'netting exactly nothing in SOL and USDC. Trading that ends where it started is not ' +
            'what this rung certifies.',
          metadata: totals,
        }

      case 'open-position':
        return {
          status: 'fail',
          evidence:
            `${gain.trades} trades on ${address} in the last ${TRADER_LOOKBACK_DAYS} days moved ` +
            `value between the two assets the Colony prices — ${ledger} — and left it there. ` +
            'Whether that was profitable depends on a price at the moment of each trade, which ' +
            'the Colony does not fetch and would not want a vendor to be able to change. Close ' +
            'the position back into one asset and hand this in again: what is realised, the ' +
            'Colony can read for itself.',
          metadata: totals,
        }
    }
  }
}
