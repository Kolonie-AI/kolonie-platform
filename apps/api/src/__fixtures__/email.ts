import { randomUUID } from 'node:crypto'
import { now as currentTime, type AgentId } from '@kolonie-ai/core'
import type {
  EmailChallengeState,
  EmailMintOutcome,
  EmailRedemption,
  InboundOutcome,
} from '@kolonie-ai/db'
import type { EmailChallenges, EmailDependencies } from '../email.js'

/** The domain challenge addresses are minted under in tests. Reserved by RFC 2606. */
export const FAKE_CHALLENGE_DOMAIN = 'challenge.example'

/** The shared secret the fake inbound route expects. Not a credential shape. */
export const FAKE_INBOUND_SECRET = 'test-inbound-secret'

export interface FakeEmailChallenges extends EmailChallenges {
  /** Age the agent's open challenge past its deadline, which minting cannot produce. */
  readonly expire: (agentId: AgentId) => void
  /** Mark an address as proved by somebody else, without running a round trip. */
  readonly claimForAnother: (address: string) => void
}

/**
 * An in-memory mailbox challenge store.
 *
 * Reproduces what the routes depend on and nothing more: which agent a token
 * belongs to, which address it claims, whether mail has arrived, and whether the
 * code came back. Whether the *real* store is safe against two agents racing to
 * prove one address is asserted in `packages/db` against a real Postgres,
 * because that property lives in a partial unique index and not in anything this
 * file can model.
 */
export function fakeEmailChallenges(): FakeEmailChallenges {
  interface Row {
    agentId: AgentId
    address: string
    token: string
    expired: boolean
    inboundAt: string | null
    code: string | null
    verifiedAt: string | null
  }

  const rows: Row[] = []
  const provenElsewhere = new Set<string>()

  const latestFor = (agentId: AgentId): Row | undefined =>
    // Verified first, then newest — the same ordering the real query applies,
    // and the reason it exists: a later abandoned attempt must not make a
    // citizen that passed read as unverified.
    [...rows]
      .filter((row) => row.agentId === agentId)
      .sort((a, b) => Number(b.verifiedAt !== null) - Number(a.verifiedAt !== null))[0]

  return {
    async mint(agentId, address) {
      const taken =
        provenElsewhere.has(address.toLowerCase()) ||
        rows.some(
          (row) =>
            row.verifiedAt !== null &&
            row.agentId !== agentId &&
            row.address.toLowerCase() === address.toLowerCase(),
        )

      if (taken) return { outcome: 'address_taken' } satisfies EmailMintOutcome

      const token = randomUUID().replace(/-/g, '').slice(0, 18)
      rows.push({
        agentId,
        address,
        token,
        expired: false,
        inboundAt: null,
        code: null,
        verifiedAt: null,
      })

      return {
        outcome: 'minted',
        challenge: { id: randomUUID(), token, expiresAt: currentTime() },
      } satisfies EmailMintOutcome
    },

    async inbound(token, from) {
      const row = rows.find((candidate) => candidate.token === token)

      if (row === undefined) return { outcome: 'unknown_token' } satisfies InboundOutcome
      if (row.address.toLowerCase() !== from.toLowerCase()) {
        return { outcome: 'sender_mismatch' } satisfies InboundOutcome
      }
      if (row.inboundAt !== null && row.code !== null) {
        return {
          outcome: 'already_received',
          code: row.code,
          replyTo: row.address,
        } satisfies InboundOutcome
      }
      if (row.expired) return { outcome: 'expired' } satisfies InboundOutcome

      row.inboundAt = currentTime()
      row.code = randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()

      return { outcome: 'accepted', code: row.code, replyTo: row.address } satisfies InboundOutcome
    },

    async redeem(agentId, code) {
      const row = latestFor(agentId)

      if (row === undefined) return { outcome: 'no_open_challenge' } satisfies EmailRedemption
      if (row.verifiedAt !== null) {
        return { outcome: 'verified', address: row.address } satisfies EmailRedemption
      }
      if (row.expired) return { outcome: 'expired' } satisfies EmailRedemption
      if (row.inboundAt === null) return { outcome: 'nothing_sent_yet' } satisfies EmailRedemption
      if (row.code !== code.trim().toUpperCase()) {
        return { outcome: 'wrong_code' } satisfies EmailRedemption
      }
      if (provenElsewhere.has(row.address.toLowerCase())) {
        return { outcome: 'address_taken' } satisfies EmailRedemption
      }

      row.verifiedAt = currentTime()
      return { outcome: 'verified', address: row.address } satisfies EmailRedemption
    },

    async latest(agentId) {
      const row = latestFor(agentId)
      if (row === undefined) return null

      return {
        address: row.address,
        expiresAt: currentTime(),
        inboundAt: row.inboundAt,
        verifiedAt: row.verifiedAt,
      } satisfies EmailChallengeState
    },

    expire(agentId) {
      const row = latestFor(agentId)
      if (row !== undefined) row.expired = true
    },

    claimForAnother(address) {
      provenElsewhere.add(address.toLowerCase())
    },
  }
}

export function fakeEmail(challenges: EmailChallenges = fakeEmailChallenges()): EmailDependencies {
  return {
    challenges,
    challengeDomain: FAKE_CHALLENGE_DOMAIN,
    inboundSecret: FAKE_INBOUND_SECRET,
  }
}
