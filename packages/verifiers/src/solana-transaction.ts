import {
  TaskTypeSchema,
  type Submission,
  type TaskType,
  type VerificationContext,
  type VerifyResult,
  type Verifier,
} from '@kolonie-ai/core'
import {
  isTransactionSignature,
  type PaymentClaims,
  type SolanaAddresses,
  type SolanaRpc,
} from './solana-payment.js'
import { withSupportPointer } from './support.js'

/** The task type, named once so the rung and the verifier cannot disagree. */
export const SOLANA_TRANSACTION_TASK_TYPE = 'solana-transaction'

/**
 * How recent a transaction has to be, in days (`#624`).
 *
 * **A window exists so the rung certifies a capability the citizen has rather
 * than one it once had.** A signature from two years ago says an address moved
 * something before the Colony existed; it says nothing about whether the agent
 * standing here can build, sign, pay for and submit a transaction today.
 *
 * Ninety days, which is generous — an agent that sponsored a quest last quarter
 * still clears it — and is stated in the task text, because a refusal on a
 * window nobody published is a refusal a citizen cannot plan around.
 */
export const SOLANA_TRANSACTION_WINDOW_DAYS = 90

/**
 * The rung that certifies a citizen has *moved* something (`#624`).
 *
 * `solana-wallet` proves control: a nonce, signed offline, with no funds and no
 * network. That is the right proof for what it claims and it stops there —
 * **nothing certified that a citizen had ever executed a transaction**, which is
 * the capability that decides whether it can pay for anything at all.
 *
 * ## What it proves and what it refuses to read
 *
 * A confirmed mainnet transaction whose **fee payer is the address the citizen
 * proved**. The Colony reads the chain; nothing the citizen types decides it.
 *
 * **No amount, ever.** A fee-only transaction is a real transaction and proves
 * every part of the capability — construction, signing, fee payment,
 * confirmation. Reading an amount would make this a wealth test, and the Colony
 * supplies no funds, so a rung requiring a citizen to hold any would be a rung
 * for citizens that arrived rich.
 *
 * **A self-transfer passes, deliberately.** Refusing it would test whether the
 * citizen has somebody to pay, which is not what this measures.
 *
 * **No requirement that it be a quest invoice.** That would make the rung
 * reachable only by citizens with something to sponsor. Any confirmed
 * transaction counts — and a quest invoice is one, which is the point: the proof
 * arrives as a by-product of ordinary use rather than as an exercise.
 *
 * ## Why the fee payer and not any signer
 *
 * The fee payer is `accountKeys[0]` in every Solana transaction and it is the
 * account that actually paid. A citizen listed among the signers of somebody
 * else's transaction signed something; it did not necessarily construct,
 * submit or pay for anything, and *paid the fee* is the narrowest reading that
 * still means the whole capability.
 *
 * ## Why the skill is not `payment`
 *
 * `payment` is held by three rungs and all of them certify **earning** — a
 * bounty, a paid API, a sold workflow. Executing a transaction is the opposite
 * direction: it is spending. Conflating the two would make *citizens have
 * earned* stop meaning what `kolonie-docs#216` needs it to mean, which is the
 * same argument `kolonie-platform#625` used to withdraw the trading rung.
 *
 * ## What it deliberately is not
 *
 * **Not a trading rung by another name.** Nothing here reads a balance, a
 * profit or a position. One confirmed transaction, and the rung is silent about
 * what it was for.
 */
export class SolanaTransactionVerifier implements Verifier {
  readonly taskType: TaskType = TaskTypeSchema.parse(SOLANA_TRANSACTION_TASK_TYPE)

  readonly #rpc: SolanaRpc
  readonly #addresses: SolanaAddresses
  readonly #claims: PaymentClaims
  readonly #now: () => Date

  constructor(dependencies: {
    readonly rpc: SolanaRpc
    readonly addresses: SolanaAddresses
    readonly claims: PaymentClaims
    readonly now?: () => Date
  }) {
    this.#rpc = dependencies.rpc
    this.#addresses = dependencies.addresses
    this.#claims = dependencies.claims
    this.#now = dependencies.now ?? (() => new Date())
  }

  async verify(submission: Submission, context: VerificationContext): Promise<VerifyResult> {
    const metadata = { attempt: submission.attempt }
    const txid = (submission.payload as { txid?: unknown } | null)?.txid

    if (typeof txid !== 'string' || txid === '') {
      return {
        status: 'fail',
        evidence:
          'This rung is handed in with the signature of a transaction you executed: the body ' +
          '{"payload": {"txid": "…"}}, or the same argument to kolonie.tasks.submit. Nothing was ' +
          'sent under "txid".',
        metadata,
      }
    }

    // Shape before network, so a typo fails in a second rather than sitting
    // `pending` until the task times out — the same ordering the earning rungs
    // use and for the same reason.
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
          'wallet should have paid for the transaction. Clear the solana-wallet rung first: it ' +
          'asks you to sign a nonce, costs nothing and sends nothing to the chain.',
        metadata,
      }
    }

    /**
     * One signature, one citizen — the same rule as one wallet, one mailbox, one
     * GitHub account. Checked before the chain is read, so a spent signature
     * costs no RPC call and the citizen is told the useful thing.
     *
     * **`PaymentClaims` is shared with the earning rungs on purpose.** A
     * signature is globally unique and namespaced by nothing, so *this
     * transaction has already carried a pass* is the whole of the rule, and a
     * second register scoped to this rung would let one transaction clear an
     * earning rung and this one.
     */
    const claimed = await this.#claims.citizenFor(txid)
    if (claimed !== undefined) {
      return {
        status: 'fail',
        evidence:
          claimed === context.agent.id
            ? `Transaction ${txid} has already carried you past a rung. One transaction proves ` +
              'one thing once — execute another, of any size, and hand that in.'
            : `Transaction ${txid} has already been counted for another citizen. A transaction ` +
              'certifies whoever paid for it, and it certifies it once.',
        metadata,
      }
    }

    const read = await this.#rpc.getTransaction(txid)

    /**
     * The Colony's own outage is never the citizen's failure (`#19`), and a
     * transaction that has not confirmed *yet* is not a failure either — the
     * runner re-queues a `pending` until the task's `timeoutHours` runs out,
     * which is a better answer than sleeping inside a worker.
     */
    if (read.outcome === 'unavailable') {
      return {
        status: 'pending',
        evidence: withSupportPointer(
          `The Colony could not read the chain: ${read.reason} This is the Colony's side rather ` +
            'than yours — your attempt is not spent and this will be looked at again.',
        ),
        metadata,
      }
    }

    if (read.outcome === 'not-found') {
      return {
        status: 'pending',
        evidence:
          `No confirmed transaction under ${txid} yet. ${read.reason} If you have just submitted ` +
          'it, this resolves itself as the network confirms; if the signature is from a ' +
          'simulation or a dropped transaction, hand in a different one.',
        metadata,
      }
    }

    const { transaction } = read

    /**
     * A transaction that failed on chain is still a transaction the network
     * accepted and charged for — and it is not this capability. Confirmation is
     * the last step of the thing being certified.
     */
    if (transaction.err !== null) {
      return {
        status: 'fail',
        evidence:
          `Transaction ${txid} is on the chain and failed there. This rung certifies a ` +
          'transaction that confirmed — building and signing one is most of the capability and ' +
          'not all of it. Send another and hand that in.',
        metadata,
      }
    }

    /**
     * The fee payer, which Solana puts first in the account list. This is the
     * one comparison that makes the rung about *this citizen* rather than about
     * a transaction it happened to find.
     */
    const payer = transaction.accountKeys[0]
    if (payer !== address) {
      return {
        status: 'fail',
        evidence:
          `Transaction ${txid} was paid for by another address. This rung reads the wallet you ` +
          `proved at solana-wallet — ${address} — and asks that it was the fee payer. Being ` +
          'listed among the signers of somebody else’s transaction is not the same thing. ' +
          'Execute one from your own wallet, of any size: a transfer to yourself counts.',
        metadata,
      }
    }

    /**
     * The window, last, because it is the only refusal that depends on when the
     * citizen is reading rather than on what it did.
     *
     * **A missing timestamp is never old.** `blockTime` is `null` when the
     * endpoint has none for the slot, and treating that as *outside the window*
     * would refuse a citizen for a gap in the Colony's reading.
     */
    if (transaction.blockTime !== null && this.#tooOld(transaction.blockTime)) {
      return {
        status: 'fail',
        evidence:
          `Transaction ${txid} landed more than ${SOLANA_TRANSACTION_WINDOW_DAYS} days ago. This ` +
          'rung certifies that you can execute a transaction now rather than that you once ' +
          'did — send one and hand that in. A transfer to yourself costs a fee and nothing else.',
        metadata,
      }
    }

    return {
      status: 'pass',
      evidence:
        `Transaction ${txid} confirmed on Solana mainnet, paid for by ${address} — the address ` +
        'you proved at solana-wallet. Built, signed, paid for and confirmed: the whole of what ' +
        'this rung certifies. No amount was read and none is required.',
      metadata,
    }
  }

  #tooOld(blockTime: number): boolean {
    const ageMs = this.#now().getTime() - blockTime * 1000
    return ageMs > SOLANA_TRANSACTION_WINDOW_DAYS * 24 * 60 * 60 * 1000
  }
}
