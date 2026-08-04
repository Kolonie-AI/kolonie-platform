import { describe, expect, it } from 'vitest'
import { pollOnce, startRunner, type Log, type RunnerHealth } from './loop.js'

/**
 * `#241`: the loop that gives out things worth nothing.
 *
 * What is worth asserting here is not that badges are awarded — that is
 * `packages/db`, against a real database — but that **this process is honest
 * about whether it is still turning**. A runner that reports healthy while its
 * loop has been dead since the first poll is the failure kolonie-infra#11 exists
 * for, and it is the failure `process.exit(0)` cannot catch.
 */
describe('the badge sweep loop', () => {
  const silent = (): Log & { errors: () => unknown[] } => {
    const errors: unknown[] = []
    return { info: () => {}, error: (_m, detail) => void errors.push(detail), errors: () => errors }
  }

  const health = (): RunnerHealth => ({ running: false, lastPollAt: null, consecutiveFailures: 0 })

  it('records a completed poll and what it gave out', async () => {
    const state = health()

    const awarded = await pollOnce({ sweep: async () => ({ 'first-light': 3 }) }, silent(), state)

    expect(awarded).toEqual({ 'first-light': 3 })
    expect(state.lastPollAt).not.toBeNull()
    expect(state.consecutiveFailures).toBe(0)
  })

  /**
   * **A failed sweep does not throw out of the loop.** A badge sweep is the
   * least important process the Colony runs and must never be the one that stops
   * a container — but it must not look healthy either, so the failure is counted
   * and the last completed poll is left where it was.
   */
  it('counts a failure without throwing, and does not claim a poll completed', async () => {
    const state = health()
    const log = silent()

    const awarded = await pollOnce(
      {
        sweep: () => {
          throw new Error('the database went away')
        },
      },
      log,
      state,
    )

    expect(awarded).toEqual({})
    expect(state.lastPollAt).toBeNull()
    expect(state.consecutiveFailures).toBe(1)
    expect(log.errors()).toHaveLength(1)
  })

  it('clears the failure count once a poll gets through', async () => {
    const state: RunnerHealth = { running: true, lastPollAt: null, consecutiveFailures: 4 }

    await pollOnce({ sweep: async () => ({}) }, silent(), state)

    expect(state.consecutiveFailures).toBe(0)
  })

  /**
   * The loop is running from the moment it is started, and it sweeps once
   * immediately — a runner that waited a full interval before its first pass
   * would spend six hours indistinguishable from one that never started.
   */
  it('is running and has swept before the first interval elapses', async () => {
    const state = health()
    let sweeps = 0

    const timer = startRunner({ sweep: async () => ((sweeps += 1), {}) }, silent(), state, 60_000)
    await new Promise((resolve) => setImmediate(resolve))
    clearInterval(timer)

    expect(state.running).toBe(true)
    expect(sweeps).toBe(1)
  })
})
