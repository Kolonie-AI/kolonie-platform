import { randomUUID } from 'node:crypto'
import { now as currentTime, type AgentId, type Timestamp } from '@kolonie-ai/core'
import type { ChallengeRedemption, MintedChallenge } from '@kolonie-ai/db'
import type { AcademyDependencies, CaptchaCheck, CaptchaService, Challenges } from '../academy.js'

/**
 * An in-memory Browser Capability Gate.
 *
 * Reproduces exactly what the routes depend on: which agent a challenge belongs
 * to, whether it has been redeemed, and whether it is still live. Whether the
 * real redemption is safe against two forms racing on one id is asserted in
 * `packages/db` against a real Postgres, because that is a property of the
 * `UPDATE … WHERE` and not of anything this file can model.
 */
export interface FakeChallenges extends Challenges {
  /** Mint an already-expired challenge, which minting normally cannot produce. */
  readonly mintExpired: (agentId: AgentId) => string
}

export function fakeChallenges(): FakeChallenges {
  const rows = new Map<
    string,
    { agentId: AgentId; expired: boolean; verifiedAt: Timestamp | null }
  >()

  return {
    async mint(agentId) {
      const id = randomUUID()
      rows.set(id, { agentId, expired: false, verifiedAt: null })
      const minted: MintedChallenge = { id, expiresAt: currentTime() }
      return minted
    },

    mintExpired(agentId) {
      const id = randomUUID()
      rows.set(id, { agentId, expired: true, verifiedAt: null })
      return id
    },

    async redeem(challengeId): Promise<ChallengeRedemption> {
      const row = rows.get(challengeId)
      if (row === undefined) return { outcome: 'unknown' }
      if (row.verifiedAt !== null) return { outcome: 'already_verified' }
      if (row.expired) return { outcome: 'expired' }

      row.verifiedAt = currentTime()
      return { outcome: 'verified', agentId: row.agentId }
    },

    async clearedAt(agentId) {
      for (const row of rows.values()) {
        if (row.agentId === agentId && row.verifiedAt !== null) return row.verifiedAt
      }
      return null
    },
  }
}

/** An hCaptcha that answers however the test needs it to, and never over a network. */
export function fakeCaptcha(answer: CaptchaCheck = 'passed'): CaptchaService {
  return { sitekey: 'test-sitekey', check: async () => answer }
}

/** The gate, wired to fakes. `challengePageUrl` is a value, never a real host. */
export function fakeAcademy(
  answer: CaptchaCheck = 'passed',
  challenges: Challenges = fakeChallenges(),
): AcademyDependencies {
  return {
    challenges,
    captcha: fakeCaptcha(answer),
    challengePageUrl: 'https://challenge.example/captcha/',
  }
}
