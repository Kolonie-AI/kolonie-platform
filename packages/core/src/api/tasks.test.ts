import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  SubmitTaskMcpReceiptSchema,
  SubmitTaskRequestSchema,
  SubmitTaskResponseSchema,
  VerdictPollSchema,
} from './tasks.js'

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
    report: null,
    reportOutcome: null,
    submittedAt: new Date().toISOString(),
    verifiedAt: null,
    evidence: null,
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

  it('still requires the payload — the REST contract is not the MCP receipt', () => {
    const { payload: _payload, ...withoutPayload } = aSubmission()
    expect(
      SubmitTaskResponseSchema.safeParse({
        submission: withoutPayload,
        poll: { endpoint: '/v1/agents/me/submissions', afterSeconds: 30 },
      }).success,
    ).toBe(false)
  })
})

describe('SubmitTaskMcpReceiptSchema', () => {
  const aSubmission = () => ({
    id: randomUUID(),
    taskId: aTaskId(),
    agentId: randomUUID(),
    payload: { image: 'x'.repeat(100) },
    status: 'pending' as const,
    assistance: 'none' as const,
    attempt: 2,
    report: 'The single-box report the caller already holds.',
    reportOutcome: null,
    submittedAt: new Date().toISOString(),
    verifiedAt: null,
    evidence: null,
  })

  const aResponse = () => ({
    submission: aSubmission(),
    poll: { endpoint: '/v1/agents/me/submissions', afterSeconds: 30 },
    reportFiled: 'filed' as const,
    assistanceUndeclared: { fullReputation: 8, reducedReputation: 4, percent: 50 },
  })

  it('keeps the follow-up contract and strips the evidence the caller already holds', () => {
    const response = aResponse()
    const parsed = SubmitTaskMcpReceiptSchema.parse(response)

    expect(parsed.submission).toEqual({
      id: response.submission.id,
      taskId: response.submission.taskId,
      status: 'pending',
      assistance: 'none',
      attempt: 2,
    })
    expect(parsed.poll).toEqual({ endpoint: '/v1/agents/me/submissions', afterSeconds: 30 })
    expect(parsed.reportFiled).toBe('filed')
    expect(parsed.assistanceUndeclared).toEqual({
      fullReputation: 8,
      reducedReputation: 4,
      percent: 50,
    })
    expect(parsed.submission).not.toHaveProperty('payload')
    expect(parsed.submission).not.toHaveProperty('report')
    expect(parsed.submission).not.toHaveProperty('evidence')
  })

  it('rejects a receipt that is already a verdict', () => {
    const response = aResponse()
    expect(
      SubmitTaskMcpReceiptSchema.safeParse({
        ...response,
        submission: { ...response.submission, status: 'passed' },
      }).success,
    ).toBe(false)
  })

  it('rejects a receipt with no poll', () => {
    const { poll: _poll, ...withoutPoll } = aResponse()
    expect(SubmitTaskMcpReceiptSchema.safeParse(withoutPoll).success).toBe(false)
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
