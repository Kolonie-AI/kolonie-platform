import { generateKeyPairSync, randomBytes, sign as signWith } from 'node:crypto'
import {
  encodeBase58,
  now as currentTime,
  verifySolanaSignature,
  type AgentId,
} from '@kolonie-ai/core'
import type {
  MintedSolanaChallenge,
  SolanaChallengeState,
  SolanaWalletOutcome,
} from '@kolonie-ai/db'
import type { SolanaChallenges, SolanaDependencies } from '../solana.js'
import { noObstruction } from './obstruction.js'

/**
 * A real wallet, generated per call.
 *
 * Real rather than a fixed fixture, because the routes hand the values to
 * `verifySolanaSignature` and a canned string would only ever exercise the error
 * path. No private key is committed anywhere in this repository, and for a
 * wallet key that matters more than for any other.
 */
export function fakeWallet() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ type: 'spki', format: 'der' })

  return {
    address: encodeBase58(Uint8Array.from(spki.subarray(spki.length - 32))),
    sign: (message: string) =>
      encodeBase58(Uint8Array.from(signWith(null, Buffer.from(message, 'utf8'), privateKey))),
  }
}

export interface FakeSolanaChallenges extends SolanaChallenges {
  /** Age the agent's open challenge past its deadline, which minting cannot produce. */
  readonly expire: (agentId: AgentId) => void
  /** Mark an address as cleared by somebody else, without running an exchange. */
  readonly claimForAnother: (address: string) => void
}

/**
 * An in-memory wallet challenge store.
 *
 * Reproduces what the routes depend on and nothing more. Whether the *real*
 * store is safe against two agents racing to clear with one wallet is asserted
 * in `packages/db` against a real Postgres, because that property lives in a
 * partial unique index and nothing here can model it.
 *
 * It runs the real `verifySolanaSignature`, deliberately: a fake that accepted
 * any string would let the route tests prove a round trip that never checked
 * anything, which is the failure the whole rung is about.
 */
export function fakeSolanaChallenges(): FakeSolanaChallenges {
  interface Row {
    agentId: AgentId
    nonce: string
    expired: boolean
    address: string | null
    signature: string | null
    verifiedAt: string | null
  }

  const rows: Row[] = []
  const claimedByOthers = new Set<string>()

  const latestFor = (agentId: AgentId): Row | undefined => {
    const mine = rows.filter((row) => String(row.agentId) === String(agentId))
    // A cleared row wins over a newer open one, the same ordering the real store
    // uses — a pass is permanent.
    return mine.find((row) => row.verifiedAt !== null) ?? mine.at(-1)
  }

  return {
    mint: async (agentId: AgentId): Promise<MintedSolanaChallenge> => {
      const row: Row = {
        agentId,
        nonce: randomBytes(32).toString('hex'),
        expired: false,
        address: null,
        signature: null,
        verifiedAt: null,
      }
      rows.push(row)
      return {
        id: randomBytes(16).toString('hex'),
        nonce: row.nonce,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }
    },

    answer: async (agentId, answer): Promise<SolanaWalletOutcome> => {
      const row = latestFor(agentId)

      if (row === undefined) return { outcome: 'no_open_challenge' }
      if (row.verifiedAt !== null || row.signature !== null) {
        return { outcome: 'already_answered' }
      }
      if (row.expired) return { outcome: 'expired' }
      if (claimedByOthers.has(answer.address)) return { outcome: 'address_taken' }
      if (!verifySolanaSignature({ nonce: row.nonce, ...answer })) {
        return { outcome: 'bad_signature' }
      }

      row.address = answer.address
      row.signature = answer.signature
      row.verifiedAt = currentTime()

      return { outcome: 'verified', address: answer.address }
    },

    latest: async (agentId): Promise<SolanaChallengeState | null> => {
      const row = latestFor(agentId)
      if (row === undefined) return null

      return {
        nonce: row.nonce,
        expiresAt: new Date(Date.now() + (row.expired ? -1000 : 60 * 60 * 1000)).toISOString(),
        address: row.address,
        signature: row.signature,
        verifiedAt: row.verifiedAt,
      }
    },

    expire: (agentId) => {
      const row = latestFor(agentId)
      if (row === undefined) throw new Error('no challenge to expire')
      row.expired = true
    },

    claimForAnother: (address) => {
      claimedByOthers.add(address)
    },
  }
}

/** The wallet rung, wired to the in-memory store. There is nothing else to configure. */
export function fakeSolana(
  challenges: SolanaChallenges = fakeSolanaChallenges(),
): SolanaDependencies {
  return { challenges, obstruction: noObstruction }
}
