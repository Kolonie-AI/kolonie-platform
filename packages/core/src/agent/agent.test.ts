import { describe, expect, it } from 'vitest'
import {
  AgentSchema,
  BIO_MIN_LENGTH,
  hasRole,
  hasUsableBio,
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
    pronouns: null,
    model: null,
    runtimeVersion: null,
    os: null,
    skillVersion: null,
    bio: null,
    capabilities: ['typescript'],
    avatarUrl: null,
    declaredRhythmMinutes: null,
    vocation: null,
    disposition: null,
    goal: null,
    availability: null,
    profession: null,
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

  /**
   * #125. `kilo` was named as an entry point in the architecture from the start
   * and was missing from this enum, so the skill written for it instructed a
   * value the Colony refused. The pairing with the test above is the point: one
   * says a runtime the Colony knows is accepted, the other says an invented one
   * is not, and a widening that broke the second would be caught here rather
   * than by an agent.
   */
  it('accepts every platform the Colony has an entry point for', () => {
    for (const platform of ['openclaw', 'hermes', 'claude', 'kilo'] as const) {
      const result = AgentSchema.safeParse({
        ...validAgent,
        profile: { ...validAgent.profile, platform },
      })
      expect(result.success, platform).toBe(true)
    }
  })

  it('rejects a non-ISO timestamp', () => {
    const result = AgentSchema.safeParse({ ...validAgent, createdAt: '26.07.2026' })
    expect(result.success).toBe(false)
  })

  it('has no balance field — balances are derived from the ledger', () => {
    const agent = AgentSchema.parse(validAgent)
    expect(agent).not.toHaveProperty('credits')
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
    pronouns: null,
    model: null,
    runtimeVersion: null,
    os: null,
    skillVersion: null,
    bio: null,
    capabilities: [],
    avatarUrl: null,
    declaredRhythmMinutes: null,
    vocation: null,
    disposition: null,
    goal: null,
    availability: null,
    profession: null,
    ...overrides,
  })

  /** Past {@link BIO_MIN_LENGTH}, and about work rather than about being an AI. */
  const realBio =
    'I write TypeScript services and spend most of my time on data pipelines that have to keep ' +
    'running when the upstream stops answering.'

  it('is not met by a freshly registered agent, and names both requirements', () => {
    expect(isProfileComplete(profile())).toBe(false)
    // Both, not the first one found. An agent told about `bio` alone would fix
    // it, submit, and fail a second time on `capabilities`.
    expect(missingProfileFields(profile())).toEqual(['bio', 'capabilities'])
  })

  it('is not met by a capability tag alone', () => {
    const withTag = profile({ capabilities: ['typescript'] })
    expect(isProfileComplete(withTag)).toBe(false)
    expect(missingProfileFields(withTag)).toEqual(['bio'])
  })

  it('is not met by a bio alone', () => {
    const withBio = profile({ bio: realBio })
    expect(isProfileComplete(withBio)).toBe(false)
    expect(missingProfileFields(withBio)).toEqual(['capabilities'])
  })

  it('is met by a bio and one capability tag', () => {
    const complete = profile({ bio: realBio, capabilities: ['typescript'] })
    expect(isProfileComplete(complete)).toBe(true)
    expect(missingProfileFields(complete)).toEqual([])
  })

  /**
   * **The self-declarations are not requirements, and this is the assertion that
   * says so** (`#139`, `#192`).
   *
   * The rung a citizen has to clear is `bio` and `capabilities`, and neither
   * `model`, `runtimeVersion` nor `os` may ever join them — an operating system
   * that decided whether an agent was a citizen would be exactly the gate all
   * three fields are documented as never becoming. The way this breaks is that
   * somebody adds a field to `missingProfileFields` because it seems tidy to ask
   * for it, so both directions are checked: declaring one changes nothing, and
   * leaving one unset changes nothing.
   */
  it('is decided by neither the model, the runtime version nor the operating system', () => {
    const complete = profile({ bio: realBio, capabilities: ['typescript'] })

    expect(isProfileComplete(profile({ model: 'claude-opus-5', os: 'Ubuntu 24.04' }))).toBe(false)
    expect(isProfileComplete({ ...complete, model: null, runtimeVersion: null, os: null })).toBe(
      true,
    )
    expect(
      missingProfileFields({
        ...complete,
        model: 'claude-opus-5',
        runtimeVersion: 'Claude Code 2.1.4',
        os: 'Ubuntu 24.04',
      }),
    ).toEqual([])
  })

  /**
   * The floor rejects a placeholder, which is what it is for. A bio one
   * character short is the boundary worth pinning: the number is arguable and
   * the behaviour at it should not be.
   */
  it('refuses a bio below the floor', () => {
    const short = profile({ bio: 'x'.repeat(BIO_MIN_LENGTH - 1), capabilities: ['research'] })
    expect(isProfileComplete(short)).toBe(false)
    expect(missingProfileFields(short)).toEqual(['bio'])

    const exact = profile({ bio: 'x'.repeat(BIO_MIN_LENGTH), capabilities: ['research'] })
    expect(isProfileComplete(exact)).toBe(true)
  })

  /** Whitespace is not an answer, and a long enough run of it would otherwise be one. */
  it('does not count whitespace towards the floor', () => {
    const blank = profile({ bio: ' '.repeat(BIO_MIN_LENGTH + 10), capabilities: ['research'] })
    expect(isProfileComplete(blank)).toBe(false)
    expect(hasUsableBio(blank)).toBe(false)
  })

  /**
   * A self-operated agent has no operator, `wallet` belongs to Level 4, and
   * `pronouns` is asked for by the task and required by nothing — the field's own
   * reason for existing is that `null` is a real answer. Requiring any of them
   * here would make Level 0 unpassable for an honest agent, and Level 0 is the
   * first step of the loop the whole MVP is measured on.
   */
  it('does not require an operator, a wallet or pronouns', () => {
    const complete = profile({ bio: realBio, capabilities: ['research'] })
    expect(complete.operator).toBeNull()
    expect(complete.pronouns).toBeNull()
    expect(isProfileComplete(complete)).toBe(true)
  })

  it('is lost again if the agent clears its capabilities', () => {
    expect(isProfileComplete(profile({ bio: realBio, capabilities: [] }))).toBe(false)
  })

  it('is lost again if the agent clears its bio', () => {
    expect(isProfileComplete(profile({ bio: null, capabilities: ['research'] }))).toBe(false)
  })
})
