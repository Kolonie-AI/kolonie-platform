import { randomUUID } from 'node:crypto'
import { now as currentTime, type AgentId, type Timestamp } from '@kolonie-ai/core'
import type {
  InboundSmsOutcome,
  SmsChallengeState,
  SmsMintOutcome,
  SmsRedemption,
} from '@kolonie-ai/db'
import type { GuardedSender, SmsChallengeStore, SmsDependencies } from '../sms.js'
import { noObstruction } from './obstruction.js'

/**
 * The two phone rungs in memory (`#411`).
 *
 * **Every number here is invented and belongs to nobody.** `+15005550006` is
 * Twilio's own documented magic number for a valid destination and
 * `+15005550001` for an invalid one — neither reaches a person, which is why
 * they are the right fixtures for a file that will be read by people looking for
 * a number to copy. The Colony's own sending number is public by design and is
 * still not written here: the fixture invents one, because a test that hard-codes
 * a real deployment's identifier fails when the deployment changes.
 */

/** A destination the fake sender accepts. Twilio's documented magic number. */
export const FAKE_CITIZEN_NUMBER = '+15005550006'

/** A second one, for the tests about one number certifying one citizen. */
export const FAKE_OTHER_NUMBER = '+15005550007'

/** The Colony's number in tests. Invented — see the note above. */
export const FAKE_COLONY_NUMBER = '+15005550000'

export interface FakeSmsStore extends SmsChallengeStore {
  /** Age the citizen's open challenge past its deadline, which minting cannot produce. */
  readonly expire: (agentId: AgentId) => void
  /** Mark a number as already certifying somebody else, without running a round trip. */
  readonly claimForAnother: (number: string) => void
  /** The code the Colony would have texted, which no surface ever serves. */
  readonly codeFor: (agentId: AgentId) => string | undefined
  /** The nonce the Colony issued for the badge. */
  readonly nonceFor: (agentId: AgentId) => string | undefined
}

export interface FakeSender extends GuardedSender {
  /** Every message the Colony asked to have sent. */
  readonly sent: () => readonly { readonly to: string; readonly body: string }[]
  /** Refuse the next send, the way a destination off the allowlist or a full cap does. */
  readonly refuseNext: (reason: string) => void
}

export function fakeSmsStore(): FakeSmsStore {
  interface Row {
    id: string
    agentId: AgentId
    number: string | null
    purpose: 'receive' | 'send'
    code: string | null
    nonce: string | null
    expired: boolean
    sentAt: string | null
    sendFailure: string | null
    inboundAt: string | null
    inboundFrom: string | null
    verifiedAt: string | null
    createdAt: number
  }

  const rows: Row[] = []
  const provenElsewhere = new Set<string>()

  /** The identity rule from `schema/sms.ts`, small enough to mirror and worth mirroring. */
  const identity = (number: string): string => number.replace(/[^0-9+]/g, '')

  const open = (agentId: AgentId, purpose: Row['purpose']): Row | undefined =>
    rows
      .filter(
        (row) =>
          row.agentId === agentId &&
          row.purpose === purpose &&
          row.verifiedAt === null &&
          !row.expired,
      )
      .at(-1)

  const takenByAnother = (agentId: AgentId, number: string): boolean =>
    provenElsewhere.has(identity(number)) ||
    rows.some(
      (row) =>
        row.agentId !== agentId &&
        row.verifiedAt !== null &&
        identity(row.number ?? row.inboundFrom ?? '') === identity(number),
    )

  const state = (row: Row): SmsChallengeState => ({
    purpose: row.purpose,
    number: row.number,
    expiresAt: new Date(
      row.expired ? Date.now() - 1000 : Date.now() + 60_000,
    ).toISOString() as Timestamp,
    sentAt: row.sentAt as Timestamp | null,
    sendFailure: row.sendFailure,
    inboundAt: row.inboundAt as Timestamp | null,
    inboundFrom: row.inboundFrom,
    // The same evidence the database derives it from (`#579`): a send only
    // claims the number when the citizen already proved it can be reached there.
    ownsSendingNumber:
      row.verifiedAt !== null &&
      row.inboundFrom !== null &&
      rows.some(
        (other) =>
          other.agentId === row.agentId &&
          other.purpose === 'receive' &&
          other.verifiedAt !== null &&
          identity(other.number ?? '') === identity(row.inboundFrom ?? ''),
      ),
    verifiedAt: row.verifiedAt as Timestamp | null,
  })

  return {
    async mint(agentId, number, replace): Promise<SmsMintOutcome> {
      const existing = open(agentId, 'receive')
      if (existing !== undefined) {
        const matchesRequested = identity(existing.number ?? '') === identity(number)
        if (matchesRequested || !replace || existing.sentAt !== null) {
          return {
            outcome: 'open',
            matchesRequested,
            sent: existing.sentAt !== null,
            challenge: {
              id: existing.id,
              number: existing.number ?? number,
              expiresAt: state(existing).expiresAt,
              code: existing.code ?? '',
            },
          }
        }

        if (takenByAnother(agentId, number)) return { outcome: 'number_taken' }
        existing.expired = true
      }

      if (existing === undefined && takenByAnother(agentId, number)) {
        return { outcome: 'number_taken' }
      }

      const row: Row = {
        id: randomUUID(),
        agentId,
        number,
        purpose: 'receive',
        code: '424242',
        nonce: null,
        expired: false,
        sentAt: null,
        sendFailure: null,
        inboundAt: null,
        inboundFrom: null,
        verifiedAt: null,
        createdAt: Date.now(),
      }
      rows.push(row)

      return {
        outcome: 'minted',
        challenge: {
          id: row.id,
          number,
          expiresAt: state(row).expiresAt,
          code: row.code ?? '',
        },
      }
    },

    async markSent(challengeId) {
      const row = rows.find((candidate) => candidate.id === challengeId)
      if (row !== undefined) {
        row.sentAt = currentTime()
        row.sendFailure = null
      }
    },

    async markSendFailed(challengeId, reason) {
      const row = rows.find((candidate) => candidate.id === challengeId)
      if (row !== undefined) row.sendFailure = reason
    },

    async redeem(agentId, code): Promise<SmsRedemption> {
      const row = open(agentId, 'receive')

      if (row === undefined) {
        const settled = rows.filter((candidate) => candidate.agentId === agentId).at(-1)
        if (settled === undefined) return { outcome: 'no_open_challenge' }
        if (settled.verifiedAt !== null) {
          return { outcome: 'verified', number: settled.number ?? '' }
        }
        return { outcome: 'expired' }
      }

      if (row.sentAt === null) return { outcome: 'nothing_sent_yet' }
      if (row.code !== code.trim()) return { outcome: 'wrong_code' }
      if (takenByAnother(agentId, row.number ?? '')) return { outcome: 'number_taken' }

      row.verifiedAt = currentTime()
      return { outcome: 'verified', number: row.number ?? '' }
    },

    async mintSend(agentId) {
      const existing = open(agentId, 'send')
      if (existing?.nonce != null) {
        return { nonce: existing.nonce, expiresAt: state(existing).expiresAt, reused: true }
      }

      const row: Row = {
        id: randomUUID(),
        agentId,
        number: null,
        purpose: 'send',
        code: null,
        nonce: randomUUID().replaceAll('-', '').slice(0, 18),
        expired: false,
        sentAt: null,
        sendFailure: null,
        inboundAt: null,
        inboundFrom: null,
        verifiedAt: null,
        createdAt: Date.now(),
      }
      rows.push(row)

      return { nonce: row.nonce ?? '', expiresAt: state(row).expiresAt, reused: false }
    },

    async recordInbound(message): Promise<InboundSmsOutcome> {
      const row = rows.find(
        (candidate) =>
          candidate.purpose === 'send' &&
          candidate.nonce !== null &&
          candidate.verifiedAt === null &&
          !candidate.expired &&
          message.body.toLowerCase().includes(candidate.nonce.toLowerCase()),
      )

      if (row === undefined) return { outcome: 'unmatched' }
      if (takenByAnother(row.agentId, message.from)) {
        return { outcome: 'number_taken', agentId: row.agentId }
      }

      row.inboundAt = message.receivedAt
      // **From the message and never from anything a citizen submitted**, which
      // is the property the badge exists for. A fixture that took this from an
      // argument would let a test pass that the real path could not.
      row.inboundFrom = message.from
      row.verifiedAt = currentTime()

      return { outcome: 'matched', agentId: row.agentId, from: message.from }
    },

    async latest(agentId, purpose) {
      const row = rows
        .filter((candidate) => candidate.agentId === agentId && candidate.purpose === purpose)
        .at(-1)
      return row === undefined ? null : state(row)
    },

    expire(agentId) {
      for (const row of rows) if (row.agentId === agentId) row.expired = true
    },

    claimForAnother(number) {
      provenElsewhere.add(identity(number))
    },

    codeFor(agentId) {
      return (
        rows.filter((row) => row.agentId === agentId && row.code !== null).at(-1)?.code ?? undefined
      )
    },

    nonceFor(agentId) {
      return (
        rows.filter((row) => row.agentId === agentId && row.nonce !== null).at(-1)?.nonce ??
        undefined
      )
    },
  }
}

export function fakeSender(): FakeSender {
  const sent: { to: string; body: string }[] = []
  let refusal: string | null = null

  return {
    async send(_agentId, to, body) {
      if (refusal !== null) {
        const reason = refusal
        refusal = null
        return { outcome: 'refused', reason }
      }
      sent.push({ to, body })
      return { outcome: 'sent' }
    },
    sent: () => sent,
    refuseNext(reason) {
      refusal = reason
    },
  }
}

export function fakeSms(
  challenges: SmsChallengeStore = fakeSmsStore(),
  sender: GuardedSender = fakeSender(),
): SmsDependencies {
  return {
    challenges,
    sender,
    colonyNumber: FAKE_COLONY_NUMBER,
    obstruction: noObstruction,
  }
}
