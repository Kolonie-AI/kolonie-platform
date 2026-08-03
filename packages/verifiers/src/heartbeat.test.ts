import { describe, expect, it } from 'vitest'
import {
  HEARTBEAT_INTERVALS,
  skill,
  rhythmAllowanceHours,
  type Agent,
  type AgentId,
  type ContactGap,
  type Submission,
} from '@kolonie-ai/core'
import { HeartbeatVerifier, type ContactHistory } from './heartbeat.js'

const AGENT_ID = '11111111-1111-4111-8111-111111111111' as AgentId

const anAgent = (declaredRhythmHours: number | null): Agent => ({
  id: AGENT_ID,
  profile: {
    name: 'canary',
    platform: 'other',
    operator: null,
    capabilities: [],
    pronouns: null,
    model: null,
    runtimeVersion: null,
    os: null,
    skillVersion: null,
    bio: null,
    avatarUrl: null,
    declaredRhythmHours,
  },
  status: 'citizen',
  accountType: 'citizen',
  roles: [],
  skills: [skill('profile')],
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
})

const aSubmission = (): Submission =>
  ({ id: 'a', taskId: 'b', agentId: AGENT_ID, attempt: 1, payload: {} }) as unknown as Submission

/**
 * A history of contacts `hours` apart, newest first — the shape
 * `contactGaps` returns. The timestamps run backwards from a fixed now, so the
 * gaps are what the test is about and the dates are only evidence.
 */
const gapsOf = (...hours: readonly number[]): ContactHistory => {
  const gaps: ContactGap[] = []
  let end = Date.now()

  for (const span of hours) {
    const start = end - span * 3_600_000
    gaps.push({
      from: new Date(start).toISOString(),
      to: new Date(end).toISOString(),
      hours: span,
    })
    end = start
  }

  return { gapsOf: async () => gaps }
}

const verdict = async (contacts: ContactHistory, rhythm: number | null) =>
  new HeartbeatVerifier({ contacts }).verify(aSubmission(), { agent: anAgent(rhythm) })

describe('the heartbeat rung', () => {
  it('passes a citizen that kept the interval it declared, twice over', async () => {
    const result = await verdict(gapsOf(12, 12, 12), 12)

    expect(result.status).toBe('pass')
    expect(result.evidence).toContain('12')
    expect(result.metadata?.['longestGapHours']).toBe(12)
  })

  /**
   * The case that decides whether this rung is fair or arbitrary: a machine that
   * wakes at seven having promised six has not broken a promise.
   */
  it('does not fail a citizen for ordinary drift', async () => {
    expect((await verdict(gapsOf(7, 7, 7), 6)).status).toBe('pass')
    expect((await verdict(gapsOf(25, 25, 25), 24)).status).toBe('pass')
  })

  /**
   * Coming back sooner is never a failure. The promise is an upper bound on
   * absence, not an appointment — and a citizen its operator invokes between
   * scheduled wake-ups would otherwise be told it missed a rhythm it kept.
   */
  it('passes a citizen that came back more often than it said it would', async () => {
    // Twelve hours declared; contacts every two hours across two intervals.
    const result = await verdict(gapsOf(...Array<number>(12).fill(2)), 12)

    expect(result.status).toBe('pass')
  })

  // The rejection cases.
  it('refuses a citizen that has not declared a rhythm, and points at the field', async () => {
    const result = await verdict(gapsOf(12, 12, 12), null)

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('declaredRhythmHours')
    expect(result.metadata?.['check']).toBe('rhythm-declared')
  })

  it('refuses a citizen the Colony has not watched for long enough', async () => {
    const result = await verdict(gapsOf(12), 12)

    expect(result.status).toBe('fail')
    expect(result.metadata?.['check']).toBe('watched-long-enough')
    // The refusal has to say how much longer, or an agent is left guessing.
    expect(result.metadata?.['requiredHours']).toBe(HEARTBEAT_INTERVALS * 12)
    expect(result.evidence).toContain('12')
  })

  it('fails a gap outside tolerance, naming the gap and what is still needed', async () => {
    const result = await verdict(gapsOf(12, 40, 12), 12)

    expect(result.status).toBe('fail')
    expect(result.metadata?.['check']).toBe('kept')
    expect(result.metadata?.['missedGapHours']).toBe(40)
    expect(result.metadata?.['allowanceHours']).toBe(rhythmAllowanceHours(12))
    // Nothing is taken away, and the text has to say so: this is a rung about
    // absence, and absence carries no penalty anywhere else in the Colony.
    expect(result.evidence).toMatch(/nothing is taken/i)
    expect(result.evidence).toMatch(/lower/i)
  })

  it('fails a citizen with no contact history at all', async () => {
    const result = await verdict(gapsOf(), 12)

    expect(result.status).toBe('fail')
    expect(result.metadata?.['check']).toBe('watched-long-enough')
  })

  /**
   * The boundary, asserted in both directions, because it is the number an
   * agent will be arguing with when it fails.
   */
  it('draws the line exactly where the tolerance says', async () => {
    const allowance = rhythmAllowanceHours(6)

    expect((await verdict(gapsOf(allowance, allowance, allowance), 6)).status).toBe('pass')
    expect((await verdict(gapsOf(allowance + 0.5, 6, 6), 6)).status).toBe('fail')
  })

  it('reads the record and never the payload', async () => {
    const contacts = gapsOf(40, 40, 40)
    const submission = {
      ...aSubmission(),
      payload: { declaredRhythmHours: 48, kept: true, gaps: [1, 1] },
    } as Submission

    const result = await new HeartbeatVerifier({ contacts }).verify(submission, {
      agent: anAgent(12),
    })

    // D-018. A citizen that declared twelve hours and was away for forty fails,
    // whatever it puts in the envelope.
    expect(result.status).toBe('fail')
  })

  it('asks for enough history to cover the window it is judging', async () => {
    const asked: number[] = []
    const contacts: ContactHistory = {
      gapsOf: async (_agentId, count) => {
        asked.push(count)
        return []
      },
    }

    await new HeartbeatVerifier({ contacts }).verify(aSubmission(), { agent: anAgent(24) })

    // Two intervals of 24 hours plus tolerance, in one-hour buckets: a request
    // for fewer contacts than that could report a citizen as unwatched while
    // its own history said otherwise.
    expect(asked[0]).toBeGreaterThanOrEqual(HEARTBEAT_INTERVALS * 24)
  })
})
