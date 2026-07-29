import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { SubmitTaskRequestSchema, SubmitTaskResponseSchema, VerdictPollSchema } from './tasks.js'

const aTaskId = () => randomUUID()

describe('SubmitTaskRequestSchema', () => {
  it('accepts a task id and a task-type specific payload', () => {
    const parsed = SubmitTaskRequestSchema.parse({
      taskId: aTaskId(),
      payload: { issueUrl: 'https://example.invalid/issues/1', attempts: 2 },
    })

    expect(parsed.payload).toEqual({ issueUrl: 'https://example.invalid/issues/1', attempts: 2 })
  })

  it('accepts an empty payload — a task may be about the act, not the artefact', () => {
    expect(SubmitTaskRequestSchema.safeParse({ taskId: aTaskId(), payload: {} }).success).toBe(true)
  })

  it('rejects a payload that is not an object', () => {
    // The verifier for the task type owns the *contents* of the payload; core
    // owns only that it is a keyed object. An array or a bare string would reach
    // a verifier that has no way to look a field up, and fail far from here.
    for (const payload of ['done', 42, ['done'], null]) {
      expect(SubmitTaskRequestSchema.safeParse({ taskId: aTaskId(), payload }).success).toBe(false)
    }
  })

  it('rejects a task id that is not a uuid', () => {
    expect(SubmitTaskRequestSchema.safeParse({ taskId: 'level-1', payload: {} }).success).toBe(
      false,
    )
  })

  it('has no field an agent could use to submit as someone else', () => {
    const parsed = SubmitTaskRequestSchema.parse({
      taskId: aTaskId(),
      payload: {},
      agentId: randomUUID(),
    })

    expect(parsed).not.toHaveProperty('agentId')
  })
})

describe('SubmitTaskResponseSchema', () => {
  const aSubmission = () => ({
    id: randomUUID(),
    taskId: aTaskId(),
    agentId: randomUUID(),
    payload: {},
    status: 'pending' as const,
    assistance: 'unknown' as const,
    attempt: 1,
    submittedAt: new Date().toISOString(),
    verifiedAt: null,
  })

  it('carries the accepted submission and where its verdict will appear', () => {
    const parsed = SubmitTaskResponseSchema.parse({
      submission: aSubmission(),
      poll: { endpoint: '/v1/agents/me', afterSeconds: 30 },
    })

    expect(parsed.submission.status).toBe('pending')
    expect(parsed.poll.endpoint).toBe('/v1/agents/me')
  })

  it('requires the polling instruction — an agent must never have to invent one', () => {
    expect(SubmitTaskResponseSchema.safeParse({ submission: aSubmission() }).success).toBe(false)
  })
})

describe('VerdictPollSchema', () => {
  it('rejects a wait that is not a whole number of seconds', () => {
    expect(
      VerdictPollSchema.safeParse({ endpoint: '/v1/agents/me', afterSeconds: 1.5 }).success,
    ).toBe(false)
  })

  it('rejects an immediate poll — a verdict is never ready in the same breath', () => {
    expect(
      VerdictPollSchema.safeParse({ endpoint: '/v1/agents/me', afterSeconds: 0 }).success,
    ).toBe(false)
  })
})
