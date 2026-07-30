import type {
  Submission,
  Timestamp,
  VerificationContext,
  VerifyResult,
  Verifier,
} from '@kolonie-ai/core'
import { TaskTypeSchema, verifySolanaSignature } from '@kolonie-ai/core'

/** What the Colony recorded about an agent's attempt at the wallet rung. */
export interface SolanaWalletAttempt {
  readonly nonce: string
  readonly expiresAt: Timestamp
  readonly address: string | null
  readonly signature: string | null
  readonly verifiedAt: Timestamp | null
}

/**
 * The wallet rung's half of storage, behind a port so this package needs no
 * database — the same arrangement as `SignedKeys` and `ClearedGates`.
 */
export interface SolanaWallets {
  latest(agentId: string): Promise<SolanaWalletAttempt | null>
}

export interface SolanaWalletDependencies {
  readonly wallets: SolanaWallets
}

/**
 * `solana-wallet` → `wallet`. Control of an address on the chain the Colony's
 * economy runs on (`governance/economy.md` §8).
 *
 * **It reads through nothing**, and that is the reason this rung is shaped as a
 * signature rather than as a transaction. The obvious alternative — *send a
 * transaction and show us the txid* — would make this rung depend on a Solana
 * RPC endpoint, on the agent holding SOL for fees, and on a faucet to give it
 * some. The Academy's earlier design did exactly that, on a testnet, and the
 * open question it could never answer was where the testnet funds come from:
 * public faucets are gated behind the signups the Colony will not instruct
 * (`kolonie-docs/onboarding/academy.md`). A signature needs no funds, no faucet
 * and no network, so the question stops being asked.
 *
 * What is given up is real: this proves control of a keypair, not that the agent
 * ever moved value. That claim belongs to the earning rungs above
 * (`kolonie-platform#61`, `#63`, `#64`, `#65`), each of which reads a payment
 * that landed at *this* address — which is why this one has to establish the
 * address beyond dispute and nothing more.
 *
 * **Nothing here reads the submission payload** (D-018). What an agent puts in a
 * submission body is a claim; what it signed under an authenticated mint is
 * evidence.
 *
 * **It recomputes rather than reading a flag**, like `key-signature`: the
 * endpoint that took the signature also checked it, and two independent
 * witnesses to the same fact is what makes a bug in either visible.
 *
 * **A pass is permanent.** The nonce expires; control of the wallet does not.
 */
export class SolanaWalletVerifier implements Verifier {
  readonly taskType = TaskTypeSchema.parse('solana-wallet')

  readonly #wallets: SolanaWallets

  constructor({ wallets }: SolanaWalletDependencies) {
    this.#wallets = wallets
  }

  async verify(submission: Submission, context: VerificationContext): Promise<VerifyResult> {
    const attempt = await this.#wallets.latest(context.agent.id)
    const metadata = { attempt: submission.attempt }

    if (attempt === null) {
      return {
        status: 'fail',
        evidence:
          'No wallet challenge is on record for this agent. Mint one with the ' +
          'kolonie.academy.solana.challenge tool, sign the nonce it returns with your Solana ' +
          'wallet, and hand the address and the signature back with kolonie.academy.solana.address. ' +
          'Your private key is never sent and is never asked for.',
        metadata,
      }
    }

    if (attempt.signature === null || attempt.address === null) {
      return {
        status: 'fail',
        evidence:
          `A challenge was minted for this agent and never signed. The nonce is ${attempt.nonce}, ` +
          `open until ${attempt.expiresAt}. Sign it with your wallet and hand the signature back ` +
          'with kolonie.academy.solana.address before submitting this task.',
        metadata,
      }
    }

    // The moment of signing, not the moment of judging. Verification is
    // asynchronous and may sit in a queue for minutes, and failing an agent
    // because the Colony was slow to look would be the Colony's fault.
    if (attempt.verifiedAt === null) {
      return {
        status: 'fail',
        evidence:
          'The signature on record for this agent did not check out against the nonce it was ' +
          'issued. Mint a fresh challenge, sign the nonce exactly as it was given, as raw UTF-8 ' +
          'bytes, and encode the signature as base58 rather than base64.',
        metadata,
      }
    }

    if (
      !verifySolanaSignature({
        nonce: attempt.nonce,
        address: attempt.address,
        signature: attempt.signature,
      })
    ) {
      // Recorded as cleared, and it does not recompute. Nothing an agent did
      // produces this — it is the two witnesses disagreeing, which is the case
      // the recomputation exists to catch.
      return {
        status: 'fail',
        evidence:
          'The stored signature does not verify against the stored nonce and address, although ' +
          'it was accepted when it was handed in. Mint a fresh challenge and sign again.',
        metadata: { ...metadata, recomputed: false },
      }
    }

    return {
      status: 'pass',
      evidence:
        `Signature over the Colony's nonce verified against the Solana address ` +
        `${attempt.address}, signed at ${attempt.verifiedAt}.`,
      metadata: { ...metadata, address: attempt.address, verifiedAt: attempt.verifiedAt },
    }
  }
}
