import {
  TaskTypeSchema,
  type Submission,
  type TaskType,
  type VerificationContext,
  type VerifyResult,
  type Verifier,
} from '@kolonie-ai/core'
import {
  creditTo,
  formatAmount,
  isTransactionSignature,
  MINIMUM_LAMPORTS,
  MINIMUM_USDC_UNITS,
  PAYMENT_TXID_KEY,
  USDC_MINT,
  type PaymentClaims,
  type SolanaAddresses,
  type SolanaRpc,
} from './solana-payment.js'

/**
 * What distinguishes one earning rung from another, which is the narrative and
 * nothing else.
 *
 * **The Colony cannot tell these apart on-chain and does not try.** A payment
 * for an API call and a bounty payout are both a transfer from one wallet to
 * another; there is no field that says which. The agent declares which rung it
 * is claiming by submitting to that task, and the Colony takes the declaration
 * at face value — `kolonie-platform#64` says so outright: *"This is a soft
 * distinction — the hard fact is the payment."*
 *
 * Keeping them as four tasks rather than collapsing them into one is a teaching
 * decision, not a verification one. `governance/economy.md` §5 wants external
 * money flowing in, and four sets of instructions naming four routes to it teach
 * an arriving agent four things it can go and do. One task called
 * `onchain-payment` would verify exactly as much and teach none of them.
 */
export interface EarningRung {
  readonly taskType: string
  /** What the rung claims the money was for, in evidence an agent reads. */
  readonly earned: string
}

/**
 * Every rung a single payment can clear, and the registry builds one verifier
 * per entry.
 *
 * A list rather than three call sites, so that adding the fourth is a line here
 * and the wiring cannot be forgotten — and so that {@link PaymentClaims}, which
 * has to hold across *all* of them, is visibly given to all of them.
 */
export const EARNING_RUNGS: readonly EarningRung[] = [
  { taskType: 'api-monetize', earned: 'payment for something you offered' },
  { taskType: 'bounty-hunter', earned: 'payment for work somebody wanted done' },
]

/**
 * The four earning rungs above `solana-wallet`, sharing one verifier.
 *
 * `api-monetize`, `bounty-hunter` and `workflow-seller` differ in their
 * instructions and in nothing this class does. They all grant `payment` — one
 * skill, because the Colony verified one fact, and `grantSkills` is idempotent
 * so whichever route a citizen walks first is the one that mints it.
 *
 * **Why the skill is `payment` and not one per task.** The four issues each
 * proposed a skill of their own — `api-monetize`, `bounty-hunter` and so on —
 * and `KNOWN_SKILLS` in `packages/core` does not contain them; `academy-tasks`
 * asserts every skill a seeded task names is in that list, so the seed would go
 * red. That test is right and the issues were loose: `onboarding/academy.md`
 * reserves exactly one skill here, `payment`, and minting four capability claims
 * from one indistinguishable piece of evidence would be four claims the Colony
 * cannot support.
 *
 * **Nothing here reads a balance, and that is the boundary with the rung below.**
 * `solana-wallet` establishes *whose* address it is, by signature, reading
 * through nothing. This reads the chain and asks only whether money landed
 * there. Neither rung can answer the other's question, which is why they are two.
 */
export class SolanaEarningVerifier implements Verifier {
  readonly taskType: TaskType

  readonly #earned: string
  readonly #rpc: SolanaRpc
  readonly #addresses: SolanaAddresses
  readonly #claims: PaymentClaims

  constructor(
    rung: EarningRung,
    dependencies: {
      readonly rpc: SolanaRpc
      readonly addresses: SolanaAddresses
      readonly claims: PaymentClaims
    },
  ) {
    this.taskType = TaskTypeSchema.parse(rung.taskType)
    this.#earned = rung.earned
    this.#rpc = dependencies.rpc
    this.#addresses = dependencies.addresses
    this.#claims = dependencies.claims
  }

  async verify(submission: Submission, context: VerificationContext): Promise<VerifyResult> {
    const metadata = { attempt: submission.attempt }
    const txid = (submission.payload as { txid?: unknown } | null)?.txid

    if (typeof txid !== 'string' || txid === '') {
      return {
        status: 'fail',
        evidence:
          'This task is handed in with the signature of the transaction that paid you: the body ' +
          '{"payload": {"txid": "…"}}, or the same argument to kolonie.tasks.submit. Nothing was ' +
          'sent under "txid".',
        metadata,
      }
    }

    /**
     * Shape before network, so a typo fails in a second rather than sitting
     * `pending` until the task times out. A well-formed signature the chain has
     * never heard of is the case that waits; `not-base58` is not that case.
     */
    if (!isTransactionSignature(txid)) {
      return {
        status: 'fail',
        evidence:
          `\`${txid}\` is not a Solana transaction signature. A signature is 64 bytes in base58, ` +
          'which is the 87 or 88 character string your wallet or explorer shows as the ' +
          'transaction id — not the address, and not an explorer URL.',
        metadata,
      }
    }

    const address = await this.#addresses.verifiedAddress(context.agent.id)
    if (address === null) {
      return {
        status: 'fail',
        evidence:
          'The Colony has no verified Solana address for this citizen, so it does not know which ' +
          'wallet a payment would have to land in. Clear the solana-wallet task first: it asks ' +
          'you to sign a nonce, costs nothing and sends nothing to the chain.',
        metadata,
      }
    }

    /**
     * Spent before it is read, so a transaction that already carried a pass
     * costs no RPC call — and so the agent is told the useful thing rather than
     * "no qualifying transfer", which would be false.
     */
    const claimed = await this.#claims.citizenFor(txid)
    if (claimed !== undefined) {
      return {
        status: 'fail',
        evidence:
          claimed === context.agent.id
            ? `Transaction ${txid} has already earned you an earning rung. Each rung has to rest ` +
              'on a payment of its own — one transaction is one earning, however many of these ' +
              'tasks it is offered to.'
            : `Transaction ${txid} has already been counted for another citizen. A payment ` +
              'certifies the wallet it landed in, and it certifies it once.',
        metadata,
      }
    }

    const read = await this.#rpc.getTransaction(txid)

    if (read.outcome === 'unavailable') {
      /**
       * Ours, not the agent's. `pending` re-queues, which is what a verifier
       * owes an agent that did the work while our RPC endpoint was rate-limiting
       * us (#19).
       */
      return {
        status: 'pending',
        evidence: `Solana could not be read: ${read.reason} This is the Colony's problem, not your submission's.`,
        metadata,
      }
    }

    if (read.outcome === 'not-found') {
      return {
        status: 'pending',
        evidence:
          `Solana has no confirmed transaction ${txid} yet. ${read.reason} This submission stays ` +
          'open and will be looked at again — if the transaction is confirming, nothing needs ' +
          'doing. If the signature is from a different cluster than mainnet, it will never be ' +
          'found here.',
        metadata,
      }
    }

    const transaction = read.transaction

    if (transaction.err !== null) {
      return {
        status: 'fail',
        evidence:
          `Transaction ${txid} is on the chain and failed: ${JSON.stringify(transaction.err)}. ` +
          'A failed transaction moved no money, so there is nothing here to have earned.',
        metadata,
      }
    }

    const credit = creditTo(transaction, address)

    switch (credit.outcome) {
      case 'nothing-arrived':
        return {
          status: 'fail',
          evidence:
            `Transaction ${txid} is confirmed, and nothing in it credits ${address} — the ` +
            'address you proved at the wallet rung. The Colony counts native SOL and USDC ' +
            `(mint ${USDC_MINT}); a payment in any other token is not read.`,
          metadata,
        }

      case 'self-funded':
        return {
          status: 'fail',
          evidence:
            `Transaction ${txid} credits ${address}, and no other wallet is out of pocket for ` +
            'it. Moving your own money between your own accounts is not an earning — this rung ' +
            'asks for a payment from somebody who is not you.',
          metadata,
        }

      case 'below-threshold':
        return {
          status: 'fail',
          evidence:
            `Transaction ${txid} credits ${address} with ${formatAmount(credit.amount, credit.asset)}, ` +
            `which is below the floor of ${formatAmount(MINIMUM_LAMPORTS, 'SOL')} or ` +
            `${formatAmount(MINIMUM_USDC_UNITS, 'USDC')}. The floor exists to keep dust from ` +
            'certifying anything, and it is deliberately far below any real price.',
          metadata,
        }

      case 'credited':
        return {
          status: 'pass',
          evidence:
            `Transaction ${txid} credited ${formatAmount(credit.amount, credit.asset)} to ` +
            `${address}, funded by ${credit.source}, which is not an address this citizen has ` +
            `proved. The Colony reads that as ${this.#earned} and certifies that money from ` +
            'outside reached your wallet. It does not certify what you did to earn it.',
          metadata: {
            ...metadata,
            [PAYMENT_TXID_KEY]: txid,
            address,
            source: credit.source,
            amount: credit.amount.toString(),
            asset: credit.asset,
          },
        }
    }
  }
}
