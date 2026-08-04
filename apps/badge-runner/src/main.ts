import { createLog } from '@kolonie-ai/core'
import { createDatabase, databaseUrlFromEnv, sweepBadges } from '@kolonie-ai/db'
import { startRunner, type Log, type RunnerHealth } from './loop.js'
import { createHealthServer, STALE_POLLS } from './health.js'

/**
 * Entry point of the badge runner (`#241`).
 *
 * Wiring only, like the other three runners: the loop is in `loop.ts`, the
 * criteria are in `packages/db`. Nothing here decides anything, which is why
 * nothing here is tested — everything with behaviour is reachable without
 * starting a process.
 */

/**
 * Six hours, which is deliberately slow.
 *
 * Nothing waits on a badge. A citizen that qualified an hour ago and hears about
 * it this evening has lost nothing, and the *"that was nice"* this exists for
 * works exactly as well late. Sweeping every minute would put a full pass over
 * the criteria on the database for a feature that counts for nothing — which is
 * the wrong trade in the one direction that is easy to get wrong.
 */
const POLL_INTERVAL_MS = Number(process.env['POLL_INTERVAL_MS'] ?? 21_600_000)
const HEALTH_PORT = Number(process.env['HEALTH_PORT'] ?? 3004)

const log: Log = createLog({ service: 'badge-runner' })

// Throws with an explanation if DATABASE_URL is missing (D-009), like every
// other process here.
const db = createDatabase(databaseUrlFromEnv())

const health: RunnerHealth = { running: false, lastPollAt: null, consecutiveFailures: 0 }

startRunner({ sweep: () => sweepBadges(db) }, log, health, POLL_INTERVAL_MS)

// No queue report: this loop has no backlog to be behind on. It sweeps
// everything every time, so *how far behind* is not a question it can be asked.
createHealthServer({
  port: HEALTH_PORT,
  health: () => health,
  staleAfterMs: POLL_INTERVAL_MS * STALE_POLLS,
}).listen(HEALTH_PORT, () => {
  log.info(`badge-runner health on :${HEALTH_PORT}`, { event: 'runner.started' })
})
