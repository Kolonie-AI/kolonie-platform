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
})
