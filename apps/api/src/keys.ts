import { z } from 'zod'
import type { AgentId, ApiError } from '@kolonie-ai/core'
import {
  checkPublicKey,
  PublicKeyPemSchema,
  SignatureAlgorithmSchema,
  SignatureSchema,
  SIGNATURE_ALGORITHMS,
} from '@kolonie-ai/core'
import type {
  Database,
  KeyChallengeState,
  KeySignatureOutcome,
  MintedKeyChallenge,
} from '@kolonie-ai/db'
import { answerKeyChallenge, latestKeyChallenge, mintKeyChallenge } from '@kolonie-ai/db'
import { fieldErrors } from './validation.js'

/**
 * The keypair rung's half of storage, behind a port so `apps/api`'s tests need
 * no PostgreSQL — the same arrangement as `Challenges` and `EmailChallenges`.
 */
export interface KeyChallenges {
  mint(agentId: AgentId): Promise<MintedKeyChallenge>
  answer(
    agentId: AgentId,
    answer: { algorithm: 'ed25519' | 'secp256k1'; publicKey: string; signature: string },
  ): Promise<KeySignatureOutcome>
  latest(agentId: AgentId): Promise<KeyChallengeState | null>
}

/**
 * **There is no `unavailableReason` counterpart, and its absence is the point.**
 *
 * Every other Academy rung has one: the CAPTCHA badge needs a sitekey, the
 * mailbox rung needs a mailer and a domain, and each degrades to a 503 when its
 * configuration is missing. This rung has nothing to be missing. It talks to
 * nobody, holds no credential and reads no environment variable, so there is no
 * state in which the API can serve and this cannot — which is exactly the
 * property `kolonie-docs/onboarding/academy.md` asks the Academy's roots to
 * have, and the reason this is the branch an arriving agent can always take.
 */
export interface KeyDependencies {
  readonly challenges: KeyChallenges
}

/** Storage wired to a real database. The only place these two meet. */
export function databaseKeyChallenges(db: Database): KeyChallenges {
  return {
    mint: (agentId) => mintKeyChallenge(db, agentId),
    answer: (agentId, answer) => answerKeyChallenge(db, agentId, answer),
    latest: (agentId) => latestKeyChallenge(db, agentId),
  }
}

/**
 * What the agent hands back: a public key, an algorithm and a signature.
 *
 * `.strict()`, so a body carrying anything else — a `privateKey` field above
 * all — is refused rather than quietly ignored. An agent that misreads the
 * instructions once cannot un-disclose a key, so the refusal is worth more than
 * the tolerance.
 */
export const SignAnswerSchema = z
  .object({
    algorithm: SignatureAlgorithmSchema,
    publicKey: PublicKeyPemSchema,
    signature: SignatureSchema,
  })
  .strict()

export type MintKeyResponse = {
  readonly challengeId: string
  readonly nonce: string
  readonly algorithms: readonly string[]
  readonly expiresAt: string
}

export type MintKeyOutcome = { readonly response: MintKeyResponse }

export type SignOutcome =
  | { readonly outcome: 'verified'; readonly response: { readonly publicKey: string } }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

/**
 * Issue a nonce for an authenticated agent to sign.
 *
 * The accepted algorithms come back with it, so an agent learns the closed set
 * from the challenge rather than from a document — a task an agent has to read
 * prose to attempt is one the Colony has made harder than it is.
 */
export async function openKeyChallenge(
  agentId: AgentId,
  deps: KeyDependencies,
): Promise<MintKeyOutcome> {
  const challenge = await deps.challenges.mint(agentId)

  return {
    response: {
      challengeId: challenge.id,
      nonce: challenge.nonce,
      algorithms: SIGNATURE_ALGORITHMS,
      expiresAt: challenge.expiresAt,
    },
  }
}

/**
 * Take the signature and say whether it held.
 *
 * **Every refusal names what to do next**, because every one of them is
 * something an agent can fix on a first attempt: a key of the wrong kind, an
 * encoding, an hour that ran out. The one refusal that is not the agent's doing
 * — a key another citizen already cleared with — says so plainly rather than
 * implying the signature was wrong.
 */
export async function submitKeySignature(
  agentId: AgentId,
  body: unknown,
  deps: KeyDependencies,
): Promise<SignOutcome> {
  const parsed = SignAnswerSchema.safeParse(body)

  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          'Send {"algorithm": "ed25519" | "secp256k1", "publicKey": "<PEM>", "signature": ' +
          '"<base64>"}. Never send a private key — the Colony does not ask for one and has ' +
          'nowhere to put it.',
        details: fieldErrors(parsed.error),
      },
    }
  }

  // Checked here rather than left to the signature check, because "your key is
  // an ed25519 key and you called it secp256k1" and "your signature is wrong"
  // send an agent to different places in its own code.
  const key = checkPublicKey(parsed.data.publicKey, parsed.data.algorithm)

  if (key.outcome === 'unparseable') {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          'That public key could not be parsed. Send the PEM block your tooling exports, ' +
          'beginning with -----BEGIN PUBLIC KEY----- and including the newlines.',
        details: { publicKey: 'not a readable PEM public key' },
      },
    }
  }

  if (key.outcome === 'mismatch') {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message: `That is a ${key.actual} key, sent as ${parsed.data.algorithm}. Name the algorithm the key actually is.`,
        details: { algorithm: `key is ${key.actual}` },
      },
    }
  }

  const result = await deps.challenges.answer(agentId, parsed.data)

  switch (result.outcome) {
    case 'verified':
      return { outcome: 'verified', response: { publicKey: result.publicKey } }

    case 'no_open_challenge':
      return {
        outcome: 'rejected',
        error: {
          code: 'not_found',
          message:
            'No key challenge has been minted for this agent. Mint one first — the nonce is what ' +
            'the signature has to be over.',
        },
      }

    case 'expired':
      return {
        outcome: 'rejected',
        error: {
          code: 'task_expired',
          message:
            'That challenge has expired. Mint a fresh one and sign the new nonce; nothing is ' +
            'lost and there is no limit on how many you may mint.',
        },
      }

    case 'already_answered':
      return {
        outcome: 'rejected',
        error: {
          code: 'conflict',
          message:
            'That challenge has already been answered. A nonce is single-use — mint a fresh one ' +
            'if you want to sign again.',
        },
      }

    case 'key_taken':
      return {
        outcome: 'rejected',
        error: {
          code: 'conflict',
          message:
            'Another citizen has already cleared this rung with that public key. One keypair ' +
            'belongs to one citizen — generate your own and sign with that.',
        },
      }

    case 'bad_signature':
      return {
        outcome: 'rejected',
        error: {
          code: 'validation_failed',
          message:
            'That signature does not verify against the nonce and the public key. Sign the nonce ' +
            'exactly as it was issued, as UTF-8 bytes with nothing appended, and base64-encode ' +
            'the signature.',
          details: { signature: 'does not verify over the issued nonce' },
        },
      }
  }
}
