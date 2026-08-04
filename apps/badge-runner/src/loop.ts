/**
 * The sweeps this process runs on a timer.
 *
 * **A sweep and not event hooks**, which is the decision this file exists to
 * carry. Ten hooks in ten call sites is ten places to forget the eleventh, and
 * criteria like *a year* or *ten accepted answers* are queries by nature rather
 * than moments — nothing happens on the day a citizen's hundredth day arrives.
 * So the badge that becomes true while nobody is looking is given out anyway,
 * and **adding a badge is a query and a graphic** rather than a change scattered
 * across the codebase.
 *
 * **The sweeps are idempotent, which is what lets this be crude.** Every badge
 * criterion is an `insert … on conflict do nothing`, and a refund reads an
 * escrow that has already been returned and books nothing — so a poll that
 * overlaps the previous one, a restart mid-pass, or two containers running at
 * once all do each piece of work exactly once. There is no cursor to keep,
 * nothing to resume, and a failure costs one interval.
 *
 * **Two sweeps, two timers, one process (`#315`).** Refunding an expired quest
 * is the same *shape* of work as awarding a badge — something that becomes true
 * on a date nobody is watching — and this is the only process the Colony has
 * built around that shape. It is emphatically not the same *importance*, which
 * is why each sweep keeps its own interval and its own health record: badges may
 * be six hours late and a sponsor's money may not, and one shared tick would
 * have meant choosing which of the two to be wrong about.
 */

/** What a sweep needs to be run on a timer and reported on honestly. */
export interface SweepSpec<T> {
  /** Named in the log line and in the health report, so two loops are tellable apart. */
  readonly name: string
  sweep(): Promise<T>
  /**
   * What this pass is worth saying, or `undefined` for silence.
   *
   * Quiet when nothing happened, which is most passes once the population has
   * caught up. A line per empty sweep is a log nobody reads — and `#230` made
   * these logs queryable, which raises the cost of noise rather than lowering it.
   */
  report(
    result: T,
  ): { readonly message: string; readonly fields: Record<string, unknown> } | undefined
  /** What a failed pass returns, so no caller has to handle `undefined`. */
  readonly empty: T
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
 * Run one pass, and say what it did.
 *
 * Separated from the timer so it is reachable in a test without starting a
 * process — the same arrangement the other three runners use.
 */
export async function pollOnce<T>(spec: SweepSpec<T>, log: Log, health: RunnerHealth): Promise<T> {
  try {
    const result = await spec.sweep()

    health.lastPollAt = new Date().toISOString()
    health.consecutiveFailures = 0

    const line = spec.report(result)
    if (line !== undefined) log.info(line.message, line.fields)

    return result
  } catch (thrown) {
    health.consecutiveFailures += 1
    log.error(`${spec.name} sweep failed`, thrown, { event: `${spec.name}.sweep.failed` })
    return spec.empty
  }
}

/**
 * Poll forever.
 *
 * **It never throws out of the loop.** `pollOnce` swallows its own failure and
 * the count of consecutive ones is what the health endpoint reports, so a
 * database that went away slows this process down instead of taking the
 * container with it. That was first argued for badges, which must not be the
 * thing that pages anybody. It holds for the refund sweep for the opposite
 * reason: a refund that failed is a sponsor's money still sitting in escrow, and
 * the way anybody finds out is a health endpoint that keeps answering.
 */
export function startRunner<T>(
  spec: SweepSpec<T>,
  log: Log,
  health: RunnerHealth,
  intervalMs: number,
): NodeJS.Timeout {
  health.running = true
  void pollOnce(spec, log, health)
  const timer = setInterval(() => void pollOnce(spec, log, health), intervalMs)
  timer.unref?.()
  return timer
}
