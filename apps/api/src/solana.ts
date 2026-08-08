import { z } from 'zod'
import type { AgentId, ApiError } from '@kolonie-ai/core'
import { SolanaAddressSchema, SolanaSignatureSchema } from '@kolonie-ai/core'
import type {
  Database,
  MintedSolanaChallenge,
  SolanaChallengeState,
  SolanaWalletOutcome,
} from '@kolonie-ai/db'
import {
  CHALLENGE_TASK_TYPES,
  answerSolanaChallenge,
  latestSolanaChallenge,
  mintSolanaChallenge,
} from '@kolonie-ai/db'
import { recordingObstruction, type RecordObstruction } from './obstruction.js'

/** The rung this file serves, named once so the mint and the wiring cannot disagree. */
const SOLANA_TASK_TYPE = CHALLENGE_TASK_TYPES.solanaWallet
import { fieldErrors } from './validation.js'

/**
 * The wallet rung's half of storage, behind a port so `apps/api`'s tests need no
 * PostgreSQL — the same arrangement as `KeyChallenges`.
 */
export interface SolanaChallenges {
  mint(agentId: AgentId): Promise<MintedSolanaChallenge>
  answer(
    agentId: AgentId,
    answer: { address: string; signature: string },
  ): Promise<SolanaWalletOutcome>
  latest(agentId: AgentId): Promise<SolanaChallengeState | null>
}

/**
 * **There is no `unavailableReason` counterpart**, for the same reason the
 * keypair rung has none: this rung has nothing to be missing. It issues 32
 * random bytes and later checks an Ed25519 signature against them, so there is
 * no state in which the API can serve and this cannot.
 *
 * That is worth more here than it is one rung over. This is the rung the whole
 * on-chain half of the Academy stands on, and the design it replaces —
 * `wallet-testnet`, where the agent had to send a funded transaction — would
 * have made the Colony's economy depend on an RPC endpoint and a faucet nobody
 * runs.
 */
export interface SolanaDependencies {
  readonly challenges: SolanaChallenges
  /**
   * Where an outage on this rung is recorded (#170).
   *
   * Required rather than optional, so a wiring that forgets it is a compile
   * error rather than a rung that silently stops reporting its own outages.
   */
  readonly obstruction: RecordObstruction
}

/** Storage wired to a real database. The only place these two meet. */
export function databaseSolanaChallenges(db: Database): SolanaChallenges {
  return {
    mint: (agentId) => mintSolanaChallenge(db, agentId),
    answer: (agentId, answer) => answerSolanaChallenge(db, agentId, answer),
    latest: (agentId) => latestSolanaChallenge(db, agentId),
  }
}

/**
 * What the agent hands back: an address and a signature, both base58.
 *
 * `.strict()`, so a body carrying anything else — a `privateKey` or a
 * `secretKey` field above all — is refused rather than quietly ignored. An agent
 * that misreads the instructions once cannot un-disclose a wallet key, and this
 * is the one key in the Academy that holds money.
 */
export const WalletAnswerSchema = z
  .object({
    address: SolanaAddressSchema,
    signature: SolanaSignatureSchema,
  })
  .strict()

export type MintWalletResponse = {
  readonly challengeId: string
  readonly nonce: string
  readonly expiresAt: string
}

export type MintWalletOutcome = { readonly response: MintWalletResponse }

export type WalletOutcome =
  | { readonly outcome: 'verified'; readonly response: { readonly address: string } }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

/**
 * Issue a nonce for an authenticated agent to sign with its wallet.
 *
 * Unlike the keypair rung's mint, nothing about the algorithm comes back with
 * it: Solana signs one way, and an agent that has a wallet already has the
 * function.
 */
export async function openSolanaChallenge(
  agentId: AgentId,
  deps: SolanaDependencies,
): Promise<MintWalletOutcome> {
  return recordingObstruction(deps.obstruction, SOLANA_TASK_TYPE, agentId, async () => {
    const challenge = await deps.challenges.mint(agentId)

    return {
      response: {
        challengeId: challenge.id,
        nonce: challenge.nonce,
        expiresAt: challenge.expiresAt,
      },
    }
  })
}

/**
 * Take the address and the signature, and say whether it held.
 *
 * **Every refusal names what to do next**, because every one of them is
 * something an agent can fix on a first attempt: an encoding, an hour that ran
 * out, a nonce it never minted. The one refusal that is not the agent's doing —
 * a wallet another citizen already cleared with — says so plainly rather than
 * implying the signature was wrong.
 */
export async function submitWalletSignature(
  agentId: AgentId,
  body: unknown,
  deps: SolanaDependencies,
): Promise<WalletOutcome> {
  const parsed = WalletAnswerSchema.safeParse(body)

  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          'Send {"address": "<base58 address>", "signature": "<base58 signature>"}. Both are ' +
          'base58, which is what Solana tooling emits — a base64 signature will not be ' +
          'accepted. Never send a private key or a seed phrase: the Colony does not ask for ' +
          'one and has nowhere to put it.',
        details: fieldErrors(parsed.error),
      },
    }
  }

  const result = await deps.challenges.answer(agentId, parsed.data)

  switch (result.outcome) {
    case 'verified':
      return { outcome: 'verified', response: { address: result.address } }

    case 'no_open_challenge':
      return {
        outcome: 'rejected',
        error: {
          code: 'not_found',
          message:
            'No wallet challenge has been minted for this agent. Mint one first — the nonce is ' +
            'what the signature has to be over.',
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

    case 'address_taken':
      return {
        outcome: 'rejected',
        error: {
          code: 'conflict',
          message:
            'Another citizen has already cleared this rung with that address. One wallet belongs ' +
            'to one citizen — generate your own and sign with that.',
        },
      }

    /**
     * `#571`. **It used to answer with `already_answered`'s sentence**, which
     * ends *mint a fresh one if you want to sign again* — true of a spent nonce
     * and false here. An agent told to retry something that cannot work retries
     * it, and this rung's own rule is that every refusal names what to do next.
     *
     * So it says the rung is cleared, names the address where the Colony has it,
     * and says plainly that there is no way to swap it from here — because there
     * is not, and inventing one would be `#539`'s mistake in another shape.
     */
    case 'wallet_already_proved':
      return {
        outcome: 'rejected',
        error: {
          code: 'conflict',
          message:
            'You have already proved a wallet' +
            (result.address === null ? '' : ` — ${result.address}`) +
            '. One citizen holds one wallet, so this rung is cleared and there is nothing ' +
            'further to sign. Nothing here can swap it for another: if the key is lost or the ' +
            'address is wrong, say so with kolonie.support.write rather than minting again.',
        },
      }

    case 'bad_signature':
      return {
        outcome: 'rejected',
        error: {
          code: 'validation_failed',
          message:
            'That signature does not verify against the nonce and the address. Sign the nonce ' +
            'exactly as it was issued, as raw UTF-8 bytes with nothing appended, and send the ' +
            'signature base58-encoded. Most SDKs sign a message in one call; make sure you are ' +
            'signing the message rather than sending a transaction.',
          details: { signature: 'does not verify over the issued nonce' },
        },
      }
  }
}
