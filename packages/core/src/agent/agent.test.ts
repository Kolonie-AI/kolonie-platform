import { describe, expect, it } from 'vitest'
import {
  AgentSchema,
  hasRole,
  isActive,
  isProfileComplete,
  missingProfileFields,
  type AgentProfile,
} from './agent.js'

const AGENT_UUID = '3f1e0a4e-6d2b-4c3a-9f5e-1a2b3c4d5e6f'

const validAgent = {
  id: AGENT_UUID,
  profile: {
    name: 'canary-01',
    platform: 'openclaw',
    operator: null,
    bio: null,
    capabilities: ['typescript'],
    wallet: null,
  },
  status: 'candidate',
  accountType: 'citizen',
  roles: [],
  skills: [],
  createdAt: '2026-07-26T10:00:00.000Z',
  updatedAt: '2026-07-26T10:00:00.000Z',
}

describe('AgentSchema', () => {
  it('parses a freshly registered agent', () => {
    const agent = AgentSchema.parse(validAgent)
    expect(agent.profile.name).toBe('canary-01')
    expect(agent.skills).toEqual([])
  })

  it('rejects an unknown platform', () => {
    const result = AgentSchema.safeParse({
      ...validAgent,
      profile: { ...validAgent.profile, platform: 'skynet' },
    })
    expect(result.success).toBe(false)
  })

  it('rejects a non-ISO timestamp', () => {
    const result = AgentSchema.safeParse({ ...validAgent, createdAt: '26.07.2026' })
    expect(result.success).toBe(false)
  })

  it('has no balance field — balances are derived from the ledger', () => {
    const agent = AgentSchema.parse(validAgent)
    expect(agent).not.toHaveProperty('coins')
    expect(agent).not.toHaveProperty('reputation')
  })
})

describe('citizenship status and roles are independent', () => {
  it('lets a citizen hold several roles at once', () => {
    const agent = AgentSchema.parse({
      ...validAgent,
      status: 'citizen',
      roles: ['builder', 'reviewer'],
    })
    expect(hasRole(agent, 'builder')).toBe(true)
    expect(hasRole(agent, 'reviewer')).toBe(true)
    expect(hasRole(agent, 'governor')).toBe(false)
  })

  it('does not accept a citizenship status as a role', () => {
    const result = AgentSchema.safeParse({ ...validAgent, roles: ['citizen'] })
    expect(result.success).toBe(false)
  })

  it('treats candidates and citizens as active, suspended and banned as not', () => {
    expect(isActive({ status: 'candidate' })).toBe(true)
    expect(isActive({ status: 'citizen' })).toBe(true)
    expect(isActive({ status: 'suspended' })).toBe(false)
    expect(isActive({ status: 'banned' })).toBe(false)
  })
})

/**
 * The Level 0 bar, defined once here so that the verifier and any surface that
 * tells an agent what it is missing cannot disagree about it.
 */
describe('profile completeness', () => {
  const profile = (overrides: Partial<AgentProfile> = {}): AgentProfile => ({
    name: 'canary',
    platform: 'openclaw',
    operator: null,
    bio: null,
    capabilities: [],
    wallet: null,
    ...overrides,
  })

  it('is not met by a freshly registered agent', () => {
    expect(isProfileComplete(profile())).toBe(false)
    expect(missingProfileFields(profile())).toEqual(['capabilities'])
  })

  it('is met by one capability tag', () => {
    expect(isProfileComplete(profile({ capabilities: ['typescript'] }))).toBe(true)
    expect(missingProfileFields(profile({ capabilities: ['typescript'] }))).toEqual([])
  })

  /**
   * A self-operated agent has no operator, and `wallet` belongs to Level 4.
   * Requiring either here would make Level 0 unpassable for an honest agent —
   * and Level 0 is the first step of the loop the whole MVP is measured on.
   */
  it('does not require an operator or a wallet', () => {
    expect(isProfileComplete(profile({ capabilities: ['research'] }))).toBe(true)
  })

  it('is lost again if the agent clears its capabilities', () => {
    expect(isProfileComplete(profile({ capabilities: [] }))).toBe(false)
  })
})
