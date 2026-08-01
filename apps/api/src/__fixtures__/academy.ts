import { randomUUID } from 'node:crypto'
import {
  BROWSER_STAGES,
  browserStage,
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
import { noObstruction } from './obstruction.js'

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
  /**
   * What was recorded as this challenge's observation.
   *
   * Test-only, and it exists for one assertion worth having: that nothing about
   * timing, jitter or human-likeness reaches the record (`#163`). That prohibition is
   * the sort a later reader relaxes as an obvious improvement, so it is pinned to the
   * stored shape rather than left in prose — which means a test needs to see the
   * stored shape.
   */
  readonly observationOf: (challengeId: string) => unknown
  /**
   * Move a challenge's start into the past, so the later-session rule can be exercised
   * without waiting six hours for it.
   */
  readonly startedAgo: (
    challengeId: string,
    hours: number,
    declaredRhythmHours?: number | null,
  ) => void
}

export function fakeChallenges(): FakeChallenges {
  const rows = new Map<
    string,
    {
      agentId: AgentId
      kind: BrowserStage
      startedAt: Timestamp
      declaredRhythmHours: number | null
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
        startedAt: currentTime(),
        declaredRhythmHours: null,
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
        startedAt: currentTime(),
        declaredRhythmHours: null,
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
        observation: row.observation,
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

    async observe(challengeId, stage, observation) {
      const row = find(challengeId, stage)
      if (row === undefined) return 'unknown'
      if (row.verifiedAt !== null) return 'already_verified'
      if (row.expired) return 'expired'

      row.observation = observation
      return 'recorded'
    },

    /**
     * The persistence context, from the fake's own rows.
     *
     * `startedAt` is mutable through `startedAgo` below, because the one thing this stage
     * measures is a gap of hours and no test can wait for one.
     */
    async persistenceContextOf(challengeId, stage) {
      const row = find(challengeId, stage)
      if (row === undefined) return undefined
      return {
        startedAt: row.startedAt,
        declaredRhythmHours: row.declaredRhythmHours,
        sessionId: null,
      }
    },

    /**
     * Age a challenge into the past, and optionally give its citizen a declared rhythm.
     *
     * **The only way to test a rule about hours without waiting for them.** The real gap is
     * read from the challenge's own `created_at` and the citizen's declaration, so moving
     * those two is exactly the state a genuinely later session produces.
     */
    startedAgo(challengeId, hours, declaredRhythmHours = null) {
      const row = rows.get(challengeId)
      if (row === undefined) return
      row.startedAt = new Date(Date.now() - hours * 3_600_000).toISOString() as Timestamp
      row.declaredRhythmHours = declaredRhythmHours
    },

    observationOf(challengeId) {
      return rows.get(challengeId)?.observation ?? null
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
    /**
     * Keyed by stage and **built from the registry**, exactly as `server.ts` does.
     *
     * Listing the stages here instead was the first version, and it made every new
     * stage arrive with its route tests failing on a 500 from a missing page — a
     * fixture teaching a lesson about itself rather than about the code. Derived, a
     * stage is configured in tests by existing.
     *
     * Values, never real hosts: `AGENTS.md` §3 applies to fixtures too.
     */
    stagePages: Object.fromEntries(
      BROWSER_STAGES.map((stage) => [stage.kind, `https://challenge.example${stage.pagePath}`]),
    ),
    stageUnavailableReasons: {},
    obstruction: noObstruction,
  }
}
