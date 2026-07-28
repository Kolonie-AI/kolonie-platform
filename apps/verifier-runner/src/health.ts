import { createServer, type Server } from 'node:http'
import type { RunnerHealth } from './loop.js'

/** The path Docker's healthcheck calls. Unversioned, like the API's — Docker
 * must not have to track API versions. */
export const HEALTH_PATH = '/health'

/**
 * How stale the last completed poll may be before the loop counts as stalled.
 *
 * A multiple of the poll interval rather than a fixed number, because the two
 * mean the same thing: several polls' worth of silence from a loop that should
 * complete one every interval. Three, so that a single slow verification does
 * not report an outage.
 */
export const STALE_POLLS = 3

export interface HealthReport {
  readonly status: 'ok' | 'stalled'
  /** Why, when it is not ok. Read by a human looking at a container, not by an agent. */
  readonly reason?: string
  readonly lastPollAt: string | null
  readonly consecutiveFailures: number
  readonly inFlight: number
  readonly verifiers: readonly string[]
}

/**
 * Decide whether the loop is alive, from what it last did.
 *
 * **The point of this file is that "the process is up" is not an answer.** The
 * Compose healthcheck for this container used to be `node -e "process.exit(0)"`,
 * which passes for a process whose loop threw on its first poll and has been
 * idle ever since — and kolonie-infra#11 is the issue for exactly that class of
 * lie, discovered when a container sat unhealthy for days while every check
 * reported success. So the question asked here is whether a poll has completed
 * recently, which is the only observation that distinguishes a working loop from
 * a live process wrapped around a dead one.
 *
 * Consecutive failures do not on their own make it unhealthy: the backoff is a
 * deliberate response to an outage elsewhere (a database restart), and a runner
 * that correctly waits it out is doing its job. What is fatal is silence.
 */
export function healthOf(
  health: RunnerHealth,
  staleAfterMs: number,
  at = Date.now(),
): HealthReport {
  const base = {
    lastPollAt: health.lastPollAt,
    consecutiveFailures: health.consecutiveFailures,
    inFlight: health.inFlight,
    verifiers: health.taskTypes.map(String),
  }

  if (!health.running) {
    return { status: 'stalled', reason: 'The loop is not running.', ...base }
  }

  if (health.lastPollAt === null) {
    // Nothing has completed yet. Startup covers this: Compose gives the
    // container a start period before a failing check counts against it.
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

export interface HealthServerOptions {
  readonly port: number
  /** Silence beyond this means stalled. Derived from the loop's poll interval. */
  readonly staleAfterMs: number
  readonly health: () => RunnerHealth
}

/**
 * Serve {@link HEALTH_PATH} and nothing else.
 *
 * The one port this process listens on, and it exists for the container runtime
 * rather than for the internet — there is no Traefik route to this service and
 * no reason for one. `0.0.0.0` because inside a container `localhost` is not
 * what a health probe from outside the process reaches.
 *
 * A stalled loop answers 503 rather than a 200 with a sad body: Compose reads
 * exit codes, not JSON, so a body nobody parses is not a status. The body is
 * there for the human who curls it afterwards to find out what "unhealthy" meant.
 */
export function createHealthServer(options: HealthServerOptions): Server {
  const server = createServer((request, response) => {
    if (request.url !== HEALTH_PATH) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ status: 'not_found', paths: [HEALTH_PATH] }))
      return
    }

    const report = healthOf(options.health(), options.staleAfterMs)
    response.writeHead(report.status === 'ok' ? 200 : 503, { 'content-type': 'application/json' })
    response.end(JSON.stringify(report))
  })

  server.listen(options.port, '0.0.0.0')
  return server
}
