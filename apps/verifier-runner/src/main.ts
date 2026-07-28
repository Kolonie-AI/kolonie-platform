import {
  citizenForGithubAuthor,
  createDatabase,
  databaseUrlFromEnv,
  hasClearedGate,
} from '@kolonie-ai/db'
import { createVerifiers, GITHUB_VERIFIER_TOKEN_VAR, httpGitHubReader } from '@kolonie-ai/verifiers'
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

/**
 * The one place the Colony's verifiers are assembled with what they read the
 * world through.
 *
 * The GitHub token is read-only and belongs to the Colony, never to an agent
 * (D-019). It is read here rather than inside `packages/verifiers` so that the
 * package stays testable without an environment and so that the credential is
 * named in exactly one file — this one. A runner started without it still
 * starts: `httpGitHubReader` answers `unavailable`, which becomes a `pending`
 * verdict, and the submissions wait for the deploy that supplies it rather than
 * being failed for a misconfiguration that is ours.
 *
 * `citizenForGithubAuthor` is the only reason this app knows about the database
 * on the verifiers' behalf. A verifier that could query storage itself would be
 * one refactor away from writing to it, which is the boundary `AGENTS.md` §3
 * draws — so the query lives in `packages/db` and arrives here as a function.
 */
const verifiers = createVerifiers({
  github: httpGitHubReader(process.env[GITHUB_VERIFIER_TOKEN_VAR]),
  authors: { citizenFor: (login) => citizenForGithubAuthor(db, login) },
  // Needs no credential of its own: the gate was already checked against
  // hCaptcha by the API, and this only reads what that recorded (D-024).
  gates: { clearedAt: (agentId) => hasClearedGate(db, agentId) },
})

const runner = startRunner(
  { queue: databaseQueue(db), verifiers, log },
  { pollIntervalMs: POLL_INTERVAL_MS },
)

const health = createHealthServer({
  port: HEALTH_PORT,
  staleAfterMs: POLL_INTERVAL_MS * STALE_POLLS,
  health: () => runner.health(),
})

const deployed = [...verifiers.keys()].join(', ') || 'none'
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
