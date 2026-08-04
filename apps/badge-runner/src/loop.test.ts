import { describe, expect, it } from 'vitest'
import { pollOnce, startRunner, type Log, type RunnerHealth, type SweepSpec } from './loop.js'

/**
 * `#241`, `#315`: the loops that sweep on a timer.
 *
 * What is worth asserting here is not that badges are awarded or that escrow is
 * returned — that is `packages/db`, against a real database — but that **this
 * process is honest about whether it is still turning**. A runner that reports
 * healthy while its loop has been dead since the first poll is the failure
 * kolonie-infra#11 exists for, and it is the failure `process.exit(0)` cannot
 * catch.
 */
describe('the sweep loop', () => {
  const silent = (): Log & { errors: () => unknown[]; lines: () => string[] } => {
    const errors: unknown[] = []
    const lines: string[] = []
    return {
      info: (message) => void lines.push(message),
      error: (_m, detail) => void errors.push(detail),
      errors: () => errors,
      lines: () => lines,
    }
  }

  const health = (): RunnerHealth => ({ running: false, lastPollAt: null, consecutiveFailures: 0 })

  /** A spec over a number, so the loop is tested without either real sweep. */
  const counting = (sweep: () => Promise<number>): SweepSpec<number> => ({
    name: 'test',
    sweep,
    empty: -1,
    report: (n) => (n === 0 ? undefined : { message: `swept ${n}`, fields: { n } }),
  })

  it('records a completed poll and reports what it did', async () => {
    const state = health()
    const log = silent()

    expect(
      await pollOnce(
        counting(async () => 3),
        log,
        state,
      ),
    ).toBe(3)
    expect(state.lastPollAt).not.toBeNull()
    expect(state.consecutiveFailures).toBe(0)
    expect(log.lines()).toEqual(['swept 3'])
  })

  /** A pass that did nothing says nothing, on every loop this process runs. */
  it('stays quiet when the pass did nothing', async () => {
    const log = silent()

    await pollOnce(
      counting(async () => 0),
      log,
      health(),
    )

    expect(log.lines()).toEqual([])
  })

  /**
   * **A failed sweep does not throw out of the loop.** It must never be the
   * thing that stops a container — but it must not look healthy either, so the
   * failure is counted, named after its own sweep, and the last completed poll
   * is left where it was.
   */
  it('counts a failure without throwing, and does not claim a poll completed', async () => {
    const state = health()
    const log = silent()

    const result = await pollOnce(
      counting(() => {
        throw new Error('the database went away')
      }),
      log,
      state,
    )

    expect(result).toBe(-1)
    expect(state.lastPollAt).toBeNull()
    expect(state.consecutiveFailures).toBe(1)
    expect(log.errors()).toHaveLength(1)
  })

  it('clears the failure count once a poll gets through', async () => {
    const state: RunnerHealth = { running: true, lastPollAt: null, consecutiveFailures: 4 }

    await pollOnce(
      counting(async () => 0),
      silent(),
      state,
    )

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

    const timer = startRunner(
      counting(async () => (sweeps += 1)),
      silent(),
      state,
      60_000,
    )
    await new Promise((resolve) => setImmediate(resolve))
    clearInterval(timer)

    expect(state.running).toBe(true)
    expect(sweeps).toBe(1)
  })
})
