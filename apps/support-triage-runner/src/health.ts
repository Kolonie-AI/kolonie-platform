import { createServer, type Server } from 'node:http'
import type { RunnerHealth } from './loop.js'

/** The path Docker's healthcheck calls. Unversioned, like the other two runners'. */
export const HEALTH_PATH = '/health'

/**
 * How stale the last completed poll may be before the loop counts as stalled.
 *
 * Three polls' worth of silence, the same multiple the moderation runner uses.
 * At this loop's half-hour interval that is an hour and a half, which is a long
 * time to be wrong about — and shortening it would report an outage during a
 * single slow batch of model calls, which is the more common event by far.
 */
export const STALE_POLLS = 3

export interface HealthReport {
  readonly status: 'ok' | 'stalled'
  readonly reason?: string
  readonly lastPollAt: string | null
  readonly consecutiveFailures: number
}

/**
 * Decide whether the loop is alive, from what it last did.
 *
 * Same reasoning as `apps/moderation-runner/health.ts`, which is worth repeating
 * once rather than referring to: `process.exit(0)` passes for a process whose loop
 * threw on its first poll and has been idle since, and kolonie-infra#11 is the
 * issue for exactly that lie. What is asked here is whether a poll has *completed*
 * recently.
 *
 * Consecutive failures are reported and are not on their own fatal. A backoff is a
 * deliberate response to somebody else's outage, and a runner correctly waiting it
 * out is doing its job. Silence is what is fatal.
 */
export function healthOf(
  health: RunnerHealth,
  staleAfterMs: number,
  at = Date.now(),
): HealthReport {
  const base = {
    lastPollAt: health.lastPollAt,
    consecutiveFailures: health.consecutiveFailures,
  }

  if (!health.running) return { status: 'stalled', reason: 'The loop is not running.', ...base }

  if (health.lastPollAt === null) {
    return { status: 'stalled', reason: 'No poll has completed yet.', ...base }
  }

  const silentFor = at - Date.parse(health.lastPollAt)
  if (silentFor > staleAfterMs) {
    return {
      status: 'stalled',
      reason: `The last poll completed ${Math.round(silentFor / 1000)}s ago.`,
      ...base,
    }
  }

  return { status: 'ok', ...base }
}

export interface QueueReport {
  readonly open: number
  readonly oldestOpenAt: string | null
  /** How long the oldest unanswered ticket has been waiting, in seconds. */
  readonly oldestWaitingSeconds: number | null
}

export function queueReport(
  depth: { readonly open: number; readonly oldestOpenAt: string | null },
  at = Date.now(),
): QueueReport {
  return {
    open: depth.open,
    oldestOpenAt: depth.oldestOpenAt,
    oldestWaitingSeconds:
      depth.oldestOpenAt === null
        ? null
        : Math.max(0, Math.round((at - Date.parse(depth.oldestOpenAt)) / 1000)),
  }
}

export interface HealthServerOptions {
  readonly port: number
  readonly staleAfterMs: number
  readonly health: () => RunnerHealth
  /**
   * How deep the queue is, reported beside the loop's liveness and **never
   * folded into it**.
   *
   * The two answer different questions and only one of them is Docker's business.
   * A loop that ticks happily while the backlog grows is precisely the failure
   * kolonie-platform#105 exists to prevent — and restarting the container would
   * do nothing about it, because the container is fine. Making a deep queue
   * unhealthy would mean a deploy rolls back over a busy week.
   *
   * So it is served, for a human or a monitor to read, and it does not decide the
   * status code.
   */
  readonly depth?: () => Promise<{ readonly open: number; readonly oldestOpenAt: string | null }>
}

/**
 * Serve {@link HEALTH_PATH} and nothing else.
 *
 * No Traefik route reaches this process; the port exists for the container
 * runtime. `0.0.0.0` because inside a container `localhost` is not what a probe
 * from outside the process reaches.
 */
export function createHealthServer(options: HealthServerOptions): Server {
  const server = createServer((request, response) => {
    if (request.url !== HEALTH_PATH) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ status: 'not_found', paths: [HEALTH_PATH] }))
      return
    }

    const report = healthOf(options.health(), options.staleAfterMs)

    const finish = (queue?: QueueReport): void => {
      response.writeHead(report.status === 'ok' ? 200 : 503, {
        'content-type': 'application/json',
      })
      response.end(JSON.stringify({ ...report, ...(queue !== undefined && { queue }) }))
    }

    if (options.depth === undefined) {
      finish()
      return
    }

    // A database that cannot be read is not the loop's liveness, and must not
    // change the answer to it — the report goes out without the queue rather
    // than failing the probe.
    options.depth().then(
      (depth) => finish(queueReport(depth)),
      () => finish(),
    )
  })

  server.listen(options.port, '0.0.0.0')
  return server
}
