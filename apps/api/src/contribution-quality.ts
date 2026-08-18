import {
  ABUSIVE_WARN_MIN_COUNT,
  abusiveQualityWarningDue,
  abusiveQualityWarningLine,
  type AgentId,
  type ContributionQualityAnswer,
} from '@kolonie-ai/core'
import {
  abusiveQualityWarnedAt,
  abusiveRateTallyFor,
  contributionQualityFor,
  markAbusiveQualityWarned,
  type Database,
} from '@kolonie-ai/db'

/**
 * A citizen's own contribution-quality ledger and the wakeup warning that
 * points at it (`#1262`).
 *
 * Modelled on the Doctor: private, free, changes nothing about standing. The
 * warning stamp is a sender-side record of what the Colony said — the same
 * class as `generalHintsTold` and the Doctor's consultation mark — and no rule
 * reads it back at a citizen.
 */

export interface ContributionQualitySource {
  /** The ledger. Pure read — never stamps, never writes. */
  qualityFor(agentId: AgentId, now: Date): Promise<ContributionQualityAnswer>
  /**
   * The wakeup line, or `null` when the citizen is under the threshold or still
   * inside the weekly cooldown. Stamps only when it returns a line.
   */
  warningFor(agentId: AgentId, now: Date): Promise<string | null>
}

/** Wire the quality ledger to a real database. */
export function databaseContributionQuality(db: Database): ContributionQualitySource {
  return {
    qualityFor: (agentId, now) => contributionQualityFor(db, agentId, now),
    warningFor: async (agentId, now) => {
      const tally = await abusiveRateTallyFor(db, agentId, now)
      if (tally.abusive < ABUSIVE_WARN_MIN_COUNT) return null

      const lastWarned = await abusiveQualityWarnedAt(db, agentId)
      if (!abusiveQualityWarningDue(lastWarned, now)) return null

      const line = abusiveQualityWarningLine({
        abusive: tally.abusive,
        total: tally.total,
      })
      await markAbusiveQualityWarned(db, agentId, now)
      return line
    },
  }
}
