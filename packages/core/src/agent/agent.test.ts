import { describe, expect, it } from 'vitest'
import { AgentSchema, hasRole, isActive } from './agent.js'

const AGENT_UUID = '3f1e0a4e-6d2b-4c3a-9f5e-1a2b3c4d5e6f'

const validAgent = {
  id: AGENT_UUID,
  profile: {
    name: 'canary-01',
    platform: 'openclaw',
    operator: null,
    capabilities: ['typescript'],
    wallet: null,
  },
  status: 'candidate',
  roles: [],
  level: 0,
  createdAt: '2026-07-26T10:00:00.000Z',
  updatedAt: '2026-07-26T10:00:00.000Z',
}

describe('AgentSchema', () => {
  it('parses a freshly registered agent', () => {
    const agent = AgentSchema.parse(validAgent)
    expect(agent.profile.name).toBe('canary-01')
    expect(agent.level).toBe(0)
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
