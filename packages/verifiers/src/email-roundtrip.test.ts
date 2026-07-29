import { describe, expect, it } from 'vitest'
import { AgentSchema, SubmissionSchema, type Agent, type Submission } from '@kolonie-ai/core'
import {
  EmailRoundtripVerifier,
  type EmailRoundtripState,
  type EmailRoundtrips,
} from './email-roundtrip.js'

const AGENT_ID = '11111111-2222-4333-8444-555555555555'

const anAgent = (): Agent =>
  AgentSchema.parse({
    id: AGENT_ID,
    profile: {
      name: 'postmaster',
      platform: 'openclaw',
      operator: null,
      capabilities: [],
      wallet: null,
    },
    status: 'candidate',
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
    submittedAt: '2026-07-28T10:00:00.000Z',
    verifiedAt: null,
  })

const roundtrips = (state: EmailRoundtripState | null): EmailRoundtrips => ({
  latest: async () => state,
})

const inTheFuture = () => new Date(Date.now() + 60_000).toISOString()
const inThePast = () => new Date(Date.now() - 60_000).toISOString()

const verify = async (state: EmailRoundtripState | null, payload = {}) =>
  new EmailRoundtripVerifier({ roundtrips: roundtrips(state) }).verify(aSubmission(payload), {
    agent: anAgent(),
  })

describe('EmailRoundtripVerifier', () => {
  it('handles the email-roundtrip task type', () => {
    expect(String(new EmailRoundtripVerifier({ roundtrips: roundtrips(null) }).taskType)).toBe(
      'email-roundtrip',
    )
  })

  it('passes once both halves are on record', async () => {
    const result = await verify({
      address: 'citizen@example.org',
      expiresAt: inTheFuture(),
      inboundAt: '2026-07-29T09:00:00.000Z',
      verifiedAt: '2026-07-29T09:04:00.000Z',
    })

    expect(result.status).toBe('pass')
    expect(result.evidence).toContain('citizen@example.org')
    expect(result.metadata).toMatchObject({ address: 'citizen@example.org' })
  })

  /** A pass is permanent — the challenge expires, the mailbox it proved does not. */
  it('passes a completed round trip whose challenge has since expired', async () => {
    const result = await verify({
      address: 'citizen@example.org',
      expiresAt: inThePast(),
      inboundAt: '2026-07-20T09:00:00.000Z',
      verifiedAt: '2026-07-20T09:04:00.000Z',
    })

    expect(result.status).toBe('pass')
  })

  it('fails an agent that never started a challenge, and says how to start one', async () => {
    const result = await verify(null)

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('/v1/academy/email/challenges')
  })

  /**
   * The send half done and the receive half not. The agent needs to be told to
   * go and read its mail — not that it failed, which reads as "start over".
   */
  it('fails when the mail arrived but the code has not come back', async () => {
    const result = await verify({
      address: 'citizen@example.org',
      expiresAt: inTheFuture(),
      inboundAt: '2026-07-29T09:00:00.000Z',
      verifiedAt: null,
    })

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('sending half is done')
    expect(result.evidence).toContain('/v1/academy/email/code')
  })

  it('fails when nothing has arrived, and does not claim the code is wrong', async () => {
    const result = await verify({
      address: 'citizen@example.org',
      expiresAt: inTheFuture(),
      inboundAt: null,
      verifiedAt: null,
    })

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('no mail from that address has arrived')
    expect(result.evidence).not.toContain('code')
  })

  it('distinguishes an expired challenge that never received mail', async () => {
    const result = await verify({
      address: 'citizen@example.org',
      expiresAt: inThePast(),
      inboundAt: null,
      verifiedAt: null,
    })

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('expired')
    expect(result.evidence).toContain('Start a new one')
  })

  it('tells an agent whose send half survived an expiry that only the reading is missing', async () => {
    const result = await verify({
      address: 'citizen@example.org',
      expiresAt: inThePast(),
      inboundAt: '2026-07-28T09:00:00.000Z',
      verifiedAt: null,
    })

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('sending half is not in doubt')
  })

  /**
   * D-018. Everything this rung proves happened outside the API, so a payload
   * that asserts success has to change nothing at all.
   */
  it('ignores a payload that claims the round trip is done', async () => {
    const result = await verify(
      {
        address: 'citizen@example.org',
        expiresAt: inTheFuture(),
        inboundAt: null,
        verifiedAt: null,
      },
      { email: 'citizen@example.org', code: 'ABCDEF123456', verified: true },
    )

    expect(result.status).toBe('fail')
  })

  /** Every verdict carries evidence, passes included — AGENTS.md §6. */
  it('always says why', async () => {
    const states: (EmailRoundtripState | null)[] = [
      null,
      { address: 'a@example.org', expiresAt: inTheFuture(), inboundAt: null, verifiedAt: null },
      { address: 'a@example.org', expiresAt: inTheFuture(), inboundAt: 'x', verifiedAt: null },
      { address: 'a@example.org', expiresAt: inTheFuture(), inboundAt: 'x', verifiedAt: 'y' },
    ]

    for (const state of states) {
      expect((await verify(state)).evidence.length).toBeGreaterThan(0)
    }
  })
})
