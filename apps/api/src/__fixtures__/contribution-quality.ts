import {
  ABUSIVE_SUSPEND_MIN_COUNT,
  ABUSIVE_SUSPEND_MIN_RATE,
  ABUSIVE_SUSPEND_WINDOW_DAYS,
  ABUSIVE_WARN_MIN_COUNT,
  type AgentId,
  type ContributionQualityAnswer,
  type ContributionSurface,
} from '@kolonie-ai/core'
import type { ContributionQualitySource } from '../contribution-quality.js'

const EMPTY_SURFACES = [
  'walk-report',
  'task-report',
  'playbook-note',
  'step-proposal',
  'quest-report',
  'playbook-draft',
] as const satisfies readonly ContributionSurface[]

/** An empty ledger — the ordinary state most tests are not about (`#1262`). */
export function emptyContributionQualityAnswer(): ContributionQualityAnswer {
  const bySurface = Object.fromEntries(
    EMPTY_SURFACES.map((surface) => [surface, { approved: 0, useless: 0, abusive: 0 }]),
  ) as ContributionQualityAnswer['bySurface']

  return {
    windowDays: ABUSIVE_SUSPEND_WINDOW_DAYS,
    bySurface,
    totals: { approved: 0, useless: 0, abusive: 0, judged: 0 },
    abusiveReasons: [],
    standing: {
      abusive: 0,
      judged: 0,
      rate: null,
      warnAt: ABUSIVE_WARN_MIN_COUNT,
      suspendMinCount: ABUSIVE_SUSPEND_MIN_COUNT,
      suspendMinRate: ABUSIVE_SUSPEND_MIN_RATE,
      meetsSuspendBounds: false,
      measures: 'abusive-verdict-rate',
      uselessCountsToward: 'nothing',
    },
    suspension: null,
  }
}

/**
 * A contribution-quality source for tests (`#1262`).
 *
 * Defaults to an empty ledger and no wakeup warning. Override `quality` or
 * `warning` when a test is about either.
 */
export function fakeContributionQuality(options?: {
  quality?: ContributionQualityAnswer | ((agentId: AgentId, now: Date) => ContributionQualityAnswer)
  warning?: string | null | ((agentId: AgentId, now: Date) => string | null)
}): ContributionQualitySource & {
  /** Every `qualityFor` call, in order — for no-state / privacy assertions. */
  readonly qualityAsked: () => ReadonlyArray<{ agentId: AgentId; now: Date }>
  /** Every `warningFor` call, in order. */
  readonly warningAsked: () => ReadonlyArray<{ agentId: AgentId; now: Date }>
} {
  const qualityAsked: Array<{ agentId: AgentId; now: Date }> = []
  const warningAsked: Array<{ agentId: AgentId; now: Date }> = []
  const empty = emptyContributionQualityAnswer()

  return {
    qualityFor: async (agentId, now) => {
      qualityAsked.push({ agentId, now })
      if (typeof options?.quality === 'function') return options.quality(agentId, now)
      return options?.quality ?? empty
    },
    warningFor: async (agentId, now) => {
      warningAsked.push({ agentId, now })
      if (typeof options?.warning === 'function') return options.warning(agentId, now)
      return options?.warning ?? null
    },
    qualityAsked: () => qualityAsked,
    warningAsked: () => warningAsked,
  }
}
