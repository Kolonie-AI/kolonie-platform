import { describe, expect, it } from 'vitest'
import {
  AUTONOMY_LEVELS,
  AUTONOMY_LEVEL_DESCRIPTIONS,
  AUTONOMY_SKILL,
  AutonomyCapabilitySchema,
  AutonomyContractSchema,
  AutonomyContractVersionSchema,
  AutonomyLevelSchema,
  OPERATOR_ROUTE_MAX_LENGTH,
  capabilityDecision,
  capabilityRefusal,
  compareAutonomyContracts,
  contractIsComplete,
  type AutonomyCapability,
} from './autonomy.js'

const complete = {
  level: 'accompanied' as const,
  challengesAllowed: false,
  defaultRule: 'ask' as const,
  operatorRoute: 'Ask Gregor in the #kolonie channel.',
}

describe('AutonomyCapabilitySchema', () => {
  it('accepts the named capability and refuses integers and unknown names', () => {
    expect(AutonomyCapabilitySchema.safeParse('web-server').success).toBe(true)
    expect(AutonomyCapabilitySchema.safeParse(1).success).toBe(false)
    expect(AutonomyCapabilitySchema.safeParse('money').success).toBe(false)
  })
})

describe('AutonomyLevelSchema', () => {
  it('is three named values, not integers', () => {
    // A stored `2` would change meaning the day a fourth level is inserted
    // between the existing ones — the obvious next one concerns money.
    expect(AUTONOMY_LEVELS).toEqual(['accompanied', 'independent', 'free'])
    expect(AutonomyLevelSchema.safeParse(2).success).toBe(false)
  })

  it('describes every level it offers', () => {
    // The form, the rung text and the docs read one source, so they cannot
    // describe the same level differently.
    for (const level of AUTONOMY_LEVELS) {
      expect(AUTONOMY_LEVEL_DESCRIPTIONS[level]).toBeTruthy()
    }
  })
})

describe('AutonomyContractSchema', () => {
  it('accepts a complete contract', () => {
    expect(contractIsComplete(complete)).toBe(true)
  })

  it('requires the route at every level, including free', () => {
    // A free agent still needs somewhere to send *this is impossible for me*.
    // Without it the contract is dead the moment the agent runs from cron.
    for (const level of AUTONOMY_LEVELS) {
      expect(contractIsComplete({ ...complete, level })).toBe(true)
      expect(contractIsComplete({ ...complete, level, operatorRoute: '' })).toBe(false)
    }
  })

  it('refuses a contract with no default rule', () => {
    const { defaultRule: _drop, ...withoutRule } = complete
    expect(contractIsComplete(withoutRule)).toBe(false)
  })

  it('refuses a contract that leaves the challenge permission unsaid', () => {
    // An absence of prohibition and a permission granted in as many words are
    // different things for a reader that is cautious by construction.
    const { challengesAllowed: _drop, ...withoutPermission } = complete
    expect(contractIsComplete(withoutPermission)).toBe(false)
  })

  it('accepts an omitted capability set for contracts written before it existed', () => {
    expect(AutonomyContractSchema.safeParse(complete).success).toBe(true)
  })

  it('accepts web-server once and refuses unknown or duplicate capabilities', () => {
    expect(
      AutonomyContractSchema.safeParse({ ...complete, capabilities: ['web-server'] }).success,
    ).toBe(true)
    expect(AutonomyContractSchema.safeParse({ ...complete, capabilities: ['money'] }).success).toBe(
      false,
    )
    expect(
      AutonomyContractSchema.safeParse({
        ...complete,
        capabilities: ['web-server', 'web-server'],
      }).success,
    ).toBe(false)
  })

  it('refuses an unknown level', () => {
    expect(contractIsComplete({ ...complete, level: 'unlimited' })).toBe(false)
  })

  it('refuses a route longer than the bound rather than truncating it', () => {
    expect(
      contractIsComplete({ ...complete, operatorRoute: 'x'.repeat(OPERATOR_ROUTE_MAX_LENGTH + 1) }),
    ).toBe(false)
  })

  it('trims a route that is only whitespace down to nothing, and refuses it', () => {
    expect(contractIsComplete({ ...complete, operatorRoute: '   ' })).toBe(false)
  })
})

describe('what completeness deliberately does not read', () => {
  /**
   * The property most likely to erode, pinned here rather than described.
   * Anything that made a broad contract pass more easily than a narrow one would
   * put the Colony's thumb on a private negotiation, through an agent that has to
   * keep working with the person on the other side of it.
   */
  it('passes the narrowest contract exactly as it passes the broadest', () => {
    const narrowest = {
      level: 'accompanied' as const,
      challengesAllowed: false,
      defaultRule: 'refrain' as const,
      operatorRoute: 'Ask first, always.',
    }
    const broadest = {
      level: 'free' as const,
      challengesAllowed: true,
      defaultRule: 'ask' as const,
      operatorRoute: 'Ask first, always.',
    }

    expect(contractIsComplete(narrowest)).toBe(contractIsComplete(broadest))
    expect(contractIsComplete(narrowest)).toBe(true)
  })
})

describe('the skill it grants', () => {
  it('is named for having clarified limits and not for autonomy', () => {
    // A skill called `autonomous` would make a self-operated agent automatically
    // maximal, and would rank an honestly-constrained citizen below a loosely
    // worded one.
    expect(AUTONOMY_SKILL).toBe('limits-clarified')
    expect(AUTONOMY_SKILL).not.toContain('autonom')
  })
})

describe('AutonomyContractSchema strictness', () => {
  it('keeps the level out of anything ordered', () => {
    // Not a behaviour test but a shape one: the levels are a Zod enum of strings
    // with no numeric mapping anywhere in core, so nothing downstream can sort
    // citizens by them without inventing an order of its own — which review
    // would then see.
    expect(AUTONOMY_LEVELS.every((level) => typeof level === 'string')).toBe(true)
    expect(AutonomyContractSchema.shape.level.safeParse('free').success).toBe(true)
  })
})

describe('autonomy contract revisions', () => {
  it('parses a historical version with its own dates', () => {
    expect(
      AutonomyContractVersionSchema.safeParse({
        ...complete,
        recordedAt: '2026-08-09T10:00:00.000Z',
        reviewDueAt: '2027-08-09T10:00:00.000Z',
        supersededAt: '2026-08-10T10:00:00.000Z',
      }).success,
    ).toBe(true)
    expect(
      AutonomyContractVersionSchema.safeParse({
        ...complete,
        recordedAt: '2026-08-09T10:00:00.000Z',
        reviewDueAt: '2027-08-09T10:00:00.000Z',
        supersededAt: 'not-a-date',
      }).success,
    ).toBe(false)
  })

  it('names every permission that became narrower', () => {
    expect(
      compareAutonomyContracts(
        {
          ...complete,
          level: 'free',
          challengesAllowed: true,
          capabilities: ['web-server'],
          defaultRule: 'ask',
        },
        {
          ...complete,
          level: 'accompanied',
          challengesAllowed: false,
          capabilities: [],
          defaultRule: 'refrain',
        },
      ),
    ).toEqual({
      direction: 'narrowed',
      narrowed: [
        { field: 'level', from: 'free', to: 'accompanied' },
        { field: 'challengesAllowed', from: 'allowed', to: 'not allowed' },
        { field: 'capabilities', from: 'web-server', to: 'not granted' },
        { field: 'defaultRule', from: 'ask', to: 'refrain' },
      ],
    })
  })

  it('reports a mixed revision without hiding its withdrawal', () => {
    expect(
      compareAutonomyContracts(
        { ...complete, level: 'accompanied', challengesAllowed: true },
        { ...complete, level: 'independent', challengesAllowed: false },
      ),
    ).toEqual({
      direction: 'mixed',
      narrowed: [{ field: 'challengesAllowed', from: 'allowed', to: 'not allowed' }],
    })
  })

  it('does not call a route-only correction a permission change', () => {
    expect(
      compareAutonomyContracts(complete, { ...complete, operatorRoute: 'Use the console.' }),
    ).toEqual({ direction: 'unchanged', narrowed: [] })
  })
})

/**
 * The one predicate every surface asking for a capability consults (`#660`).
 *
 * It lives here rather than in the rung so the next thing wanting a listening
 * socket reads the same field: a capability enforced in one place is one an
 * operator can withdraw in one place.
 */
describe('deciding on a capability', () => {
  const contract = (capabilities: AutonomyCapability[], defaultRule: 'ask' | 'refrain') => ({
    capabilities,
    defaultRule,
  })

  it('grants what the contract names', () => {
    expect(capabilityDecision(contract(['web-server'], 'refrain'), 'web-server')).toBe('granted')
  })

  it('asks where the contract is silent and its rule is to ask', () => {
    expect(capabilityDecision(contract([], 'ask'), 'web-server')).toBe('ask')
  })

  it('refrains where the contract is silent and its rule is to refrain', () => {
    expect(capabilityDecision(contract([], 'refrain'), 'web-server')).toBe('refrain')
  })

  /**
   * No contract is the state most citizens are in, and it must not read as a
   * refusal: `defaultRule` is a rule an operator chose, and nobody has chosen
   * one here.
   */
  it('asks where there is no contract at all', () => {
    expect(capabilityDecision(null, 'web-server')).toBe('ask')
  })

  it('says what a citizen stopped by refrain would have to get changed', () => {
    const refusal = capabilityRefusal('web-server')

    expect(refusal).toContain('web-server')
    expect(refusal).toContain('kolonie.autonomy.read')
    // `#518`'s rule, held to here too: being limited by an operator is not a
    // failure of the citizen's and costs it nothing elsewhere.
    expect(refusal).toContain('costs you nothing')
  })
})
