import { generateKeyPairSync, randomBytes, sign as signWith } from 'node:crypto'
import { now as currentTime, verifySignature, type AgentId } from '@kolonie-ai/core'
import type { KeyChallengeState, KeySignatureOutcome, MintedKeyChallenge } from '@kolonie-ai/db'
import type { KeyChallenges, KeyDependencies } from '../keys.js'
import { noObstruction } from './obstruction.js'

/**
 * A real keypair, generated per call.
 *
 * Real rather than a fixed fixture, because the routes hand the value to
 * `verifySignature` and a canned string would only exercise the error path. No
 * private key is committed anywhere in this repository, and this is why.
 */
export function fakeKeypair(algorithm: 'ed25519' | 'secp256k1' = 'ed25519') {
  const { publicKey, privateKey } =
    algorithm === 'ed25519'
      ? generateKeyPairSync('ed25519')
      : generateKeyPairSync('ec', { namedCurve: 'secp256k1' })

  return {
    algorithm,
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    sign: (message: string) =>
      signWith(
        algorithm === 'ed25519' ? null : 'sha256',
        Buffer.from(message, 'utf8'),
        privateKey,
      ).toString('base64'),
  }
}

export interface FakeKeyChallenges extends KeyChallenges {
  /** Age the agent's open challenge past its deadline, which minting cannot produce. */
  readonly expire: (agentId: AgentId) => void
  /** Mark a key as cleared by somebody else, without running an exchange. */
  readonly claimForAnother: (publicKey: string) => void
}

/**
 * An in-memory key challenge store.
 *
 * Reproduces what the routes depend on and nothing more: which agent a nonce
 * belongs to, whether it is still open, and whether a signature over it holds.
 * Whether the *real* store is safe against two agents racing to clear with one
 * key is asserted in `packages/db` against a real Postgres, because that
 * property lives in a partial unique index and nothing here can model it.
 *
 * It does run the real `verifySignature`, deliberately. A fake that accepted any
 * string would let the route tests prove a round trip that never checked
 * anything, which is the failure the whole rung is about.
 */
export function fakeKeyChallenges(): FakeKeyChallenges {
  interface Row {
    agentId: AgentId
    nonce: string
    expired: boolean
    algorithm: 'ed25519' | 'secp256k1' | null
    publicKey: string | null
    signature: string | null
    verifiedAt: string | null
  }

  const rows: Row[] = []
  const claimedByOthers = new Set<string>()

  const latestFor = (agentId: AgentId): Row | undefined => {
    const mine = rows.filter((row) => String(row.agentId) === String(agentId))
    // A cleared row wins over a newer open one, the same ordering the real store
    // uses — a pass is permanent, so an agent that cleared and then minted again
    // must not read as having stopped halfway.
    return mine.find((row) => row.verifiedAt !== null) ?? mine.at(-1)
  }

  return {
    mint: async (agentId: AgentId): Promise<MintedKeyChallenge> => {
      const row: Row = {
        agentId,
        nonce: randomBytes(32).toString('hex'),
        expired: false,
        algorithm: null,
        publicKey: null,
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

    answer: async (agentId, answer): Promise<KeySignatureOutcome> => {
      const row = latestFor(agentId)

      if (row === undefined) return { outcome: 'no_open_challenge' }
      if (row.verifiedAt !== null || row.signature !== null) {
        return { outcome: 'already_answered' }
      }
      if (row.expired) return { outcome: 'expired' }
      if (claimedByOthers.has(answer.publicKey)) return { outcome: 'key_taken' }
      if (!verifySignature({ nonce: row.nonce, ...answer })) return { outcome: 'bad_signature' }

      row.algorithm = answer.algorithm
      row.publicKey = answer.publicKey
      row.signature = answer.signature
      row.verifiedAt = currentTime()

      return { outcome: 'verified', publicKey: answer.publicKey }
    },

    latest: async (agentId): Promise<KeyChallengeState | null> => {
      const row = latestFor(agentId)
      if (row === undefined) return null

      return {
        nonce: row.nonce,
        expiresAt: new Date(Date.now() + (row.expired ? -1000 : 60 * 60 * 1000)).toISOString(),
        algorithm: row.algorithm,
        publicKey: row.publicKey,
        signature: row.signature,
        verifiedAt: row.verifiedAt,
      }
    },

    expire: (agentId) => {
      const row = latestFor(agentId)
      if (row === undefined) throw new Error('no challenge to expire')
      row.expired = true
    },

    claimForAnother: (publicKey) => {
      claimedByOthers.add(publicKey)
    },
  }
}

/** The keypair rung, wired to the in-memory store. There is nothing else to configure. */
export function fakeKeys(challenges: KeyChallenges = fakeKeyChallenges()): KeyDependencies {
  return { challenges, obstruction: noObstruction }
}
