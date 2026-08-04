import {
  memoryCodesMatch,
  mintMemoryCode,
  now as currentTime,
  type AgentId,
} from '@kolonie-ai/core'
import type { MemoryCodeContext, MemoryMintOutcome, MemoryRedemptionOutcome } from '@kolonie-ai/db'
import type { MemoryCodes, MemoryDependencies } from '../memory.js'
import { noObstruction } from './obstruction.js'

export interface FakeMemoryCodes extends MemoryCodes {
  /**
   * Move the outstanding code's issue date into the past.
   *
   * The only way to test a rule about hours without waiting for them, and the same
   * device `routes/persistence.test.ts` uses for the browser rung's gap.
   */
  readonly issuedHoursAgo: (agentId: AgentId, hours: number) => void
  /** What a test needs in order to hand back the right value — never a route's business. */
  readonly outstandingFor: (agentId: AgentId) => string | undefined
  /** What the citizen declared about how often it comes back. */
  readonly declares: (agentId: AgentId, rhythmHours: number | null) => void
}

/**
 * An in-memory code store.
 *
 * Reproduces what the API depends on and nothing more: one outstanding code per
 * agent, the issue date the gap is measured from, and rotation on redemption.
 * Whether the real store's partial unique index refuses a second outstanding row
 * is asserted in `packages/db` against a real Postgres, because that property
 * lives in an index this file cannot model.
 */
export function fakeMemoryCodes(): FakeMemoryCodes {
  interface Row {
    agentId: AgentId
    code: string
    issuedAt: string
    redeemedAt: string | null
    supersededAt: string | null
    wrongAttempts: number
  }

  const rows: Row[] = []
  const rhythms = new Map<AgentId, number | null>()

  const outstanding = (agentId: AgentId): Row | undefined =>
    rows.find(
      (row) => row.agentId === agentId && row.redeemedAt === null && row.supersededAt === null,
    )

  const issue = (agentId: AgentId): Row => {
    const row: Row = {
      agentId,
      code: mintMemoryCode(),
      issuedAt: currentTime(),
      redeemedAt: null,
      supersededAt: null,
      wrongAttempts: 0,
    }
    rows.unshift(row)
    return row
  }

  return {
    async mint(agentId, replace) {
      const open = outstanding(agentId)

      if (open !== undefined && !replace) {
        return { outcome: 'outstanding', issuedAt: open.issuedAt } satisfies MemoryMintOutcome
      }

      if (open !== undefined) open.supersededAt = currentTime()

      const row = issue(agentId)

      return {
        outcome: 'minted',
        minted: {
          code: row.code,
          issuedAt: row.issuedAt,
          supersededIssuedAt: open?.issuedAt ?? null,
        },
      } satisfies MemoryMintOutcome
    },

    async contextOf(agentId) {
      const open = outstanding(agentId)
      if (open === undefined) return null

      return {
        issuedAt: open.issuedAt,
        declaredRhythmHours: rhythms.get(agentId) ?? null,
        sessionId: null,
      } satisfies MemoryCodeContext
    },

    async redeem(agentId, code) {
      const open = outstanding(agentId)

      if (open === undefined) {
        return { outcome: 'no_outstanding_code' } satisfies MemoryRedemptionOutcome
      }

      if (!memoryCodesMatch(open.code, code)) {
        open.wrongAttempts += 1
        return {
          outcome: 'wrong',
          issuedAt: open.issuedAt,
          wrongAttempts: open.wrongAttempts,
        } satisfies MemoryRedemptionOutcome
      }

      open.redeemedAt = currentTime()
      const next = issue(agentId)

      return {
        outcome: 'redeemed',
        redeemedAt: open.redeemedAt,
        carriedForHours:
          Math.round(((Date.parse(open.redeemedAt) - Date.parse(open.issuedAt)) / 3_600_000) * 10) /
          10,
        next: next.code,
      } satisfies MemoryRedemptionOutcome
    },

    issuedHoursAgo(agentId, hours) {
      const open = outstanding(agentId)
      if (open !== undefined) {
        open.issuedAt = new Date(Date.now() - hours * 3_600_000).toISOString()
      }
    },

    outstandingFor: (agentId) => outstanding(agentId)?.code,

    declares(agentId, rhythmHours) {
      rhythms.set(agentId, rhythmHours)
    },
  }
}

export function fakeMemory(codes: MemoryCodes = fakeMemoryCodes()): MemoryDependencies {
  return { codes, obstruction: noObstruction }
}
