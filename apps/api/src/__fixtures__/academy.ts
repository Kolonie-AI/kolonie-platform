import { randomUUID } from 'node:crypto'
import { now as currentTime, type AgentId, type Timestamp } from '@kolonie-ai/core'
import {
  CAPABILITY_STEPS,
  type ChallengeKind,
  type ChallengeProgress,
  type ChallengeRedemption,
  type MintedChallenge,
  type StepOutcome,
} from '@kolonie-ai/db'
import type { AcademyDependencies, CaptchaCheck, CaptchaService, Challenges } from '../academy.js'

/**
 * An in-memory browser challenge store, for both kinds.
 *
 * Reproduces exactly what the routes depend on: which agent a challenge belongs
 * to, which kind it is, how far it has got, and whether it is still live.
 * Whether the real advance is safe against two reports racing on one step is
 * asserted in `packages/db` against a real Postgres, because that is a property
 * of the `UPDATE … WHERE` and not of anything this file can model.
 */
export interface FakeChallenges extends Challenges {
  /** Mint an already-expired challenge, which minting normally cannot produce. */
  readonly mintExpired: (agentId: AgentId, kind?: ChallengeKind) => string
}

export function fakeChallenges(): FakeChallenges {
  const rows = new Map<
    string,
    {
      agentId: AgentId
      kind: ChallengeKind
      expired: boolean
      steps: number
      verifiedAt: Timestamp | null
    }
  >()

  /**
   * The kind filter the real reads apply, and the reason it is repeated here: a
   * fake that answered across kinds would let a test pass that the database
   * would refuse, which is the failure mode a fixture exists to avoid.
   */
  const find = (challengeId: string, kind: ChallengeKind) => {
    const row = rows.get(challengeId)
    return row === undefined || row.kind !== kind ? undefined : row
  }

  return {
    async mint(agentId, kind) {
      const id = randomUUID()
      rows.set(id, { agentId, kind, expired: false, steps: 0, verifiedAt: null })
      const minted: MintedChallenge = { id, expiresAt: currentTime() }
      return minted
    },

    mintExpired(agentId, kind = 'captcha') {
      const id = randomUUID()
      rows.set(id, { agentId, kind, expired: true, steps: 0, verifiedAt: null })
      return id
    },

    async redeem(challengeId): Promise<ChallengeRedemption> {
      const row = find(challengeId, 'captcha')
      if (row === undefined) return { outcome: 'unknown' }
      if (row.verifiedAt !== null) return { outcome: 'already_verified' }
      if (row.expired) return { outcome: 'expired' }

      row.verifiedAt = currentTime()
      return { outcome: 'verified', agentId: row.agentId }
    },

    async progress(challengeId): Promise<ChallengeProgress> {
      const row = find(challengeId, 'capability')
      if (row === undefined) return { outcome: 'unknown' }
      if (row.verifiedAt !== null) return { outcome: 'already_verified' }
      if (row.expired) return { outcome: 'expired' }

      return { outcome: 'open', steps: row.steps, total: CAPABILITY_STEPS }
    },

    async advance(challengeId, fromStep): Promise<StepOutcome> {
      const row = find(challengeId, 'capability')
      if (row === undefined) return { outcome: 'unknown' }
      if (row.verifiedAt !== null) return { outcome: 'already_verified' }
      if (row.expired) return { outcome: 'expired' }
      if (row.steps !== fromStep) return { outcome: 'out_of_order', steps: row.steps }

      row.steps = fromStep + 1

      if (row.steps < CAPABILITY_STEPS) {
        return { outcome: 'advanced', steps: row.steps, total: CAPABILITY_STEPS }
      }

      row.verifiedAt = currentTime()
      return { outcome: 'cleared', agentId: row.agentId }
    },

    async clearedAt(agentId, kind) {
      for (const row of rows.values()) {
        if (row.agentId === agentId && row.kind === kind && row.verifiedAt !== null) {
          return row.verifiedAt
        }
      }
      return null
    },
  }
}

/** An hCaptcha that answers however the test needs it to, and never over a network. */
export function fakeCaptcha(answer: CaptchaCheck = 'passed'): CaptchaService {
  return { sitekey: 'test-sitekey', check: async () => answer }
}

/** The gate, wired to fakes. Both page URLs are values, never real hosts. */
export function fakeAcademy(
  answer: CaptchaCheck = 'passed',
  challenges: Challenges = fakeChallenges(),
): AcademyDependencies {
  return {
    challenges,
    captcha: fakeCaptcha(answer),
    challengePageUrl: 'https://challenge.example/captcha/',
    capabilityPageUrl: 'https://challenge.example/browser/',
  }
}
