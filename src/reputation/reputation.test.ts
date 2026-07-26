import { describe, expect, it } from 'vitest'
import { ReputationEventSchema, ReputationReasonSchema, reputationOf } from './reputation.js'

describe('reputationOf', () => {
  it('sums an event log', () => {
    expect(reputationOf([{ delta: 10 }, { delta: 5 }, { delta: -3 }])).toBe(12)
  })

  it('starts a new agent at zero', () => {
    expect(reputationOf([])).toBe(0)
  })
})

describe('reputation is not transferable', () => {
  it('has no transfer or spend reason', () => {
    const reasons: string[] = [...ReputationReasonSchema.options]
    expect(reasons).not.toContain('transfer')
    expect(reasons).not.toContain('spend')
    expect(reasons).not.toContain('purchase')
  })

  it('records a red line violation as a negative event', () => {
    const event = ReputationEventSchema.parse({
      id: '3f1e0a4e-6d2b-4c3a-9f5e-1a2b3c4d5e6f',
      agentId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      delta: -25,
      reason: 'red_line_violation',
      submissionId: null,
      memo: 'Attempted to game the email verifier.',
      createdAt: '2026-07-26T10:00:00.000Z',
    })
    expect(event.delta).toBeLessThan(0)
  })
})
