import { describe, expect, it, vi } from 'vitest'
import { playbookBlockedTick, type PlaybookBlockedModerationStore } from './playbooks.js'

function aStore(
  overrides: Partial<PlaybookBlockedModerationStore> = {},
): PlaybookBlockedModerationStore {
  return {
    waiting: async () => [],
    evaluate: async () => ({ outcome: 'unchanged' }),
    ...overrides,
  }
}

describe('playbookBlockedTick (#1256)', () => {
  it('returns zeros when nothing is waiting', async () => {
    expect(await playbookBlockedTick({ store: aStore() }, 100)).toEqual({
      considered: 0,
      blocked: 0,
      unchanged: 0,
      empty: 0,
    })
  })

  it('counts transitioned, unchanged and unknown separately', async () => {
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce({
        outcome: 'transitioned',
        blocked: 5,
        completed: 0,
        window: 5,
        revision: 1,
      })
      .mockResolvedValueOnce({ outcome: 'unchanged', blocked: 5, completed: 1, window: 6 })
      .mockResolvedValueOnce({ outcome: 'unknown-playbook' })

    const outcome = await playbookBlockedTick(
      {
        store: aStore({
          waiting: async () => ['a', 'b', 'c'],
          evaluate,
        }),
      },
      100,
    )

    expect(outcome).toEqual({
      considered: 3,
      blocked: 1,
      unchanged: 1,
      empty: 1,
    })
    expect(evaluate).toHaveBeenCalledTimes(3)
  })

  it('caps the waiting batch at PLAYBOOK_BLOCKED_BATCH via the limit passed to waiting', async () => {
    const waiting = vi.fn(async (limit: number) => {
      expect(limit).toBe(100)
      return []
    })
    await playbookBlockedTick({ store: aStore({ waiting }) }, 500)
    expect(waiting).toHaveBeenCalledWith(100)
  })
})
