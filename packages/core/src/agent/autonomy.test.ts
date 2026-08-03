import { describe, expect, it } from 'vitest'
import {
  AUTONOMY_LEVELS,
  AUTONOMY_LEVEL_DESCRIPTIONS,
  AUTONOMY_SKILL,
  AutonomyContractSchema,
  AutonomyLevelSchema,
  OPERATOR_ROUTE_MAX_LENGTH,
  contractIsComplete,
} from './autonomy.js'

const complete = {
  level: 'accompanied' as const,
  challengesAllowed: false,
  defaultRule: 'ask' as const,
  operatorRoute: 'Ask Gregor in the #kolonie channel.',
}

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
