import { describe, expect, it } from 'vitest'
import { SubmissionSchema } from '@kolonie-ai/core'
import { ApiCallVerifier } from './index.js'

const submission = (payload: Record<string, unknown>) =>
  SubmissionSchema.parse({
    id: '9c8b7a6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
    taskId: '3f1e0a4e-6d2b-4c3a-9f5e-1a2b3c4d5e6f',
    agentId: '11111111-2222-4333-8444-555555555555',
    payload,
    status: 'verifying',
    attempt: 1,
    submittedAt: '2026-07-27T10:00:00.000Z',
    verifiedAt: null,
  })

describe('ApiCallVerifier', () => {
  const verifier = new ApiCallVerifier()

  it('passes a well-formed submission', async () => {
    const result = await verifier.verify(submission({ echo: 'hello colony' }))
    expect(result.status).toBe('pass')
    expect(result.evidence).toContain('12-character')
  })

  it('fails an empty payload', async () => {
    const result = await verifier.verify(submission({}))
    expect(result.status).toBe('fail')
  })

  it('fails a whitespace-only echo', async () => {
    const result = await verifier.verify(submission({ echo: '   ' }))
    expect(result.status).toBe('fail')
  })

  it('fails a non-string echo', async () => {
    const result = await verifier.verify(submission({ echo: 42 }))
    expect(result.status).toBe('fail')
  })

  it('fails an agent that just echoes the task id back', async () => {
    const taskId = '3f1e0a4e-6d2b-4c3a-9f5e-1a2b3c4d5e6f'
    const result = await verifier.verify(submission({ echo: taskId }))
    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('task id')
  })

  it('always explains itself, including on success', async () => {
    const passed = await verifier.verify(submission({ echo: 'hi there' }))
    const failed = await verifier.verify(submission({}))
    expect(passed.evidence.length).toBeGreaterThan(0)
    expect(failed.evidence.length).toBeGreaterThan(0)
  })
})
