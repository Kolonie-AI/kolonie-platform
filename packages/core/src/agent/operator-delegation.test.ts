import { describe, expect, it } from 'vitest'
import {
  AgentOperatorCapabilitySetSchema,
  AgentOperatorDelegationSchema,
  AgentOperatorDelegationStatusSchema,
} from './operator-delegation.js'

const OPERATOR = '3f1e0a4e-6d2b-4c3a-9f5e-1a2b3c4d5e6f'
const SUBJECT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const DELEGATION = '11111111-2222-4333-8444-555555555555'
const REQUESTED_AT = '2026-09-01T16:00:00.000Z'

const pendingDelegation = {
  id: DELEGATION,
  operatorAgentId: OPERATOR,
  subjectAgentId: SUBJECT,
  capabilities: ['workplace-read', 'message'],
  status: 'pending',
  requestedAt: REQUESTED_AT,
  acceptedAt: null,
  revokedAt: null,
  revokedByAgentId: null,
}

describe('AgentOperatorDelegationSchema', () => {
  it('parses a direct pending delegation with a normalized exact capability subset', () => {
    expect(AgentOperatorDelegationSchema.parse(pendingDelegation)).toEqual(pendingDelegation)
  })

  it('accepts only the four delegated capabilities in canonical order without duplicates', () => {
    expect(
      AgentOperatorCapabilitySetSchema.parse([
        'workplace-read',
        'workplace-write',
        'message',
        'handover',
      ]),
    ).toEqual(['workplace-read', 'workplace-write', 'message', 'handover'])
    expect(AgentOperatorCapabilitySetSchema.safeParse([]).success).toBe(false)
    expect(AgentOperatorCapabilitySetSchema.safeParse(['account']).success).toBe(false)
    expect(AgentOperatorCapabilitySetSchema.safeParse(['message', 'workplace-read']).success).toBe(
      false,
    )
    expect(AgentOperatorCapabilitySetSchema.safeParse(['message', 'message']).success).toBe(false)
  })

  it('accepts only pending, active, and revoked status', () => {
    expect(AgentOperatorDelegationStatusSchema.options).toEqual(['pending', 'active', 'revoked'])
    expect(AgentOperatorDelegationStatusSchema.safeParse('accepted').success).toBe(false)
  })

  it('rejects self-delegation without rejecting reciprocal direct grants', () => {
    expect(
      AgentOperatorDelegationSchema.safeParse({
        ...pendingDelegation,
        subjectAgentId: OPERATOR,
      }).success,
    ).toBe(false)
    expect(
      AgentOperatorDelegationSchema.safeParse({
        ...pendingDelegation,
        id: '66666666-7777-4888-8999-000000000000',
        operatorAgentId: SUBJECT,
        subjectAgentId: OPERATOR,
      }).success,
    ).toBe(true)
  })

  it('requires lifecycle timestamps and revoker identity to match status', () => {
    expect(
      AgentOperatorDelegationSchema.safeParse({
        ...pendingDelegation,
        status: 'active',
        acceptedAt: '2026-09-01T16:01:00.000Z',
      }).success,
    ).toBe(true)
    expect(
      AgentOperatorDelegationSchema.safeParse({
        ...pendingDelegation,
        status: 'active',
      }).success,
    ).toBe(false)
    expect(
      AgentOperatorDelegationSchema.safeParse({
        ...pendingDelegation,
        status: 'active',
        acceptedAt: '2026-09-01T15:59:00.000Z',
      }).success,
    ).toBe(false)
    expect(
      AgentOperatorDelegationSchema.safeParse({
        ...pendingDelegation,
        status: 'revoked',
        revokedAt: '2026-09-01T16:02:00.000Z',
        revokedByAgentId: SUBJECT,
      }).success,
    ).toBe(true)
    expect(
      AgentOperatorDelegationSchema.safeParse({
        ...pendingDelegation,
        status: 'revoked',
        revokedAt: '2026-09-01T15:59:00.000Z',
        revokedByAgentId: SUBJECT,
      }).success,
    ).toBe(false)
    expect(
      AgentOperatorDelegationSchema.safeParse({
        ...pendingDelegation,
        revokedAt: '2026-09-01T16:02:00.000Z',
        revokedByAgentId: SUBJECT,
      }).success,
    ).toBe(false)
  })

  it('permits only a recorded party to be the revoker', () => {
    expect(
      AgentOperatorDelegationSchema.safeParse({
        ...pendingDelegation,
        status: 'revoked',
        revokedAt: '2026-09-01T16:02:00.000Z',
        revokedByAgentId: '99999999-aaaa-4bbb-8ccc-dddddddddddd',
      }).success,
    ).toBe(false)
  })

  it('contains no chain, inherited authority, credential, or human operator fields', () => {
    for (const field of [
      'parentDelegationId',
      'delegatingAgentId',
      'actingAgentId',
      'credentialId',
      'humanId',
    ]) {
      expect(
        AgentOperatorDelegationSchema.safeParse({ ...pendingDelegation, [field]: DELEGATION })
          .success,
        field,
      ).toBe(false)
    }
  })
})
