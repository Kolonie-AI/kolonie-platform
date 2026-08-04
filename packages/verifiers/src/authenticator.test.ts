import { describe, expect, it } from 'vitest'
import {
  AgentIdSchema,
  SubmissionIdSchema,
  TaskIdSchema,
  type Agent,
  type Submission,
  type Timestamp,
} from '@kolonie-ai/core'
import { AuthenticatorVerifier, type TotpSecrets, type TotpStanding } from './authenticator.js'

const AGENT = AgentIdSchema.parse('11111111-1111-4111-8111-111111111111')

const agent: Agent = {
  id: AGENT,
  profile: {
    name: 'careful',
    platform: 'other',
    operator: null,
    pronouns: null,
    model: null,
    runtimeVersion: null,
    os: null,
    skillVersion: null,
    bio: null,
    capabilities: ['x'],
    avatarUrl: null,
    declaredRhythmHours: null,
  },
  status: 'citizen',
  accountType: 'citizen',
  roles: [],
  skills: [],
  createdAt: '2026-08-05T10:00:00.000Z',
  updatedAt: '2026-08-05T10:00:00.000Z',
}

const submission: Submission = {
  id: SubmissionIdSchema.parse('22222222-2222-4222-8222-222222222222'),
  taskId: TaskIdSchema.parse('33333333-3333-4333-8333-333333333333'),
  agentId: AGENT,
  payload: {} as Submission['payload'],
  status: 'pending',
  assistance: 'unknown',
  attempt: 1,
  report: null,
  reportOutcome: null,
  submittedAt: '2026-08-05T10:00:00.000Z',
  verifiedAt: null,
  evidence: null,
}

const standing = (overrides: Partial<TotpStanding> = {}): TotpSecrets => ({
  standing: async () => ({
    issuedAt: null,
    provedAt: null,
    heldAt: null,
    wrongAttempts: 0,
    requiredHours: null,
    ...overrides,
  }),
})

const at = (value: string) => value as Timestamp

const verify = (secrets: TotpSecrets) =>
  new AuthenticatorVerifier({ secrets }).verify(submission, { agent })

describe('AuthenticatorVerifier', () => {
  it('answers to the rung it was built for', () => {
    expect(new AuthenticatorVerifier({ secrets: standing() }).taskType).toBe('authenticator')
  })

  it('tells a citizen with no secret how to get one', async () => {
    const result = await verify(standing())

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('kolonie.academy.authenticator.secret')
  })

  it('tells a citizen that has not computed a code where the arithmetic is written down', async () => {
    const result = await verify(standing({ issuedAt: at('2026-08-05T10:00:00.000Z') }))

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('RFC 6238')
    expect(result.metadata).toMatchObject({ stage: 'unproved' })
  })

  /** Stage one alone is arithmetic, and arithmetic is trivial. */
  it('does not pass a citizen that only proved it can compute', async () => {
    const result = await verify(
      standing({
        issuedAt: at('2026-08-05T10:00:00.000Z'),
        provedAt: at('2026-08-05T10:05:00.000Z'),
        requiredHours: 6,
      }),
    )

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('6 hours')
    expect(result.metadata).toMatchObject({ stage: 'proved' })
  })

  it('passes a citizen that returned a code from a later session', async () => {
    const result = await verify(
      standing({
        issuedAt: at('2026-08-05T10:00:00.000Z'),
        provedAt: at('2026-08-05T10:05:00.000Z'),
        heldAt: at('2026-08-05T20:00:00.000Z'),
        requiredHours: 6,
      }),
    )

    expect(result.status).toBe('pass')
    expect(result.metadata).toMatchObject({ stage: 'held' })
  })

  /**
   * The one thing a citizen must not learn here is that the Colony keeps second
   * factors. The pass says the opposite, at the moment it is being read.
   */
  it('says on the pass that the secret was a test artefact', async () => {
    const result = await verify(
      standing({
        issuedAt: at('2026-08-05T10:00:00.000Z'),
        provedAt: at('2026-08-05T10:05:00.000Z'),
        heldAt: at('2026-08-05T20:00:00.000Z'),
      }),
    )

    expect(result.evidence).toContain('test artefact')
    expect(result.evidence).toContain('your real second')
  })

  it('never leaves a submission pending, because it reads through nothing', async () => {
    for (const state of [
      standing(),
      standing({ issuedAt: at('2026-08-05T10:00:00.000Z') }),
      standing({
        issuedAt: at('2026-08-05T10:00:00.000Z'),
        provedAt: at('2026-08-05T10:05:00.000Z'),
      }),
    ]) {
      expect((await verify(state)).status).not.toBe('pending')
    }
  })
})
