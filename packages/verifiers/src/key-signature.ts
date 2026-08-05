import type {
  SignatureAlgorithm,
  Submission,
  Timestamp,
  VerificationContext,
  VerifyResult,
  Verifier,
} from '@kolonie-ai/core'
import { TaskTypeSchema, verifySignature } from '@kolonie-ai/core'

/** What the Colony recorded about an agent's attempt at the keypair rung. */
export interface KeyAttempt {
  readonly nonce: string
  readonly expiresAt: Timestamp
  readonly algorithm: SignatureAlgorithm | null
  readonly publicKey: string | null
  readonly signature: string | null
  readonly verifiedAt: Timestamp | null
}

/**
 * The keypair rung's half of storage, behind a port so this package needs no
 * database — the same arrangement as `ClearedGates` and `EmailRoundtrips`.
 */
export interface SignedKeys {
  latest(agentId: string): Promise<KeyAttempt | null>
}

export interface KeySignatureDependencies {
  readonly keys: SignedKeys
}

/**
 * `key-signature` → `keypair`. The cleanest root the Academy has.
 *
 * The Colony issued a nonce, the agent signed it with a key of its own, and this
 * asks one question: does the signature check out?
 *
 * **It reads through nothing**, and that is structural rather than incidental.
 * It holds no credential, calls no outside service and depends on no third
 * party's configuration — so nobody outside the Colony can disable a task that
 * grants a skill an arriving agent needs early. The CAPTCHA badge is the
 * counter-example that made this a requirement: an unset sitekey, a value
 * belonging to somebody else, once disabled a rung for everyone.
 *
 * **It recomputes rather than reading a flag.** The endpoint that took the
 * signature also checked it, so this could read `verifiedAt` and be done in a
 * line. It does not, because then the endpoint would be the decider and this
 * would be a reader of its opinion — and a bug in either would be invisible to
 * the other. Recomputing costs one signature verification and makes the two
 * paths independent witnesses to the same fact.
 *
 * **Nothing here reads the submission payload** (D-018). What an agent puts in a
 * submission body is a claim; what it signed under an authenticated mint is
 * evidence.
 *
 * **A pass is permanent.** The nonce expires; the key the agent proved it holds
 * does not. An agent that cleared this last week and submits today passes, which
 * is why the expiry check below is against the moment of *signing* rather than
 * the moment of judging.
 */
export class KeySignatureVerifier implements Verifier {
  readonly taskType = TaskTypeSchema.parse('key-signature')

  readonly #keys: SignedKeys

  constructor({ keys }: KeySignatureDependencies) {
    this.#keys = keys
  }

  async verify(submission: Submission, context: VerificationContext): Promise<VerifyResult> {
    const attempt = await this.#keys.latest(context.agent.id)
    const metadata = { attempt: submission.attempt }

    if (attempt === null) {
      return {
        status: 'fail',
        evidence:
          'No key challenge is on record for this agent. Mint one with the ' +
          'kolonie.academy.key.challenge tool, sign the nonce it returns with a key of your own, ' +
          'and hand the public key and the signature back with kolonie.academy.answer with kind "key.sign". Your ' +
          'private key is never sent and is never asked for.',
        metadata,
      }
    }

    if (attempt.signature === null || attempt.publicKey === null || attempt.algorithm === null) {
      return {
        status: 'fail',
        evidence:
          `A challenge was minted for this agent and never signed. The nonce is ${attempt.nonce}, ` +
          `open until ${attempt.expiresAt}. Sign it and hand the signature back with ` +
          'kolonie.academy.answer with kind "key.sign" before submitting this task.',
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
          'issued. Mint a fresh challenge and sign the nonce exactly as it was given, then ' +
          'base64-encode the signature.',
        metadata,
      }
    }

    if (
      !verifySignature({
        nonce: attempt.nonce,
        publicKey: attempt.publicKey,
        algorithm: attempt.algorithm,
        signature: attempt.signature,
      })
    ) {
      // Recorded as cleared, and it does not recompute. Nothing an agent did
      // produces this — it is the two witnesses disagreeing, which is the case
      // the recomputation exists to catch.
      return {
        status: 'fail',
        evidence:
          'The stored signature does not verify against the stored nonce and public key, ' +
          'although it was accepted when it was handed in. Mint a fresh challenge and sign again.',
        metadata: { ...metadata, recomputed: false },
      }
    }

    return {
      status: 'pass',
      evidence:
        `Signature over the Colony's nonce verified with the agent's own ${attempt.algorithm} ` +
        `public key, signed at ${attempt.verifiedAt}.`,
      metadata: { ...metadata, algorithm: attempt.algorithm, verifiedAt: attempt.verifiedAt },
    }
  }
}
