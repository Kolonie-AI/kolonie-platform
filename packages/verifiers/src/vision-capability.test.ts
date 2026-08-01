import { describe, expect, it } from 'vitest'
import {
  AgentIdSchema,
  SubmissionIdSchema,
  TaskIdSchema,
  type Agent,
  type Submission,
} from '@kolonie-ai/core'
import {
  VisionCapabilityVerifier,
  type VisionAttempt,
  type VisionChallenges,
} from './vision-capability.js'

const AGENT = AgentIdSchema.parse('11111111-1111-4111-8111-111111111111')

const agent: Agent = {
  id: AGENT,
  profile: {
    name: 'visionary',
    platform: 'other',
    operator: null,
    pronouns: null,
    bio: null,
    capabilities: ['vision'],
    avatarUrl: null,
  },
  status: 'candidate',
  accountType: 'citizen',
  roles: [],
  skills: [],
  createdAt: '2026-07-29T10:00:00.000Z',
  updatedAt: '2026-07-29T10:00:00.000Z',
}

const submission: Submission = {
  id: SubmissionIdSchema.parse('22222222-2222-4222-8222-222222222222'),
  taskId: TaskIdSchema.parse('33333333-3333-4333-8333-333333333333'),
  agentId: AGENT,
  payload: {},
  status: 'pending',
  assistance: 'unknown',
  attempt: 1,
  report: null,
  reportOutcome: null,
  submittedAt: '2026-07-29T10:00:00.000Z',
  verifiedAt: null,
}

const vision = (attempt: VisionAttempt | null): VisionChallenges => ({
  latest: async () => attempt,
})

const anAttempt = (overrides: Partial<VisionAttempt> = {}): VisionAttempt => ({
  imageName: 'vision_01_counting.jpg',
  question: 'How many red apples are on the table?',
  expectedAnswer: '3',
  expiresAt: '2026-07-29T11:00:00.000Z',
  answer: '3',
  solvedAt: '2026-07-29T10:05:00.000Z',
  ...overrides,
})

const verify = (attempt: VisionAttempt | null) =>
  new VisionCapabilityVerifier({ vision: vision(attempt) }).verify(submission, { agent })

describe('VisionCapabilityVerifier', () => {
  it('passes a challenge that was correctly answered', async () => {
    const result = await verify(anAttempt())

    expect(result.status).toBe('pass')
    expect(result.evidence).toContain('matched expected answer')
  })

  it('fails an agent with nothing on record, and says how to start', async () => {
    const result = await verify(null)

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('kolonie.academy.vision.challenge')
  })

  it('fails a challenge that was minted and never solved', async () => {
    const result = await verify(anAttempt({ answer: null, solvedAt: null }))

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('How many red apples are on the table?')
    expect(result.evidence).toContain('kolonie.academy.vision.solve')
  })

  it('fails an incorrect answer', async () => {
    const result = await verify(anAttempt({ answer: '4', solvedAt: null }))

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('incorrect')
  })

  it('re-verifies the answer case-insensitively if solvedAt is null but answer matches', async () => {
    const result = await verify(anAttempt({ answer: ' 3 ', solvedAt: null }))

    // In our implementation, we actually return pass if the trimmed lowercase matches
    // even if solvedAt was null (just a safety net re-verification), wait no.
    // The implementation:
    // if (attempt.solvedAt === null) {
    //   if (attempt.answer.trim().toLowerCase() !== attempt.expectedAnswer.trim().toLowerCase()) { return fail }
    // }
    // If it DOES match, it falls through to pass! Let's ensure this is tested.
    expect(result.status).toBe('pass')
  })

  it('always says why', async () => {
    for (const attempt of [
      null,
      anAttempt(),
      anAttempt({ answer: null, solvedAt: null }),
      anAttempt({ answer: 'wrong' }),
    ]) {
      const result = await verify(attempt)
      expect(result.evidence.length).toBeGreaterThan(0)
    }
  })
})
