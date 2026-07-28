import { createDatabase, databaseUrlFromEnv } from '@kolonie-ai/db'
import { VERIFIERS } from '@kolonie-ai/verifiers'
import { createHealthServer, STALE_POLLS } from './health.js'
import { startRunner, type Log } from './loop.js'
import { databaseQueue } from './queue.js'

/**
 * Entry point of the verifier runner.
 *
 * Wiring only: the loop is in `loop.ts`, the decision in `runner.ts`, the SQL in
 * `packages/db`. Nothing here decides anything, which is why nothing here is
 * tested — everything with behaviour is reachable without starting a process.
 */

const POLL_INTERVAL_MS = Number(process.env['POLL_INTERVAL_MS'] ?? 5_000)
const HEALTH_PORT = Number(process.env['HEALTH_PORT'] ?? 3001)

const log: Log = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message, error) => console.error(message, error),
}

// Throws with an explanation if DATABASE_URL is missing (D-009). Failing at
// startup is the point: a runner that cannot reach its database has not
// degraded, and a submission nobody verifies is invisible until an agent
// complains that its verdict never arrived.
const db = createDatabase(databaseUrlFromEnv())

const runner = startRunner({ queue: databaseQueue(db), log }, { pollIntervalMs: POLL_INTERVAL_MS })

const health = createHealthServer({
  port: HEALTH_PORT,
  staleAfterMs: POLL_INTERVAL_MS * STALE_POLLS,
  health: () => runner.health(),
})

const deployed = [...VERIFIERS.keys()].join(', ') || 'none'
console.log(`kolonie-verifier-runner started. Verifiers deployed: ${deployed}`)
console.log(`polling every ${POLL_INTERVAL_MS}ms; health on :${HEALTH_PORT}/health`)

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`${signal} received; finishing the submission in flight`)
    void runner
      // Resolves once the verification in flight has been written. A submission
      // is lost only if the runtime kills the process before this returns, and
      // the timeout sweep is what reclaims it when that happens.
      .stop()
      .then(() => new Promise<void>((resolve) => health.close(() => resolve())))
      .then(() => db.close())
      .then(() => process.exit(0))
  })
}
