import { randomUUID } from 'node:crypto'
import {
  browserStage,
  CAPABILITY_STAGE,
  CAPABILITY_STEPS,
  now as currentTime,
  RETIRED_CHALLENGE_STAGE,
  type AgentId,
  type BrowserStage,
  type Timestamp,
} from '@kolonie-ai/core'
import {
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
  readonly mintExpired: (agentId: AgentId, kind?: BrowserStage) => string
}

export function fakeChallenges(): FakeChallenges {
  const rows = new Map<
    string,
    {
      agentId: AgentId
      kind: BrowserStage
      expired: boolean
      steps: number
      stepsRequired: number
      variant: string | null
      observation: unknown
      verifiedAt: Timestamp | null
    }
  >()

  /**
   * The kind filter the real reads apply, and the reason it is repeated here: a
   * fake that answered across kinds would let a test pass that the database
   * would refuse, which is the failure mode a fixture exists to avoid.
   */
  const find = (challengeId: string, kind: BrowserStage) => {
    const row = rows.get(challengeId)
    return row === undefined || row.kind !== kind ? undefined : row
  }

  return {
    async mint(agentId, kind, variant = null) {
      const id = randomUUID()
      // The step count comes from the registry, exactly as the real mint writes it
      // onto the row. A fake that guessed it would let a test pass against a
      // completeness rule the database would refuse.
      rows.set(id, {
        agentId,
        kind,
        expired: false,
        steps: 0,
        stepsRequired: browserStage(kind)?.steps ?? CAPABILITY_STEPS,
        variant,
        observation: null,
        verifiedAt: null,
      })
      const minted: MintedChallenge = { id, expiresAt: currentTime() }
      return minted
    },

    mintExpired(agentId, kind = RETIRED_CHALLENGE_STAGE) {
      const id = randomUUID()
      rows.set(id, {
        agentId,
        kind,
        expired: true,
        steps: 0,
        stepsRequired: browserStage(kind)?.steps ?? CAPABILITY_STEPS,
        variant: null,
        observation: null,
        verifiedAt: null,
      })
      return id
    },

    async redeem(challengeId): Promise<ChallengeRedemption> {
      const row = find(challengeId, RETIRED_CHALLENGE_STAGE)
      if (row === undefined) return { outcome: 'unknown' }
      if (row.verifiedAt !== null) return { outcome: 'already_verified' }
      if (row.expired) return { outcome: 'expired' }

      row.verifiedAt = currentTime()
      return { outcome: 'verified', agentId: row.agentId }
    },

    /**
     * Unfiltered by stage, matching the real read since `#160`: the answer names
     * the stage so a page can refuse an id from a neighbouring one.
     */
    async progress(challengeId): Promise<ChallengeProgress> {
      const row = rows.get(challengeId)
      if (row === undefined) return { outcome: 'unknown' }
      if (row.verifiedAt !== null) return { outcome: 'already_verified' }
      if (row.expired) return { outcome: 'expired' }

      return {
        outcome: 'open',
        stage: row.kind,
        steps: row.steps,
        total: row.stepsRequired,
        variant: row.variant,
      }
    },

    async advance(challengeId, fromStep, stage, observation): Promise<StepOutcome> {
      // Filtered by stage, matching the real write. This is the half that protects
      // the record, so the fake has to model it or a test would pass against
      // something the database refuses.
      const row = find(challengeId, stage)
      if (row === undefined) return { outcome: 'unknown' }
      if (row.verifiedAt !== null) return { outcome: 'already_verified' }
      if (row.expired) return { outcome: 'expired' }
      if (row.steps !== fromStep) return { outcome: 'out_of_order', steps: row.steps }

      row.steps = fromStep + 1
      if (observation !== undefined) row.observation = observation

      if (row.steps < row.stepsRequired) {
        return { outcome: 'advanced', steps: row.steps, total: row.stepsRequired }
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
    // Keyed by stage, as `server.ts` fills it from the registry. Values, never
    // real hosts.
    stagePages: {
      [CAPABILITY_STAGE]: 'https://challenge.example/browser/',
      [RETIRED_CHALLENGE_STAGE]: 'https://challenge.example/captcha/',
    },
    stageUnavailableReasons: {},
  }
}
