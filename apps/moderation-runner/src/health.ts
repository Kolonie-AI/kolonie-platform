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
 * complete one every interval. Three, so that a single slow batch of model
 * calls does not report an outage.
 */
export const STALE_POLLS = 3

export interface HealthReport {
  readonly status: 'ok' | 'stalled'
  /** Why, when it is not ok. Read by a human looking at a container, not by an agent. */
  readonly reason?: string
  readonly lastPollAt: string | null
  /** The last poll the loop entered, completed or not. See {@link healthOf}. */
  readonly lastAttemptAt: string | null
  readonly consecutiveFailures: number
}

/**
 * Decide whether the loop is alive, from what it last did.
 *
 * **The point of this file is that "the process is up" is not an answer.** The
 * Compose healthcheck for this container used to be `node -e "process.exit(0)"`,
 * which passes for a process whose loop threw on its first poll and has been
 * idle ever since — and kolonie-infra#11 is the issue for exactly that class of
 * lie, discovered when a container sat unhealthy for days while every check
 * reported success. It matters more here than there: a stalled moderator
 * publishes nothing, and a Colony where nothing is published looks exactly like
 * a Colony where nobody has written anything. So the question asked here is whether a poll has completed
 * recently, which is the only observation that distinguishes a working loop from
 * a live process wrapped around a dead one.
 *
 * Consecutive failures do not on their own make it unhealthy: the backoff is a
 * deliberate response to an outage elsewhere (a database restart, a model
 * refusing requests), and a runner that correctly waits it out is doing its job. What is fatal is silence.
 *
 * **Which is why the question is asked about attempts and not only completions**
 * (`#1736`). `#1730` made a provider outage in the walk-prose pass reach the
 * runner's backoff; the image built from it was rolled back by run 33104602304,
 * because the container's first poll failed against a 503 gateway, it logged
 * `retryInMs: 120000` exactly as designed, and `lastPollAt` — written only after
 * a poll *completes* — stayed null through the deployment's 180-second window.
 * A loop obeying its backoff and a loop that never started read identically.
 *
 * So a running loop is ok while its most recent **attempt** is inside the
 * staleness budget, and the budget is what keeps this from decaying into *the
 * process is up*: an attempt that is itself too old is stalled however
 * deliberate the waiting was, a loop that has attempted nothing is stalled, and
 * a stopped loop is stalled. The outage stays visible in `consecutiveFailures`
 * and in a `lastPollAt` that does not move.
 */
export function healthOf(
  health: RunnerHealth,
  staleAfterMs: number,
  at = Date.now(),
): HealthReport {
  const base = {
    lastPollAt: health.lastPollAt,
    lastAttemptAt: health.lastAttemptAt,
    consecutiveFailures: health.consecutiveFailures,
  }

  if (!health.running) {
    return { status: 'stalled', reason: 'The loop is not running.', ...base }
  }

  if (health.lastAttemptAt === null) {
    // Nothing has been attempted yet. Startup covers this: Compose gives the
    // container a start period before a failing check counts against it.
    return { status: 'stalled', reason: 'No poll has been attempted yet.', ...base }
  }

  const idleFor = at - Date.parse(health.lastAttemptAt)
  if (idleFor > staleAfterMs) {
    return {
      status: 'stalled',
      reason:
        health.lastPollAt === null
          ? `No poll has completed, and the last attempt was ${Math.round(idleFor / 1000)}s ago.`
          : `The last poll attempt was ${Math.round(idleFor / 1000)}s ago.`,
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
  /**
   * The synthesis loop (#85), which runs in the same process on a slower tick.
   *
   * Optional so that a caller with one loop is not made to describe two, and
   * judged against its **own** interval rather than the moderation one — the
   * briefing tick is deliberately ten times slower, so sharing a staleness budget
   * would report an outage during every gap it is supposed to have.
   *
   * **A stalled synthesis does not make the container unhealthy**, and that is
   * the deliberate half of this. Moderation stopping means nothing is published;
   * synthesis stopping means readers get the last good briefing with its age
   * visible, which is the degradation this feature was designed around. Restarting
   * the container would take moderation down to fix something that is behaving as
   * specified. It is reported so a human can see it, and it is not fatal.
   */
  readonly briefingHealth?: () => RunnerHealth
  readonly briefingStaleAfterMs?: number
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
    const briefing =
      options.briefingHealth === undefined
        ? undefined
        : healthOf(options.briefingHealth(), options.briefingStaleAfterMs ?? options.staleAfterMs)

    // Only the moderation loop decides the status code. See `briefingHealth`.
    response.writeHead(report.status === 'ok' ? 200 : 503, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ...report, ...(briefing !== undefined && { briefing }) }))
  })

  server.listen(options.port, '0.0.0.0')
  return server
}
