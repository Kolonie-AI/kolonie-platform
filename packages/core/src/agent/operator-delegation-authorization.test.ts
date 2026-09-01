import { describe, expect, it } from 'vitest'
import { ERROR_STATUS, ErrorCodeSchema } from '../common/errors.js'
import { AgentIdSchema, AgentOperatorDelegationIdSchema } from '../common/ids.js'
import { AgentOperatorDelegationSchema } from './operator-delegation.js'
import {
  DELEGATION_REFUSAL_CODES,
  decideDelegatedAuthorization,
} from './operator-delegation-authorization.js'

const OPERATOR = AgentIdSchema.parse('3f1e0a4e-6d2b-4c3a-9f5e-1a2b3c4d5e6f')
const SUBJECT = AgentIdSchema.parse('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
const OTHER = AgentIdSchema.parse('99999999-aaaa-4bbb-8ccc-dddddddddddd')
const DELEGATION = AgentOperatorDelegationIdSchema.parse('11111111-2222-4333-8444-555555555555')

const delegation = (overrides: Record<string, unknown> = {}) =>
  AgentOperatorDelegationSchema.parse({
    id: DELEGATION,
    operatorAgentId: OPERATOR,
    subjectAgentId: SUBJECT,
    capabilities: ['workplace-read', 'workplace-write'],
    status: 'active',
    requestedAt: '2026-09-01T16:00:00.000Z',
    acceptedAt: '2026-09-01T16:01:00.000Z',
    revokedAt: null,
    revokedByAgentId: null,
    ...overrides,
  })

describe('decideDelegatedAuthorization', () => {
  it('resolves the subject from the delegation rather than from the caller', () => {
    expect(
      decideDelegatedAuthorization(delegation(), {
        operatorAgentId: OPERATOR,
        delegationId: DELEGATION,
        capability: 'workplace-write',
      }),
    ).toEqual({
      outcome: 'authorized',
      actorAgentId: OPERATOR,
      subjectAgentId: SUBJECT,
      delegationId: DELEGATION,
      capabilities: ['workplace-read', 'workplace-write'],
    })
  })

  it('refuses a delegation that is absent, pending or revoked', () => {
    const ask = {
      operatorAgentId: OPERATOR,
      delegationId: DELEGATION,
      capability: 'workplace-read',
    } as const
    expect(decideDelegatedAuthorization(null, ask)).toEqual({ outcome: 'not-found' })
    expect(
      decideDelegatedAuthorization(delegation({ status: 'pending', acceptedAt: null }), ask),
    ).toEqual({ outcome: 'pending' })
    expect(
      decideDelegatedAuthorization(
        delegation({
          status: 'revoked',
          revokedAt: '2026-09-01T16:05:00.000Z',
          revokedByAgentId: SUBJECT,
        }),
        ask,
      ),
    ).toEqual({ outcome: 'revoked' })
  })

  it('refuses a caller that is not the recorded operator, including the subject itself', () => {
    for (const caller of [OTHER, SUBJECT]) {
      expect(
        decideDelegatedAuthorization(delegation(), {
          operatorAgentId: caller,
          delegationId: DELEGATION,
          capability: 'workplace-read',
        }),
        caller,
      ).toEqual({ outcome: 'wrong-actor' })
    }
  })

  it('refuses a capability the delegation does not name and never widens the set', () => {
    expect(
      decideDelegatedAuthorization(delegation(), {
        operatorAgentId: OPERATOR,
        delegationId: DELEGATION,
        capability: 'handover',
      }),
    ).toEqual({ outcome: 'missing-capability' })
  })

  it('carries a stable branchable error code for every refusal', () => {
    expect(Object.keys(DELEGATION_REFUSAL_CODES).sort()).toEqual([
      'missing-capability',
      'not-found',
      'pending',
      'revoked',
      'wrong-actor',
    ])
    for (const code of Object.values(DELEGATION_REFUSAL_CODES)) {
      expect(ErrorCodeSchema.safeParse(code).success, code).toBe(true)
      expect(typeof ERROR_STATUS[code], code).toBe('number')
    }
    expect(ERROR_STATUS[DELEGATION_REFUSAL_CODES['not-found']]).toBe(404)
    expect(ERROR_STATUS[DELEGATION_REFUSAL_CODES['wrong-actor']]).toBe(403)
    expect(ERROR_STATUS[DELEGATION_REFUSAL_CODES['missing-capability']]).toBe(403)
  })
})
