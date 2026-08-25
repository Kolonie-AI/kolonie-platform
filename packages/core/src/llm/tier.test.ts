import { describe, expect, it } from 'vitest'
import {
  CAPABILITY_TIERS,
  CapabilityTierSchema,
  GATEWAY_MAX_TOKENS_VARS,
  maxTokensFromEnvironment,
  type CapabilityTier,
} from './tier.js'

/**
 * A service asks for a capability tier, never for a model (`#1694`).
 *
 * The measurement this rests on: on 2026-08-25, against both live gateways with
 * six service keys each, `@preset/tier-1`, `@preset/tier-2` and `@preset/tier-3`
 * answered HTTP 200 with a correct answer, 12 of 12. So the string is sent
 * unchanged and there is no per-gateway spelling to normalise.
 */
describe('the capability tiers', () => {
  it('is a closed set of exactly three', () => {
    expect(CAPABILITY_TIERS).toEqual(['@preset/tier-1', '@preset/tier-2', '@preset/tier-3'])
  })

  it('refuses a tier outside the set', () => {
    expect(CapabilityTierSchema.safeParse('@preset/tier-4').success).toBe(false)
    expect(CapabilityTierSchema.safeParse('tier-1').success).toBe(false)
    expect(CapabilityTierSchema.safeParse('openai/gpt-4o-mini').success).toBe(false)
  })

  it('accepts each of the three', () => {
    for (const tier of CAPABILITY_TIERS) {
      expect(CapabilityTierSchema.parse(tier)).toBe(tier)
    }
  })

  /**
   * The type is derived from the schema and not declared beside it, so a tier
   * added to one and not the other cannot compile.
   */
  it('derives its type from the schema', () => {
    const tier: CapabilityTier = '@preset/tier-2'
    expect(CAPABILITY_TIERS).toContain(tier)
  })
})

/**
 * The operator ceiling, which is unset in the ordinary case (`#1694`).
 *
 * `max_tokens` is a ceiling and not a reservation: the model stops on its own,
 * so a number set here can only ever be too small, and a truncated reply is
 * well-formed — the damage is silent. What replaces it is
 * `finish_reason === 'length'` treated as a failed call.
 */
describe('the per-service token ceiling', () => {
  it('names a ceiling variable for every service that has a key variable', async () => {
    const { GATEWAY_API_KEY_VARS } = await import('./gateway.js')
    expect(Object.keys(GATEWAY_MAX_TOKENS_VARS).sort()).toEqual(
      Object.keys(GATEWAY_API_KEY_VARS).sort(),
    )
  })

  it('is undefined when nothing is set', () => {
    expect(maxTokensFromEnvironment('verifier', {})).toBeUndefined()
    expect(maxTokensFromEnvironment('verifier', { LLM_GATEWAY_MAX_TOKENS_VERIFIER: '' })).toBe(
      undefined,
    )
  })

  it('reads a ceiling somebody set for one service', () => {
    expect(
      maxTokensFromEnvironment('moderation', { LLM_GATEWAY_MAX_TOKENS_MODERATION: '4000' }),
    ).toBe(4000)
  })

  /**
   * A variable that is not a positive integer is treated as unset rather than
   * as a ceiling of zero, which would refuse every call in the name of
   * containing an incident.
   */
  it('ignores a value that is not a positive whole number', () => {
    for (const value of ['0', '-1', 'lots', '1.5']) {
      expect(maxTokensFromEnvironment('triage', { LLM_GATEWAY_MAX_TOKENS_TRIAGE: value })).toBe(
        undefined,
      )
    }
  })

  it('reads one service’s ceiling and not another’s', () => {
    const env = { LLM_GATEWAY_MAX_TOKENS_MODERATION: '4000' }
    expect(maxTokensFromEnvironment('moderation', env)).toBe(4000)
    expect(maxTokensFromEnvironment('verifier', env)).toBeUndefined()
  })
})
