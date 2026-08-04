import { describe, expect, it } from 'vitest'
import { healthOfLoops, type LoopUnderWatch } from './health.js'
import type { RunnerHealth } from './loop.js'

/**
 * `#315`: this process runs two loops, and the endpoint answers for both.
 *
 * The thing being prevented is a container that probes green because the loop it
 * was named after is fine. A refund sweep that has been dead since the first
 * poll is exactly the failure kolonie-infra#11 was filed for, one loop further
 * in.
 */
describe('the health of a process with two loops', () => {
  const alive = (agoMs: number): RunnerHealth => ({
    running: true,
    lastPollAt: new Date(Date.now() - agoMs).toISOString(),
    consecutiveFailures: 0,
  })

  const loop = (name: string, health: RunnerHealth, staleAfterMs: number): LoopUnderWatch => ({
    name,
    health: () => health,
    staleAfterMs,
  })

  it('is ok when every loop has swept inside its own window', () => {
    const report = healthOfLoops([
      loop('badges', alive(60_000), 3_600_000),
      loop('quest-refunds', alive(60_000), 300_000),
    ])

    expect(report.status).toBe('ok')
    expect(Object.keys(report.loops)).toEqual(['badges', 'quest-refunds'])
  })

  /**
   * **Each loop is asked on its own terms.** A shared window would have to be the
   * slower loop's, and at six hours against fifteen minutes that gives a dead
   * refund sweep most of a day to look healthy.
   */
  it('stalls on the fast loop while the slow one is well inside its window', () => {
    const report = healthOfLoops([
      loop('badges', alive(3_600_000), 64_800_000),
      loop('quest-refunds', alive(3_600_000), 2_700_000),
    ])

    expect(report.status).toBe('stalled')
    expect(report.reason).toContain('quest-refunds')
    expect(report.loops['badges']?.status).toBe('ok')
  })

  it('names every stalled loop, not the first one', () => {
    const dead: RunnerHealth = { running: false, lastPollAt: null, consecutiveFailures: 0 }
    const report = healthOfLoops([loop('badges', dead, 1000), loop('quest-refunds', dead, 1000)])

    expect(report.reason).toContain('badges')
    expect(report.reason).toContain('quest-refunds')
  })
})
