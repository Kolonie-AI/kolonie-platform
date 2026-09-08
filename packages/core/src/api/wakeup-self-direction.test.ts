import { describe, expect, it } from 'vitest'
import { SelfDirectionWakeupNextSchema } from '../workplace/workplace.js'
import { SelfDirectionWakeupActionSchema } from './wakeup.js'

describe('the self-direction wakeup action (#1893)', () => {
  it('names the one verb with only the act it needs', () => {
    const next = SelfDirectionWakeupNextSchema.parse({
      tool: 'kolonie.academy.self-direction',
      arguments: { act: 'start' },
    })
    expect(next.arguments).toEqual({ act: 'start' })
    expect(() =>
      SelfDirectionWakeupNextSchema.parse({
        tool: 'kolonie.academy.self-direction',
        arguments: { act: 'start', responses: [] },
      }),
    ).toThrow()
  })

  it('carries only the state and the instant, never a score or prose', () => {
    const action = SelfDirectionWakeupActionSchema.parse({
      state: 'awaiting-reflection',
      since: '2026-09-08T00:00:00.000Z',
      next: {
        tool: 'kolonie.academy.self-direction',
        arguments: { act: 'reflect' },
      },
    })
    expect(action.state).toBe('awaiting-reflection')
    expect(Object.keys(action)).toEqual(['state', 'since', 'next'])
  })
})
