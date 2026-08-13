import type { BadgesAwarded, RewardedWalk } from '@kolonie-ai/db'
import type { AttributionOutcome } from './attribution.js'
import { STALE_POLLS, type LoopUnderWatch } from './health.js'
import { startRunner, type Log, type RunnerHealth, type SweepSpec } from './loop.js'

/** A loop that is both started by the process and reported by its health server. */
export interface RunnerLoop extends LoopUnderWatch {
  start(): NodeJS.Timeout
}

/**
 * Build the badge runner's complete loop set without starting the process.
 *
 * Keeping the start thunk beside the health entry makes one array the source of
 * truth for both jobs, so a loop cannot be reported without also being started.
 */
export function runnerLoops(options: {
  readonly badges: SweepSpec<BadgesAwarded>
  readonly attribution: SweepSpec<AttributionOutcome>
  readonly walkRewards: SweepSpec<readonly RewardedWalk[]>
  readonly log: Log
  readonly badgeIntervalMs: number
  readonly attributionIntervalMs: number
  readonly walkRewardIntervalMs: number
}): readonly RunnerLoop[] {
  const badges: RunnerHealth = { running: false, lastPollAt: null, consecutiveFailures: 0 }
  const attribution: RunnerHealth = { running: false, lastPollAt: null, consecutiveFailures: 0 }
  const walkRewards: RunnerHealth = { running: false, lastPollAt: null, consecutiveFailures: 0 }

  return [
    {
      name: 'badges',
      health: () => badges,
      staleAfterMs: options.badgeIntervalMs * STALE_POLLS,
      gatesReadiness: true,
      start: () => startRunner(options.badges, options.log, badges, options.badgeIntervalMs),
    },
    {
      name: 'attribution',
      health: () => attribution,
      staleAfterMs: options.attributionIntervalMs * STALE_POLLS,
      gatesReadiness: false,
      start: () =>
        startRunner(options.attribution, options.log, attribution, options.attributionIntervalMs),
    },
    {
      name: 'walk-rewards',
      health: () => walkRewards,
      staleAfterMs: options.walkRewardIntervalMs * STALE_POLLS,
      /**
       * **It does not gate readiness** (`#858`), on `attribution`'s reasoning
       * rather than `badges`'. A pass that has not run yet means a citizen waits
       * a few hours to be paid for an entry a steward published; it does not
       * mean the process is unhealthy, and taking the container out of service
       * for it would stop the badge sweep too.
       */
      gatesReadiness: false,
      start: () =>
        startRunner(options.walkRewards, options.log, walkRewards, options.walkRewardIntervalMs),
    },
  ]
}
