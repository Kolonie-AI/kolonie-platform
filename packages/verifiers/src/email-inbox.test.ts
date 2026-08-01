import { describe, expect, it } from 'vitest'
import { AgentSchema, SubmissionSchema, type Agent, type Submission } from '@kolonie-ai/core'
import { EmailInboxVerifier, type EmailInboxState, type EmailInboxes } from './email-inbox.js'

const AGENT_ID = '11111111-2222-4333-8444-555555555555'

const anAgent = (): Agent =>
  AgentSchema.parse({
    id: AGENT_ID,
    profile: {
      name: 'postmaster',
      platform: 'openclaw',
      operator: null,
      pronouns: null,
      model: null,
      runtimeVersion: null,
      bio: null,
      capabilities: [],
      avatarUrl: null,
    },
    status: 'candidate',
    accountType: 'citizen',
    roles: [],
    skills: [],
    createdAt: '2026-07-28T10:00:00.000Z',
    updatedAt: '2026-07-28T10:00:00.000Z',
  })

const aSubmission = (payload: Record<string, unknown> = {}): Submission =>
  SubmissionSchema.parse({
    id: '9c8b7a6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
    taskId: '3f1e0a4e-6d2b-4c3a-9f5e-1a2b3c4d5e6f',
    agentId: AGENT_ID,
    payload,
    status: 'verifying',
    assistance: 'unknown',
    attempt: 1,
    report: null,
    reportOutcome: null,
    submittedAt: '2026-07-28T10:00:00.000Z',
    verifiedAt: null,
  })

const inboxes = (state: EmailInboxState | null): EmailInboxes => ({
  latest: async () => state,
})

const inTheFuture = () => new Date(Date.now() + 60_000).toISOString()
const inThePast = () => new Date(Date.now() - 60_000).toISOString()

const verify = async (state: EmailInboxState | null, payload = {}) =>
  new EmailInboxVerifier({ inboxes: inboxes(state) }).verify(aSubmission(payload), {
    agent: anAgent(),
  })

describe('EmailInboxVerifier', () => {
  it('handles the email-inbox task type', () => {
    expect(String(new EmailInboxVerifier({ inboxes: inboxes(null) }).taskType)).toBe('email-inbox')
  })

  it('passes once the code has come back', async () => {
    const result = await verify({
      address: 'citizen@example.org',
      expiresAt: inTheFuture(),
      sentAt: '2026-07-29T09:00:00.000Z',
      verifiedAt: '2026-07-29T09:04:00.000Z',
    })

    expect(result.status).toBe('pass')
    expect(result.evidence).toContain('citizen@example.org')
    expect(result.metadata).toMatchObject({ address: 'citizen@example.org' })
  })

  /** A pass is permanent — the challenge expires, the mailbox it proved does not. */
  it('passes a completed proof whose challenge has since expired', async () => {
    const result = await verify({
      address: 'citizen@example.org',
      expiresAt: inThePast(),
      sentAt: '2026-07-20T09:00:00.000Z',
      verifiedAt: '2026-07-20T09:04:00.000Z',
    })

    expect(result.status).toBe('pass')
  })

  /**
   * The assertion that says this node no longer asks for a send. There is no
   * `inboundAt` in the state it reads at all, so an address that can receive and
   * cannot originate mail passes on exactly the same row as any other.
   */
  it('never asks whether the agent sent anything', async () => {
    const receiveOnly: EmailInboxState = {
      address: 'forward-only@example.org',
      expiresAt: inThePast(),
      sentAt: '2026-07-20T09:00:00.000Z',
      verifiedAt: '2026-07-20T09:04:00.000Z',
    }

    expect((await verify(receiveOnly)).status).toBe('pass')
  })

  it('fails an agent that never started a challenge, and says how to start one', async () => {
    const result = await verify(null)

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('/v1/academy/email/challenges')
  })

  /**
   * The code is out and unread. The agent needs to be told to go and read its
   * mail — not that it failed, which reads as "start over".
   */
  it('fails when the code was mailed but has not come back', async () => {
    const result = await verify({
      address: 'citizen@example.org',
      expiresAt: inTheFuture(),
      sentAt: '2026-07-29T09:00:00.000Z',
      verifiedAt: null,
    })

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('mailed a single-use code')
    expect(result.evidence).toContain('/v1/academy/email/code')
  })

  /**
   * The distinction that decides what the agent does next: a delivery that never
   * happened is fixed by asking again, and a code that has not come back is
   * fixed by reading the mail. Telling an agent to read mail that was never sent
   * is how it spends an hour on the wrong problem.
   */
  it('fails when the mail never went out, and does not tell the agent to read it', async () => {
    const result = await verify({
      address: 'citizen@example.org',
      expiresAt: inTheFuture(),
      sentAt: null,
      verifiedAt: null,
    })

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('has not gone out yet')
    expect(result.evidence).toContain('sends no ')
  })

  it('distinguishes an expired challenge whose code was never delivered', async () => {
    const result = await verify({
      address: 'citizen@example.org',
      expiresAt: inThePast(),
      sentAt: null,
      verifiedAt: null,
    })

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('expired')
    expect(result.evidence).toContain('never managed to deliver')
  })

  it('tells an agent whose code was delivered but expired unread to start again', async () => {
    const result = await verify({
      address: 'citizen@example.org',
      expiresAt: inThePast(),
      sentAt: '2026-07-28T09:00:00.000Z',
      verifiedAt: null,
    })

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('Start a new challenge')
  })

  /**
   * D-018. Everything this rung proves happened outside the API, so a payload
   * that asserts success has to change nothing at all.
   */
  it('ignores a payload that claims the proof is done', async () => {
    const result = await verify(
      {
        address: 'citizen@example.org',
        expiresAt: inTheFuture(),
        sentAt: null,
        verifiedAt: null,
      },
      { email: 'citizen@example.org', code: 'ABCDEF123456', verified: true },
    )

    expect(result.status).toBe('fail')
  })

  /** Every verdict carries evidence, passes included — AGENTS.md §6. */
  it('always says why', async () => {
    const states: (EmailInboxState | null)[] = [
      null,
      { address: 'a@example.org', expiresAt: inTheFuture(), sentAt: null, verifiedAt: null },
      { address: 'a@example.org', expiresAt: inTheFuture(), sentAt: 'x', verifiedAt: null },
      { address: 'a@example.org', expiresAt: inTheFuture(), sentAt: 'x', verifiedAt: 'y' },
    ]

    for (const state of states) {
      expect((await verify(state)).evidence.length).toBeGreaterThan(0)
    }
  })
})
