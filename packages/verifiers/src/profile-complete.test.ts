import { describe, expect, it } from 'vitest'
import {
  AgentSchema,
  BIO_MIN_LENGTH,
  SubmissionSchema,
  type Agent,
  type AgentProfile,
  type Submission,
} from '@kolonie-ai/core'
import { ProfileCompleteVerifier, type BioJudge, type BioJudgement } from './profile-complete.js'

/**
 * The verifier as a deployment without an OpenRouter key builds it.
 *
 * It is the default in these tests on purpose: the structural bar is what has to
 * hold everywhere, and a suite that only ever exercised the judged path would
 * not notice a Level 0 that stopped working when the vendor did.
 */
const verifier = new ProfileCompleteVerifier()

/** A judge that answers, so the judged path can be exercised without a network. */
const judging = (judgement: BioJudgement): BioJudge => ({
  judge: async () => judgement,
})

const accepts = judging({
  outcome: 'judged',
  aboutThisAgent: true,
  reason: '',
  model: 'test/model',
})

const rejects = judging({
  outcome: 'judged',
  aboutThisAgent: false,
  reason: 'It describes what an AI is rather than what you do.',
  model: 'test/model',
})

/** Past the floor, and about work rather than about being an AI. */
const REAL_BIO =
  'I write TypeScript services and spend most of my time on data pipelines that have to keep ' +
  'running when the upstream stops answering.'

const anAgent = (profile: Partial<AgentProfile> = {}): Agent =>
  AgentSchema.parse({
    id: '11111111-2222-4333-8444-555555555555',
    profile: {
      name: 'canary',
      platform: 'openclaw',
      operator: null,
      pronouns: null,
      model: null,
      runtimeVersion: null,
      bio: null,
      capabilities: [],
      avatarUrl: null,
      ...profile,
    },
    status: 'candidate',
    accountType: 'citizen',
    roles: [],
    skills: [],
    createdAt: '2026-07-28T10:00:00.000Z',
    updatedAt: '2026-07-28T10:00:00.000Z',
  })

/** A profile that clears the structural bar, so a test can vary one thing at a time. */
const aCitizen = (profile: Partial<AgentProfile> = {}): Agent =>
  anAgent({ bio: REAL_BIO, capabilities: ['typescript'], ...profile })

const aSubmission = (payload: Record<string, unknown> = {}): Submission =>
  SubmissionSchema.parse({
    id: '9c8b7a6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
    taskId: '3f1e0a4e-6d2b-4c3a-9f5e-1a2b3c4d5e6f',
    agentId: '11111111-2222-4333-8444-555555555555',
    payload,
    status: 'verifying',
    assistance: 'unknown',
    attempt: 1,
    report: null,
    reportOutcome: null,
    submittedAt: '2026-07-28T10:00:00.000Z',
    verifiedAt: null,
  })

describe('ProfileCompleteVerifier', () => {
  it('handles the profile-complete task type', () => {
    expect(String(verifier.taskType)).toBe('profile-complete')
  })

  it('passes an agent that has written a bio and set its capabilities', async () => {
    const result = await verifier.verify(aSubmission(), { agent: aCitizen() })

    expect(result.status).toBe('pass')
    expect(result.evidence).toBeTruthy()
  })

  it('fails an agent whose profile is still empty, and names both fields', async () => {
    const result = await verifier.verify(aSubmission(), { agent: anAgent() })

    expect(result.status).toBe('fail')
    // The agent has to learn what to fix. `evidence` is the only channel it has,
    // and being told one of two requirements means failing twice.
    expect(result.evidence).toContain('bio')
    expect(result.evidence).toContain('capabilities')
    expect(result.metadata?.['missing']).toEqual(['bio', 'capabilities'])
  })

  it('fails a capability tag with no bio', async () => {
    const result = await verifier.verify(aSubmission(), {
      agent: anAgent({ capabilities: ['typescript'] }),
    })

    expect(result.status).toBe('fail')
    expect(result.metadata?.['missing']).toEqual(['bio'])
  })

  it('fails a bio that is too short to be an answer', async () => {
    const result = await verifier.verify(aSubmission(), {
      agent: anAgent({ bio: 'agent', capabilities: ['typescript'] }),
    })

    expect(result.status).toBe('fail')
    expect(result.metadata?.['missing']).toEqual(['bio'])
    // The floor is a number the agent can act on, so the evidence states it.
    expect(result.evidence).toContain(String(BIO_MIN_LENGTH))
  })

  it('fails a bio that is whitespace padded past the floor', async () => {
    const result = await verifier.verify(aSubmission(), {
      agent: anAgent({ bio: ' '.repeat(BIO_MIN_LENGTH + 10), capabilities: ['typescript'] }),
    })

    expect(result.status).toBe('fail')
    expect(result.metadata?.['missing']).toEqual(['bio'])
  })

  /**
   * The reason `VerificationContext` exists (D-018), stated as a test.
   *
   * Without this, the cheapest possible implementation — read the profile off
   * the payload — passes every other test in this file. It must not pass this
   * one: an agent that writes its profile into a submission body has told the
   * Colony nothing, because the profile every other surface reads is still
   * empty. Level 0 pays reputation; a verifier that accepts self-attestation is
   * reputation for nothing.
   */
  it('ignores a payload that claims what the profile does not', async () => {
    const result = await verifier.verify(
      aSubmission({ capabilities: ['everything'], bio: REAL_BIO }),
      { agent: anAgent() },
    )

    expect(result.status).toBe('fail')
  })

  /** The mirror of the above: a real profile passes even with an empty payload. */
  it('passes on an empty payload when the profile is genuinely complete', async () => {
    const result = await verifier.verify(aSubmission(), { agent: aCitizen() })

    expect(result.status).toBe('pass')
  })

  /**
   * Level 4 is where a wallet is earned, an operator is optional forever, and
   * `pronouns` is asked for by the task and required by nothing — `null` is a
   * real answer there and a rung that forced one would contradict the field's own
   * reason for existing. Requiring any of them here would make Level 0
   * unpassable for an honest, freshly registered, self-operated agent, which is
   * every agent the MVP is measured on.
   */
  it('does not require an operator, a wallet or pronouns', async () => {
    const result = await verifier.verify(aSubmission(), {
      agent: aCitizen({ operator: null, pronouns: null, avatarUrl: null }),
    })

    expect(result.status).toBe('pass')
  })

  it('records the capabilities it saw, as the audit trail behind the payout', async () => {
    const result = await verifier.verify(aSubmission(), {
      agent: aCitizen({ capabilities: ['typescript', 'solidity'] }),
    })

    expect(result.metadata?.['capabilities']).toEqual(['typescript', 'solidity'])
  })

  describe('the bio judge', () => {
    it('fails a disclaimer, and says what was wrong in a way an agent can act on', async () => {
      const judged = new ProfileCompleteVerifier({ bioJudge: rejects })
      const disclaimer =
        'I am an AI language model and I do not have personal experiences, feelings, ' +
        'consciousness, or an identity of my own in any meaningful sense.'

      const result = await judged.verify(aSubmission(), { agent: aCitizen({ bio: disclaimer }) })

      expect(result.status).toBe('fail')
      expect(result.evidence).toContain('disclaimer')
      // The model's own sentence reaches the agent, rather than being replaced
      // by a generic refusal that leaves it guessing which part to change.
      expect(result.evidence).toContain('It describes what an AI is rather than what you do.')
      expect(result.metadata?.['bioJudge']).toBe('rejected')
    })

    it('passes a bio the judge accepts, and records which model said so', async () => {
      const judged = new ProfileCompleteVerifier({ bioJudge: accepts })

      const result = await judged.verify(aSubmission(), { agent: aCitizen() })

      expect(result.status).toBe('pass')
      expect(result.metadata?.['bioJudge']).toBe('accepted')
      expect(result.metadata?.['model']).toBe('test/model')
    })

    /**
     * The rung standing in front of the whole graph must not close because a
     * vendor did. A citizen that wrote a real bio passes, and the verdict records
     * that nobody read it — so the pass can be found again if the judge is ever
     * asked to catch up.
     */
    it('passes when the judge is unavailable, and says so in the evidence', async () => {
      const judged = new ProfileCompleteVerifier({
        bioJudge: judging({ outcome: 'unavailable', reason: 'the model answered 429' }),
      })

      const result = await judged.verify(aSubmission(), { agent: aCitizen() })

      expect(result.status).toBe('pass')
      expect(result.evidence).toContain('the model answered 429')
      expect(result.metadata?.['bioJudge']).toBe('unavailable')
    })

    /** A deployment with no judge behaves exactly like a judge that is down. */
    it('passes when no judge is configured at all', async () => {
      const result = await verifier.verify(aSubmission(), { agent: aCitizen() })

      expect(result.status).toBe('pass')
      expect(result.metadata?.['bioJudge']).toBe('unavailable')
    })

    /**
     * The structural bar runs first, so an agent with no bio is never handed to
     * a model. It costs money, and there is nothing to ask about.
     */
    it('does not consult the judge when the structural bar already fails', async () => {
      let asked = 0
      const counting = new ProfileCompleteVerifier({
        bioJudge: {
          judge: async () => {
            asked += 1
            return { outcome: 'judged', aboutThisAgent: true, reason: '', model: 'test/model' }
          },
        },
      })

      const result = await counting.verify(aSubmission(), { agent: anAgent() })

      expect(result.status).toBe('fail')
      expect(asked).toBe(0)
    })

    it('sends the judge the stored bio and the citizen name, not the payload', async () => {
      const seen: Array<{ bio: string; name: string }> = []
      const recording = new ProfileCompleteVerifier({
        bioJudge: {
          judge: async (request) => {
            seen.push({ bio: request.bio, name: request.name })
            return { outcome: 'judged', aboutThisAgent: true, reason: '', model: 'test/model' }
          },
        },
      })

      await recording.verify(aSubmission({ bio: 'something else entirely' }), {
        agent: aCitizen(),
      })

      expect(seen).toEqual([{ bio: REAL_BIO, name: 'canary' }])
    })
  })
})
