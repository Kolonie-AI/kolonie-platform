import { describe, expect, it } from 'vitest'
import {
  AgentIdSchema,
  SubmissionIdSchema,
  TaskIdSchema,
  drawVettingChallenge,
  vettingManifestFor,
  type Agent,
  type Submission,
} from '@kolonie-ai/core'
import { VettingVerifier, type VettingChallenges, type VettingChallengeState } from './vetting.js'

const AGENT = AgentIdSchema.parse('11111111-1111-4111-8111-111111111111')
const TOKEN = 'a1b2c3d4'

/**
 * A real draw rather than a hand-written state, so this test cannot pass while
 * the manifest and the anchors describe different attempts.
 */
const drawn = drawVettingChallenge(TOKEN, () => 0)

const CHALLENGE: VettingChallengeState = {
  sample: drawn.sample,
  token: drawn.token,
  planted: drawn.planted,
  manifest: vettingManifestFor(drawn),
  expiresAt: '2026-08-05T13:00:00.000Z',
}

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
    declaredRhythmMinutes: null,
    vocation: null,
    disposition: null,
    goal: null,
    availability: null,
    profession: null,
  },
  status: 'citizen',
  accountType: 'citizen',
  roles: [],
  skills: [],
  createdAt: '2026-08-05T10:00:00.000Z',
  updatedAt: '2026-08-05T10:00:00.000Z',
}

const submissionWith = (payload: unknown): Submission => ({
  id: SubmissionIdSchema.parse('22222222-2222-4222-8222-222222222222'),
  taskId: TaskIdSchema.parse('33333333-3333-4333-8333-333333333333'),
  agentId: AGENT,
  payload: payload as Submission['payload'],
  status: 'pending',
  assistance: 'unknown',
  attempt: 1,
  report: null,
  reportOutcome: null,
  submittedAt: '2026-08-05T10:00:00.000Z',
  verifiedAt: null,
  evidence: null,
})

const challenges = (state: VettingChallengeState | null): VettingChallenges => ({
  latest: async () => state,
})

function verify(payload: unknown, challenge: VettingChallengeState | null = CHALLENGE) {
  return new VettingVerifier({ challenges: challenges(challenge) }).verify(
    submissionWith(payload),
    {
      agent,
    },
  )
}

/** A report that names everything planted and quotes each one. */
const goodReport = {
  findings: CHALLENGE.planted.map((plant) => ({
    kind: plant.kind,
    evidence: plant.anchor,
  })),
}

describe('VettingVerifier', () => {
  it('answers to the rung it was built for', () => {
    expect(new VettingVerifier({ challenges: challenges(null) }).taskType).toBe('vetting')
  })

  it('passes a report that names both planted properties and quotes each one', async () => {
    const result = await verify(goodReport)

    expect(result.status).toBe('pass')
    expect(result.evidence).toContain(CHALLENGE.sample)
    expect(result.metadata).toMatchObject({ found: true, planted: CHALLENGE.planted.length })
  })

  it('fails a report that missed one, and says which kind', async () => {
    const missed = CHALLENGE.planted[0]!

    const result = await verify({ findings: goodReport.findings.slice(1) })

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain(missed.kind)
    expect(result.metadata).toMatchObject({ found: false })
  })

  it('fails a report that names a kind this manifest does not contain', async () => {
    const absent = (['credential-exfiltration', 'remote-code', 'obfuscated-payload'] as const).find(
      (kind) => !CHALLENGE.planted.some((plant) => plant.kind === kind),
    )!

    const result = await verify({
      findings: [...goodReport.findings, { kind: absent, evidence: 'somewhere in there' }],
    })

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('names a ' + absent)
    // Found something, and also found something that is not there.
    expect(result.metadata).toMatchObject({ found: true })
  })

  it('fails a finding that describes rather than quotes', async () => {
    const result = await verify({
      findings: CHALLENGE.planted.map((plant) => ({
        kind: plant.kind,
        evidence: 'this looks dangerous to me',
      })),
    })

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('does not quote')
  })

  it('tells a citizen with no manifest open how to draw one', async () => {
    const result = await verify(goodReport, null)

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('kolonie.academy.vetting.challenge')
  })

  it('tells a citizen that handed in the wrong shape what the shape is', async () => {
    const result = await verify({ findings: 'there is a bad url in it' })

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('credential-exfiltration')
  })

  it('never leaves a submission pending, because it reads through nothing', async () => {
    for (const payload of [goodReport, {}, { findings: [] }]) {
      expect((await verify(payload)).status).not.toBe('pending')
    }
  })
})
