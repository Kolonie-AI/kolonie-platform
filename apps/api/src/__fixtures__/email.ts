import { randomUUID } from 'node:crypto'
import { now as currentTime, type AgentId } from '@kolonie-ai/core'
import type {
  EmailChallengeLimits,
  EmailChallengeState,
  EmailMintOutcome,
  EmailRedemption,
  InboundOutcome,
  MailboxPromotion,
} from '@kolonie-ai/db'
import {
  EMAIL_CHALLENGE_LIFETIME_CEILING,
  EMAIL_CHALLENGE_WINDOW_CAP,
  EMAIL_CHALLENGE_WINDOW_MS,
} from '@kolonie-ai/db'
import type { EmailChallenges, EmailDependencies, Mailer } from '../email.js'
import { noObstruction } from './obstruction.js'

/** The domain challenge addresses are minted under in tests. Reserved by RFC 2606. */
export const FAKE_CHALLENGE_DOMAIN = 'challenge.example'

/** The shared secret the fake inbound route expects. Not a credential shape. */
export const FAKE_INBOUND_SECRET = 'test-inbound-secret'

export interface FakeEmailChallenges extends EmailChallenges {
  /** Age the agent's open challenge past its deadline, which minting cannot produce. */
  readonly expire: (agentId: AgentId) => void
  /** Mark an address as proved by somebody else, without running a round trip. */
  readonly claimForAnother: (address: string) => void
  /**
   * Move every challenge this agent has opened out of the rolling window (#153).
   *
   * The one thing a test cannot reach by calling the surface: the window heals
   * by the passage of a month, and asserting that it heals is the point of
   * having a window rather than a cap.
   */
  readonly ageOutOfWindow: (agentId: AgentId) => void
  /**
   * Record a proved mailbox directly, the reach address being the first one.
   *
   * The round trip is exercised in the route tests; a test about *promotion*
   * needs two proved addresses and should not have to run the rung twice to say
   * something about the third call.
   */
  readonly proveDirectly: (agentId: AgentId, address: string) => void
  /**
   * Move the reach address the way it moved *before* `#287` shipped: without
   * closing an open `email-send` challenge behind it.
   *
   * The state `#307` is about, and the one thing the surface can no longer
   * produce — promotion closes the stale challenge now, so a test driving the
   * tools can only ever reach the repaired path. The citizen that reported it
   * was holding a row from before the repair, and it will keep meeting this on
   * any future path that moves the grant without coming through `promote`.
   */
  readonly moveReachSilently: (agentId: AgentId, address: string) => void
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
    /** When it was opened, which is what the rolling window counts against (#153). */
    createdAt: number
    /** When it became the reach address, or null. At most one per agent (D-047). */
    primaryAt: string | null
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

  /** Counted the way storage counts: inbox rows the Colony actually mailed for. */
  const counted = (agentId: AgentId): Row[] =>
    rows.filter((row) => row.agentId === agentId && row.purpose === 'inbox' && row.code !== null)

  const limitsFor = (agentId: AgentId): EmailChallengeLimits => {
    const all = counted(agentId)
    const since = Date.now() - EMAIL_CHALLENGE_WINDOW_MS
    const inWindow = all.filter((row) => row.createdAt >= since)
    const oldest = inWindow.map((row) => row.createdAt).sort((a, b) => a - b)[0]

    return {
      windowCap: EMAIL_CHALLENGE_WINDOW_CAP,
      windowMs: EMAIL_CHALLENGE_WINDOW_MS,
      ceiling: EMAIL_CHALLENGE_LIFETIME_CEILING,
      openedInWindow: inWindow.length,
      openedEver: all.length,
      nextAvailableAt:
        inWindow.length < EMAIL_CHALLENGE_WINDOW_CAP || oldest === undefined
          ? null
          : new Date(oldest + EMAIL_CHALLENGE_WINDOW_MS).toISOString(),
    }
  }

  return {
    async mint(agentId, address) {
      const open = openFor(agentId, 'inbox')

      if (open !== undefined) {
        return {
          outcome: 'open',
          address: open.address,
          // `identity` is this fixture's stand-in for `mailboxIdentity`, which is
          // where the real comparison happens. Mirrored rather than reduced to
          // `===`, or the fixture would let a `+tag` pass a test the database
          // would refuse.
          matchesRequested: identity(open.address) === identity(address),
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

      const limits = limitsFor(agentId)

      if (limits.openedEver >= EMAIL_CHALLENGE_LIFETIME_CEILING) {
        return { outcome: 'ceiling_reached', limits } satisfies EmailMintOutcome
      }

      if (limits.openedInWindow >= EMAIL_CHALLENGE_WINDOW_CAP) {
        return {
          outcome: 'window_reached',
          limits,
          retryAfter: limits.nextAvailableAt ?? currentTime(),
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
        createdAt: Date.now(),
        primaryAt: null,
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
      /**
       * The stale-challenge close from `#307`, mirrored because the API-level
       * behaviour depends on it: a challenge open against some other mailbox is
       * expired here, so what survives names the address the badge is about.
       * `identity` stands in for `mailboxIdentity` for the same reason `mint`
       * above uses it.
       */
      const stale = openFor(agentId, 'send')
      const reissued = stale !== undefined && identity(stale.address) !== identity(address)

      if (reissued) stale.expired = true

      const open = openFor(agentId, 'send')

      if (open !== undefined) {
        return {
          outcome: 'open',
          address: open.address,
          // The badge reads its address from the grant, so there is nothing the
          // caller could have named differently. Same value the real storage
          // returns here, and for the same reason.
          matchesRequested: true,
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
        createdAt: Date.now(),
        primaryAt: null,
      })

      return {
        outcome: 'minted',
        challenge: { id: token, token, expiresAt: currentTime(), code: '' },
        reissued,
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
      // The reach address, not merely a verified one — the same read D-047 made
      // storage do, and the reason the badge's subject stopped moving.
      const row = rows.find(
        (candidate) =>
          candidate.agentId === agentId &&
          candidate.purpose === 'inbox' &&
          candidate.verifiedAt !== null &&
          candidate.primaryAt !== null,
      )

      return row === undefined
        ? undefined
        : { address: row.address, grantedAt: row.verifiedAt ?? currentTime() }
    },

    async held(agentId) {
      return rows
        .filter(
          (row) => row.agentId === agentId && row.purpose === 'inbox' && row.verifiedAt !== null,
        )
        .sort((a, b) => Number(b.primaryAt !== null) - Number(a.primaryAt !== null))
        .map((row) => ({
          address: row.address,
          grantedAt: row.verifiedAt ?? currentTime(),
          reach: row.primaryAt !== null,
        }))
    },

    async promote(agentId, address) {
      const target = rows.find(
        (row) =>
          row.agentId === agentId &&
          row.purpose === 'inbox' &&
          row.verifiedAt !== null &&
          identity(row.address) === identity(address),
      )

      if (target === undefined) return { outcome: 'not_proved' } satisfies MailboxPromotion
      if (target.primaryAt !== null) {
        return { outcome: 'already_primary', address: target.address } satisfies MailboxPromotion
      }

      for (const row of rows) {
        if (row.agentId === agentId) row.primaryAt = null
      }
      target.primaryAt = currentTime()

      // The same close storage does, and for the reason `promoteMailbox`
      // documents (#287): an open send challenge minted against the address that
      // has just stopped being the reach address can no longer be satisfied.
      const stale = rows.filter(
        (row) =>
          row.agentId === agentId &&
          row.purpose === 'send' &&
          row.verifiedAt === null &&
          !row.expired &&
          identity(row.address) !== identity(target.address),
      )

      for (const row of stale) row.expired = true

      return {
        outcome: 'promoted',
        address: target.address,
        sendChallengeClosed: stale.length > 0,
      } satisfies MailboxPromotion
    },

    async limits(agentId) {
      return limitsFor(agentId)
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
      // The first proved address becomes the reach address and a later one does
      // not take over (D-047). Mirrored here because `proved` reads the stamp.
      if (
        !rows.some((candidate) => candidate.agentId === agentId && candidate.primaryAt !== null)
      ) {
        row.primaryAt = currentTime()
      }
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

    moveReachSilently(agentId, address) {
      const target = rows.find(
        (row) =>
          row.agentId === agentId &&
          row.purpose === 'inbox' &&
          row.verifiedAt !== null &&
          identity(row.address) === identity(address),
      )

      if (target === undefined) throw new Error(`${address} is not a proved mailbox`)

      for (const row of rows) {
        if (row.agentId === agentId && row.purpose === 'inbox') row.primaryAt = null
      }

      target.primaryAt = currentTime()
    },

    ageOutOfWindow(agentId) {
      for (const row of rows) {
        if (row.agentId === agentId) row.createdAt -= EMAIL_CHALLENGE_WINDOW_MS + 1000
      }
    },

    proveDirectly(agentId, address) {
      const first = !rows.some((row) => row.agentId === agentId && row.primaryAt !== null)

      rows.push({
        agentId,
        address,
        token: randomUUID().replace(/-/g, '').slice(0, 18),
        purpose: 'inbox',
        expired: false,
        sentAt: currentTime(),
        inboundAt: null,
        code: randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase(),
        verifiedAt: currentTime(),
        createdAt: Date.now(),
        primaryAt: first ? currentTime() : null,
      })
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
    obstruction: noObstruction,
  }
}
