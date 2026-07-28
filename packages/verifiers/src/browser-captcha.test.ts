import { describe, expect, it } from 'vitest'
import {
  AgentSchema,
  SubmissionSchema,
  type Agent,
  type AgentId,
  type Submission,
  type Timestamp,
} from '@kolonie-ai/core'
import { BrowserCaptchaVerifier } from './browser-captcha.js'

const anAgent = (): Agent =>
  AgentSchema.parse({
    id: '11111111-2222-4333-8444-555555555555',
    profile: {
      name: 'canary',
      platform: 'openclaw',
      operator: null,
      capabilities: ['research'],
      wallet: null,
    },
    status: 'candidate',
    roles: [],
    level: 1,
    createdAt: '2026-07-28T10:00:00.000Z',
    updatedAt: '2026-07-28T10:00:00.000Z',
  })

const aSubmission = ({ payload = {} }: { payload?: Record<string, unknown> } = {}): Submission =>
  SubmissionSchema.parse({
    id: '9c8b7a6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
    taskId: '3f1e0a4e-6d2b-4c3a-9f5e-1a2b3c4d5e6f',
    agentId: '11111111-2222-4333-8444-555555555555',
    payload,
    status: 'verifying',
    attempt: 1,
    submittedAt: '2026-07-28T10:00:00.000Z',
    verifiedAt: null,
  })

const gates = (clearedAt: Timestamp | null) => ({
  clearedAt: async (_agentId: AgentId) => clearedAt,
})

describe('BrowserCaptchaVerifier', () => {
  it('passes an agent the Colony recorded as having solved a challenge', async () => {
    const solvedAt = '2026-07-28T12:00:00.000Z' as Timestamp
    const verifier = new BrowserCaptchaVerifier({ gates: gates(solvedAt) })

    const result = await verifier.verify(aSubmission(), { agent: anAgent() })

    expect(result.status).toBe('pass')
    expect(result.evidence).toContain(solvedAt)
    expect(result.metadata).toMatchObject({ clearedAt: solvedAt })
  })

  it('fails an agent with nothing on record, and says what to do', async () => {
    const verifier = new BrowserCaptchaVerifier({ gates: gates(null) })

    const result = await verifier.verify(aSubmission(), { agent: anAgent() })

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('/v1/academy/challenges')
  })

  /**
   * The property this rung exists for. The work happens in a browser, outside
   * the API, so a verifier that believed the payload would test nothing at all —
   * and the three rungs above are ordered on the assumption that this one is
   * real. Same rule as D-018 for Level 0.
   */
  it('ignores the payload entirely', async () => {
    const verifier = new BrowserCaptchaVerifier({ gates: gates(null) })

    const claimed = await verifier.verify(
      aSubmission({ payload: { solved: true, verifiedAt: '2026-07-28T12:00:00.000Z' } }),
      { agent: anAgent() },
    )

    expect(claimed.status).toBe('fail')
  })

  it('treats a pass as permanent, though the challenge that proved it expired', async () => {
    const longAgo = '2026-01-01T00:00:00.000Z' as Timestamp
    const verifier = new BrowserCaptchaVerifier({ gates: gates(longAgo) })

    expect((await verifier.verify(aSubmission(), { agent: anAgent() })).status).toBe('pass')
  })
})
