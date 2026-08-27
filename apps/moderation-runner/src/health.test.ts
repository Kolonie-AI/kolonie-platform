import { describe, expect, it } from 'vitest'
import { healthOf, STALE_POLLS } from './health.js'
import type { RunnerHealth } from './loop.js'

/**
 * What the deployment asks this file, and what it used to answer wrongly.
 *
 * `#1730` gave the walk-prose pass a provider outage that reaches the runner's
 * exponential poll backoff. The image built from it was rolled back by
 * [run 33104602304](https://github.com/Kolonie-AI/kolonie-platform/actions/runs/33104602304):
 * the container started at 18:42:45, its first poll found the gateway on 503 and
 * the fallback unreachable, and it logged `poll.failed` with `retryInMs: 120000`
 * — the new behaviour working. `/health` answered 503 for the whole 180-second
 * window anyway, because `lastPollAt` is written only after a poll *completes*
 * and `healthOf` read null as *nothing has run*.
 *
 * So a loop that is doing exactly what it was told to do was indistinguishable
 * from a loop that never started, and the two have to be told apart without
 * softening this file into a process-liveness check — which is the lie
 * `kolonie-infra#11` was filed for and this file's own header refuses.
 */
const POLL_INTERVAL_MS = 60_000
const STALE_AFTER_MS = POLL_INTERVAL_MS * STALE_POLLS
const AT = Date.parse('2026-07-28T12:00:00.000Z')

const health = (overrides: Partial<RunnerHealth> = {}): RunnerHealth => ({
  running: true,
  lastPollAt: '2026-07-28T11:59:55.000Z',
  lastAttemptAt: '2026-07-28T11:59:55.000Z',
  consecutiveFailures: 0,
  ...overrides,
})

describe('healthOf', () => {
  it('is ok while polls are completing', () => {
    expect(healthOf(health(), STALE_AFTER_MS, AT).status).toBe('ok')
  })

  /**
   * The deployment case, in the shape run 33104602304 produced it: the loop is
   * running, it has attempted a poll, that poll failed, and it is now waiting out
   * the 120 seconds the backoff asked for. No poll has ever completed.
   */
  it('is ok during the backoff after a first poll that failed', () => {
    const report = healthOf(
      health({
        lastPollAt: null,
        lastAttemptAt: new Date(AT - 30_000).toISOString(),
        consecutiveFailures: 1,
      }),
      STALE_AFTER_MS,
      AT,
    )

    expect(report.status).toBe('ok')
    /** The outage is reported rather than hidden — it is what a reader needs. */
    expect(report.consecutiveFailures).toBe(1)
    expect(report.lastPollAt).toBeNull()
  })

  /**
   * The rejection case that keeps the paragraph above honest. Process liveness
   * is not health: a loop that is up and has attempted nothing answers 503, and
   * Compose's start period is what covers an ordinary startup.
   */
  it('is stalled while the loop has never attempted a poll', () => {
    const report = healthOf(health({ lastPollAt: null, lastAttemptAt: null }), STALE_AFTER_MS, AT)

    expect(report.status).toBe('stalled')
    expect(report.reason).toContain('No poll')
  })

  /**
   * Backoff buys activity, not silence. A loop whose most recent attempt is
   * older than the staleness budget is stalled however deliberate its waiting
   * was — which is what stops this from becoming *the process is up*.
   */
  it('is stalled when even the last attempt is older than the budget', () => {
    const report = healthOf(
      health({
        lastPollAt: null,
        lastAttemptAt: new Date(AT - STALE_AFTER_MS - 1_000).toISOString(),
        consecutiveFailures: 9,
      }),
      STALE_AFTER_MS,
      AT,
    )

    expect(report.status).toBe('stalled')
  })

  it('is stalled when the last completed poll is too old', () => {
    const stale = new Date(AT - STALE_AFTER_MS - 1_000).toISOString()
    const report = healthOf(health({ lastPollAt: stale, lastAttemptAt: stale }), STALE_AFTER_MS, AT)

    expect(report.status).toBe('stalled')
  })

  it('is stalled when the loop is not running', () => {
    expect(healthOf(health({ running: false }), STALE_AFTER_MS, AT).status).toBe('stalled')
  })

  /**
   * A stopped loop is stalled even mid-backoff: `stop()` is the one state where
   * a fresh attempt says nothing about whether work will continue.
   */
  it('is stalled when a stopped loop was recently attempting', () => {
    const report = healthOf(
      health({
        running: false,
        lastPollAt: null,
        lastAttemptAt: new Date(AT - 1_000).toISOString(),
        consecutiveFailures: 2,
      }),
      STALE_AFTER_MS,
      AT,
    )

    expect(report.status).toBe('stalled')
  })

  it('keeps both diagnostic fields on every answer', () => {
    const report = healthOf(health({ consecutiveFailures: 4 }), STALE_AFTER_MS, AT)

    expect(report.consecutiveFailures).toBe(4)
    expect(report.lastPollAt).toBe('2026-07-28T11:59:55.000Z')
  })
})
