import { describe, expect, it } from 'vitest'
import {
  AgentSchema,
  SubmissionSchema,
  TaskTypeSchema,
  type SubmissionStatus,
  type VerificationContext,
} from '@kolonie-ai/core'
import { verifySubmission } from './runner.js'

const API_CALL = TaskTypeSchema.parse('api-call')

/**
 * The context the runner joins alongside the submission (D-018). These tests are
 * about `api-call`, which ignores it — but the parameter is not optional, and a
 * fixture that lies about its shape would let a verifier that *does* read it
 * pass a test it should fail.
 */
const context: VerificationContext = {
  agent: AgentSchema.parse({
    id: '11111111-2222-4333-8444-555555555555',
    profile: {
      name: 'canary',
      platform: 'openclaw',
      operator: null,
      capabilities: ['typescript'],
      wallet: null,
    },
    status: 'candidate',
    roles: [],
    level: 1,
    createdAt: '2026-07-27T10:00:00.000Z',
    updatedAt: '2026-07-27T10:00:00.000Z',
  }),
}

const submission = (status: SubmissionStatus, payload: Record<string, unknown> = {}) =>
  SubmissionSchema.parse({
    id: '9c8b7a6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
    taskId: '3f1e0a4e-6d2b-4c3a-9f5e-1a2b3c4d5e6f',
    agentId: '11111111-2222-4333-8444-555555555555',
    payload,
    status,
    attempt: 1,
    submittedAt: '2026-07-27T10:00:00.000Z',
    verifiedAt: null,
  })

describe('verifySubmission', () => {
  it('passes a valid submission and moves it to passed', async () => {
    const verdict = await verifySubmission(
      submission('verifying', { echo: 'hello' }),
      API_CALL,
      context,
    )
    expect(verdict.outcome).toBe('verified')
    if (verdict.outcome !== 'verified') return
    expect(verdict.submission.status).toBe('passed')
    expect(verdict.result.status).toBe('pass')
    expect(verdict.result.evidence).toBeTruthy()
  })

  it('moves a bad submission to failed', async () => {
    const verdict = await verifySubmission(submission('verifying'), API_CALL, context)
    expect(verdict.outcome).toBe('verified')
    if (verdict.outcome !== 'verified') return
    expect(verdict.submission.status).toBe('failed')
  })

  it('skips a submission that is not being verified', async () => {
    const verdict = await verifySubmission(
      submission('pending', { echo: 'hello' }),
      API_CALL,
      context,
    )
    expect(verdict.outcome).toBe('skipped')
  })

  it('never re-verifies a terminal submission', async () => {
    for (const status of ['passed', 'failed', 'timeout'] as const) {
      const verdict = await verifySubmission(
        submission(status, { echo: 'hello' }),
        API_CALL,
        context,
      )
      expect(verdict.outcome).toBe('skipped')
    }
  })

  it('skips rather than fails when no verifier is deployed yet', async () => {
    const verdict = await verifySubmission(
      submission('verifying', { echo: 'hello' }),
      TaskTypeSchema.parse('instagram-follow'),
      context,
    )
    expect(verdict.outcome).toBe('skipped')
    if (verdict.outcome !== 'skipped') return
    expect(verdict.reason).toContain('No verifier deployed')
  })

  it('leaves the original submission untouched', async () => {
    const original = submission('verifying', { echo: 'hello' })
    await verifySubmission(original, API_CALL, context)
    expect(original.status).toBe('verifying')
  })
})
