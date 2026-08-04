import type { BadgesAwarded } from '@kolonie-ai/db'

/**
 * The loop that gives out badges (`#241`).
 *
 * **A sweep and not event hooks**, which is the decision this file exists to
 * carry. Ten hooks in ten call sites is ten places to forget the eleventh, and
 * criteria like *a year* or *ten accepted answers* are queries by nature rather
 * than moments — nothing happens on the day a citizen's hundredth day arrives.
 * So the badge that becomes true while nobody is looking is given out anyway,
 * and **adding a badge is a query and a graphic** rather than a change scattered
 * across the codebase.
 *
 * **The sweep is idempotent, which is what lets this be crude.** Every criterion
 * is an `insert … on conflict do nothing`, so a poll that overlaps the previous
 * one, a restart mid-pass, or two containers running at once all award each
 * badge exactly once. There is no cursor to keep, nothing to resume, and a
 * failure costs one interval.
 */

/** What the loop needs from the outside world. */
export interface BadgeSweep {
  sweep(): Promise<BadgesAwarded>
}

/** The narrow log shape, matching the other runners'. */
export interface Log {
  info(message: string, fields?: Record<string, unknown>): void
  error(message: string, detail?: unknown, fields?: Record<string, unknown>): void
}

/** What the health server reports on, so a stalled loop cannot look alive. */
export interface RunnerHealth {
  /** False until `startRunner` has been called, so a dead process cannot look idle. */
  running: boolean
  lastPollAt: string | null
  consecutiveFailures: number
}

/**
 * Run one pass, and say what it gave out.
 *
 * Separated from the timer so it is reachable in a test without starting a
 * process — the same arrangement the other three runners use.
 */
export async function pollOnce(
  sweep: BadgeSweep,
  log: Log,
  health: RunnerHealth,
): Promise<BadgesAwarded> {
  try {
    const awarded = await sweep.sweep()

    health.lastPollAt = new Date().toISOString()
    health.consecutiveFailures = 0

    // Quiet when nothing was given out, which is most passes once the population
    // has caught up. A line per empty sweep is a log nobody reads.
    if (Object.keys(awarded).length > 0) {
      log.info('badges awarded', { event: 'badges.awarded', awarded })
    }

    return awarded
  } catch (thrown) {
    health.consecutiveFailures += 1
    log.error('badge sweep failed', thrown, { event: 'badges.sweep.failed' })
    return {}
  }
}

/**
 * Poll forever.
 *
 * **It never throws out of the loop**, because a badge sweep is the least
 * important process the Colony runs and must not be the one that pages anybody.
 * `pollOnce` swallows its own failure and the count of consecutive ones is what
 * the health endpoint reports.
 */
export function startRunner(
  sweep: BadgeSweep,
  log: Log,
  health: RunnerHealth,
  intervalMs: number,
): NodeJS.Timeout {
  health.running = true
  void pollOnce(sweep, log, health)
  const timer = setInterval(() => void pollOnce(sweep, log, health), intervalMs)
  timer.unref?.()
  return timer
}
