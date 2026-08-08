import type { AgentId } from '@kolonie-ai/core'
import type { CitizenEarning } from '@kolonie-ai/db'
import type { EarningsDesk } from '../payouts.js'

/**
 * What a citizen has been paid, in memory (`#535`).
 *
 * Empty by default, because that is what every citizen's answer is until a
 * report of its own has been accepted — and it is the answer the surface has to
 * render without pretending nothing exists to know about being paid.
 */
export interface FakeEarnings extends EarningsDesk {
  /** Record a payment against a citizen, as an accepted report would. */
  readonly record: (agentId: AgentId, earning: Partial<CitizenEarning>) => void
}

export function fakeEarnings(): FakeEarnings {
  const byAgent = new Map<string, CitizenEarning[]>()

  return {
    forCitizen: async (agentId, limit = 50) => (byAgent.get(agentId) ?? []).slice(0, limit),
    record: (agentId, earning) => {
      const rows = byAgent.get(agentId) ?? []
      rows.unshift({
        taskId: 'a0000000-0000-4000-8000-000000000001' as CitizenEarning['taskId'],
        title: 'A quest somebody paid for',
        // A report unless a test says otherwise: it is what most rows are, and
        // a steward's review is the case worth writing down explicitly (`#553`).
        kind: 'report',
        lamports: 1_500_000,
        owedSince: '2026-08-07T15:52:00.000Z',
        paidAt: null,
        signature: null,
        address: null,
        lastRefusal: null,
        attempts: 0,
        forfeited: false,
        ...earning,
      })
      byAgent.set(agentId, rows)
    },
  }
}
