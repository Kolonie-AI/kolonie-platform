import { describe, expect, it } from 'vitest'
import { ModelCallSchema } from './model-call.js'

describe('model call accounting', () => {
  it('accepts the route, echoed model and token counts', () => {
    expect(
      ModelCallSchema.parse({
        route: 'openrouter',
        model: 'vendor/model-that-answered',
        tokens: { prompt: 308, completion: 5, total: 313 },
      }),
    ).toEqual({
      route: 'openrouter',
      model: 'vendor/model-that-answered',
      tokens: { prompt: 308, completion: 5, total: 313 },
    })
  })

  it('refuses a configured model standing in for an absent response model', () => {
    expect(
      ModelCallSchema.safeParse({
        route: 'openrouter',
        tokens: { prompt: 308, completion: 5, total: 313 },
      }).success,
    ).toBe(false)
  })

  /**
   * A subscription bills nothing per token and reports no `usage` (`#716`). The
   * route and the model are still measurements, and a record carrying them is
   * worth more than no record.
   */
  it('accepts a call whose provider reported no token counts', () => {
    expect(
      ModelCallSchema.parse({ route: 'gateway', model: 'vendor/model-that-answered' }),
    ).toEqual({ route: 'gateway', model: 'vendor/model-that-answered' })
  })

  it('still refuses a count that is present and not a number', () => {
    expect(
      ModelCallSchema.safeParse({
        route: 'gateway',
        model: 'vendor/model-that-answered',
        tokens: { prompt: 308, completion: 'five', total: 313 },
      }).success,
    ).toBe(false)
  })

  it('accepts the status returned by a route that did not answer', () => {
    expect(
      ModelCallSchema.parse({
        route: 'openrouter',
        model: 'vendor/model-that-answered',
        fallback: { route: 'gateway', reason: 'status', status: 502 },
      }),
    ).toEqual({
      route: 'openrouter',
      model: 'vendor/model-that-answered',
      fallback: { route: 'gateway', reason: 'status', status: 502 },
    })
  })

  it('refuses a fallback status that is not an HTTP status code', () => {
    expect(
      ModelCallSchema.safeParse({
        route: 'openrouter',
        model: 'vendor/model-that-answered',
        fallback: { route: 'gateway', reason: 'status', status: 'bad gateway' },
      }).success,
    ).toBe(false)
  })
})
