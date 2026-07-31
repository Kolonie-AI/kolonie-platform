import { randomUUID } from 'node:crypto'
import { now as currentTime, type AgentId } from '@kolonie-ai/core'
import type {
  EmailChallengeState,
  EmailMintOutcome,
  EmailRedemption,
  InboundOutcome,
} from '@kolonie-ai/db'
import { EMAIL_CHALLENGE_LIFETIME_CAP } from '@kolonie-ai/db'
import type { EmailChallenges, EmailDependencies, Mailer } from '../email.js'

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
    purpose: 'inbox' | 'send'
    expired: boolean
    sentAt: string | null
    inboundAt: string | null
    code: string | null
    verifiedAt: string | null
  }

  const rows: Row[] = []
  const provenElsewhere = new Set<string>()

  /** The identity rule from D-044, small enough to mirror and worth mirroring. */
  const identity = (value: string): string => {
    const at = value.lastIndexOf('@')
    if (at <= 0) return value.toLowerCase()
    const local = value.slice(0, at).toLowerCase()
    const tagged = local.indexOf('+')
    return `${tagged === -1 ? local : local.slice(0, tagged)}@${value.slice(at + 1).toLowerCase()}`
  }

  const latestFor = (agentId: AgentId, purpose: 'inbox' | 'send' = 'inbox'): Row | undefined =>
    // Verified first, then newest — the same ordering the real query applies,
    // and the reason it exists: a later abandoned attempt must not make a
    // citizen that passed read as unverified.
    [...rows]
      .filter((row) => row.agentId === agentId && row.purpose === purpose)
      .sort((a, b) => Number(b.verifiedAt !== null) - Number(a.verifiedAt !== null))[0]

  const openFor = (agentId: AgentId, purpose: 'inbox' | 'send'): Row | undefined =>
    rows.find(
      (row) =>
        row.agentId === agentId &&
        row.purpose === purpose &&
        row.verifiedAt === null &&
        !row.expired,
    )

  return {
    async mint(agentId, address) {
      const open = openFor(agentId, 'inbox')

      if (open !== undefined) {
        return {
          outcome: 'open',
          challenge: {
            id: open.token,
            token: open.token,
            expiresAt: currentTime(),
            code: open.code ?? '',
          },
          sent: open.sentAt !== null,
        } satisfies EmailMintOutcome
      }

      const taken =
        provenElsewhere.has(identity(address)) ||
        rows.some(
          (row) =>
            row.verifiedAt !== null &&
            row.purpose === 'inbox' &&
            row.agentId !== agentId &&
            identity(row.address) === identity(address),
        )

      if (taken) return { outcome: 'address_taken' } satisfies EmailMintOutcome

      const opened = rows.filter((row) => row.agentId === agentId && row.purpose === 'inbox').length

      if (opened >= EMAIL_CHALLENGE_LIFETIME_CAP) {
        return {
          outcome: 'cap_reached',
          cap: EMAIL_CHALLENGE_LIFETIME_CAP,
        } satisfies EmailMintOutcome
      }

      const token = randomUUID().replace(/-/g, '').slice(0, 18)
      const code = randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()
      rows.push({
        agentId,
        address,
        token,
        purpose: 'inbox',
        expired: false,
        sentAt: null,
        inboundAt: null,
        code,
        verifiedAt: null,
      })

      return {
        outcome: 'minted',
        challenge: { id: token, token, expiresAt: currentTime(), code },
      } satisfies EmailMintOutcome
    },

    async markSent(challengeId) {
      const row = rows.find((candidate) => candidate.token === challengeId)
      if (row !== undefined && row.sentAt === null) row.sentAt = currentTime()
    },

    async mintSend(agentId, address) {
      const open = openFor(agentId, 'send')

      if (open !== undefined) {
        return {
          outcome: 'open',
          challenge: {
            id: open.token,
            token: open.token,
            expiresAt: currentTime(),
            code: '',
          },
          sent: true,
        } satisfies EmailMintOutcome
      }

      const token = randomUUID().replace(/-/g, '').slice(0, 18)
      rows.push({
        agentId,
        address,
        token,
        purpose: 'send',
        expired: false,
        sentAt: null,
        inboundAt: null,
        code: null,
        verifiedAt: null,
      })

      return {
        outcome: 'minted',
        challenge: { id: token, token, expiresAt: currentTime(), code: '' },
      } satisfies EmailMintOutcome
    },

    async latestSend(agentId) {
      const row = latestFor(agentId, 'send')
      if (row === undefined) return null

      return {
        address: row.address,
        expiresAt: currentTime(),
        sentAt: row.sentAt,
        inboundAt: row.inboundAt,
        verifiedAt: row.verifiedAt,
      } satisfies EmailChallengeState
    },

    async proved(agentId) {
      const row = rows.find(
        (candidate) =>
          candidate.agentId === agentId &&
          candidate.purpose === 'inbox' &&
          candidate.verifiedAt !== null,
      )

      return row === undefined
        ? undefined
        : { address: row.address, grantedAt: row.verifiedAt ?? currentTime() }
    },

    async inbound(token, from) {
      const row = rows.find(
        (candidate) => candidate.token === token && candidate.purpose === 'send',
      )

      if (row === undefined) return { outcome: 'unknown_token' } satisfies InboundOutcome
      if (identity(row.address) !== identity(from)) {
        return { outcome: 'sender_mismatch' } satisfies InboundOutcome
      }
      if (row.inboundAt !== null) {
        return { outcome: 'already_received', address: row.address } satisfies InboundOutcome
      }
      if (row.expired) return { outcome: 'expired' } satisfies InboundOutcome

      row.inboundAt = currentTime()
      row.verifiedAt = currentTime()

      return { outcome: 'accepted', address: row.address } satisfies InboundOutcome
    },

    async redeem(agentId, code) {
      const row = latestFor(agentId)

      if (row === undefined) return { outcome: 'no_open_challenge' } satisfies EmailRedemption
      if (row.verifiedAt !== null) {
        return { outcome: 'verified', address: row.address } satisfies EmailRedemption
      }
      if (row.expired) return { outcome: 'expired' } satisfies EmailRedemption
      if (row.sentAt === null) return { outcome: 'nothing_sent_yet' } satisfies EmailRedemption
      if (row.code !== code.trim().toUpperCase()) {
        return { outcome: 'wrong_code' } satisfies EmailRedemption
      }
      if (provenElsewhere.has(identity(row.address))) {
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
        sentAt: row.sentAt,
        inboundAt: row.inboundAt,
        verifiedAt: row.verifiedAt,
      } satisfies EmailChallengeState
    },

    expire(agentId) {
      // The *open* row, not "the latest": the one-open-challenge rule is what a
      // caller is trying to get past, and `latestFor` sorts verified rows first
      // so it would keep expiring the same one.
      const row = openFor(agentId, 'inbox') ?? latestFor(agentId)
      if (row !== undefined) row.expired = true
    },

    claimForAnother(address) {
      provenElsewhere.add(identity(address))
    },
  }
}

/** Records what the Colony tried to send, and can be told to fail. */
export interface FakeMailer extends Mailer {
  readonly sent: { to: string; subject: string; text: string }[]
  /** Make the next and every following send fail, as an outage would. */
  readonly breakIt: () => void
  /** Bring it back, so a retry can be asserted rather than only a failure. */
  readonly fixIt: () => void
}

export function fakeMailer(): FakeMailer {
  const sent: { to: string; subject: string; text: string }[] = []
  let broken = false

  return {
    sent,
    breakIt() {
      broken = true
    },
    fixIt() {
      broken = false
    },
    async send(message) {
      if (broken) return { delivered: false, reason: 'mailer is down' }
      sent.push({ ...message })
      return { delivered: true }
    },
  }
}

export function fakeEmail(
  challenges: EmailChallenges = fakeEmailChallenges(),
  mailer: Mailer = fakeMailer(),
): EmailDependencies {
  return {
    challenges,
    mailer,
    challengeDomain: FAKE_CHALLENGE_DOMAIN,
    inboundSecret: FAKE_INBOUND_SECRET,
  }
}
