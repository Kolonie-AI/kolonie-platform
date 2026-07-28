import { describe, expect, it } from 'vitest'
import {
  AgentSchema,
  SubmissionSchema,
  type Agent,
  type AgentProfile,
  type Submission,
} from '@kolonie-ai/core'
import { ProfileCompleteVerifier } from './profile-complete.js'

const verifier = new ProfileCompleteVerifier()

const anAgent = (profile: Partial<AgentProfile> = {}): Agent =>
  AgentSchema.parse({
    id: '11111111-2222-4333-8444-555555555555',
    profile: {
      name: 'canary',
      platform: 'openclaw',
      operator: null,
      capabilities: [],
      wallet: null,
      ...profile,
    },
    status: 'candidate',
    roles: [],
    level: 0,
    createdAt: '2026-07-28T10:00:00.000Z',
    updatedAt: '2026-07-28T10:00:00.000Z',
  })

const aSubmission = (payload: Record<string, unknown> = {}): Submission =>
  SubmissionSchema.parse({
    id: '9c8b7a6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
    taskId: '3f1e0a4e-6d2b-4c3a-9f5e-1a2b3c4d5e6f',
    agentId: '11111111-2222-4333-8444-555555555555',
    payload,
    status: 'verifying',
    attempt: 1,
    submittedAt: '2026-07-28T10:00:00.000Z',
    verifiedAt: null,
  })

describe('ProfileCompleteVerifier', () => {
  it('handles the profile-complete task type', () => {
    expect(String(verifier.taskType)).toBe('profile-complete')
  })

  it('passes an agent that has set its capabilities', async () => {
    const result = await verifier.verify(aSubmission(), {
      agent: anAgent({ capabilities: ['typescript', 'research'] }),
    })

    expect(result.status).toBe('pass')
    expect(result.evidence).toBeTruthy()
  })

  it('fails an agent whose profile is still empty, and names the field', async () => {
    const result = await verifier.verify(aSubmission(), { agent: anAgent() })

    expect(result.status).toBe('fail')
    // The agent has to learn what to fix. `evidence` is the only channel it has.
    expect(result.evidence).toContain('capabilities')
    expect(result.metadata?.['missing']).toEqual(['capabilities'])
  })

  /**
   * The reason `VerificationContext` exists (D-018), stated as a test.
   *
   * Without this, the cheapest possible implementation — read `capabilities` off
   * the payload — passes every other test in this file. It must not pass this
   * one: an agent that writes its capabilities into a submission body has told
   * the Colony nothing, because the profile every other surface reads is still
   * empty. Level 0 pays a coin; a verifier that accepts self-attestation is a
   * coin for nothing.
   */
  it('ignores a payload that claims what the profile does not', async () => {
    const result = await verifier.verify(aSubmission({ capabilities: ['everything'] }), {
      agent: anAgent(),
    })

    expect(result.status).toBe('fail')
  })

  /** The mirror of the above: a real profile passes even with an empty payload. */
  it('passes on an empty payload when the profile is genuinely complete', async () => {
    const result = await verifier.verify(aSubmission(), {
      agent: anAgent({ capabilities: ['typescript'] }),
    })

    expect(result.status).toBe('pass')
  })

  /**
   * Level 4 is where a wallet is earned and an operator is optional forever —
   * requiring either here would make Level 0 unpassable for an honest, freshly
   * registered, self-operated agent, which is every agent the MVP is measured on.
   */
  it('does not require an operator or a wallet', async () => {
    const result = await verifier.verify(aSubmission(), {
      agent: anAgent({ capabilities: ['research'], operator: null, wallet: null }),
    })

    expect(result.status).toBe('pass')
  })

  it('records the capabilities it saw, as the audit trail behind the payout', async () => {
    const result = await verifier.verify(aSubmission(), {
      agent: anAgent({ capabilities: ['typescript', 'solidity'] }),
    })

    expect(result.metadata?.['capabilities']).toEqual(['typescript', 'solidity'])
  })
})
