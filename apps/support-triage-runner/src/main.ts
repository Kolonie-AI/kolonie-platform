import { readFileSync } from 'node:fs'
import {
  createDatabase,
  databaseUrlFromEnv,
  openTickets,
  queueDepth,
  recordTriage,
  resolveFromClosedIssue,
  ticketsAwaitingTheirIssue,
  triagedTickets,
} from '@kolonie-ai/db'
import { startRunner, type Log, type TriageStore } from './loop.js'
import { openRouterModel, unavailableModel, OPENROUTER_API_KEY_VAR } from './llm.js'
import { APP_ID_VAR, APP_KEY_PATH_VAR, githubIssues, noIssues } from './github.js'
import { createHealthServer, STALE_POLLS } from './health.js'

/**
 * Entry point of the support triage runner (#105).
 *
 * Wiring only, like the other two runners: the loop is in `loop.ts`, the decision
 * and its validation are in `triage.ts`, the SQL is in `packages/db`. Nothing here
 * decides anything, which is why nothing here is tested — everything with
 * behaviour is reachable without starting a process.
 */

const POLL_INTERVAL_MS = Number(process.env['POLL_INTERVAL_MS'] ?? 1_800_000)
const HEALTH_PORT = Number(process.env['HEALTH_PORT'] ?? 3003)

const log: Log = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message, error) => console.error(message, error),
}

// Throws with an explanation if DATABASE_URL is missing (D-009), like every other
// process here.
const db = createDatabase(databaseUrlFromEnv())

/**
 * The key, read in exactly one file.
 *
 * A missing key degrades this process; it does not stop it. The rule the
 * moderation runner follows, and it applies the same way: an unconfigured triage
 * runner leaves tickets `open`, which is exactly where they were before this
 * service existed. Refusing to start would take down the health endpoint that is
 * how anyone would find out.
 */
const apiKey = process.env[OPENROUTER_API_KEY_VAR] ?? ''

const model =
  apiKey === ''
    ? unavailableModel(`${OPENROUTER_API_KEY_VAR} not set`)
    : openRouterModel(apiKey, {
        ...(process.env['TRIAGE_MODEL'] && { model: process.env['TRIAGE_MODEL'] }),
      })

if (apiKey === '') {
  console.warn(
    `kolonie-support-triage-runner: ${OPENROUTER_API_KEY_VAR} is not set. ` +
      'Tickets will accumulate unread, exactly as they did before this service existed.',
  )
}

/**
 * The GitHub App, or nothing.
 *
 * Two variables and either both or neither. The key is a *path* rather than the
 * key itself: a PEM is multi-line and a `.env` handles that badly, so
 * kolonie-infra puts it in `/opt/kolonie/secrets/` — the directory Traefik's
 * htpasswd already lives in — and mounts it read-only. See kolonie-infra#55.
 *
 * Read once at startup rather than per call: a key that has been swapped under a
 * running process is a restart, not a hot reload, and re-reading it every tick
 * would turn a deleted file into a silent loss of the ability to file.
 */
const appId = process.env[APP_ID_VAR] ?? ''
const keyPath = process.env[APP_KEY_PATH_VAR] ?? ''

const issues = ((): typeof noIssues => {
  if (appId === '' || keyPath === '') {
    console.warn(
      `kolonie-support-triage-runner: ${APP_ID_VAR} or ${APP_KEY_PATH_VAR} is not set. ` +
        'Nothing will be triaged: with no App the corpus of open issues is empty, and a ' +
        'ticket the Colony already has an issue for cannot be recognised as one.',
    )
    return noIssues
  }

  try {
    const privateKey = readFileSync(keyPath, 'utf8')
    return githubIssues({ appId, privateKey, log })
  } catch (error) {
    // Degrades rather than stops, same as a missing key — but loudly, because a
    // path that is set and unreadable is a mistake somebody made rather than a
    // configuration somebody chose.
    console.error(`could not read the App key at ${keyPath}; nothing will be filed`, error)
    return noIssues
  }
})()

const store: TriageStore = {
  queue: (limit) => openTickets(db, limit),
  answered: (limit) => triagedTickets(db, limit),
  record: (outcome) => recordTriage(db, outcome),
  awaiting: (limit) => ticketsAwaitingTheirIssue(db, limit),
  resolve: (outcome) => resolveFromClosedIssue(db, outcome),
  depth: () => queueDepth(db),
}

const runner = startRunner({ store, model, issues, log }, { pollIntervalMs: POLL_INTERVAL_MS })

const health = createHealthServer({
  port: HEALTH_PORT,
  staleAfterMs: POLL_INTERVAL_MS * STALE_POLLS,
  health: () => runner.health(),
  // Reported beside the liveness and deliberately not folded into it: a growing
  // backlog is the failure this service exists to prevent and restarting the
  // container would do nothing about it.
  depth: () => store.depth(),
})

console.log(
  `kolonie-support-triage-runner started; polling every ${POLL_INTERVAL_MS}ms, ` +
    `model ${model.name}, health on :${HEALTH_PORT}/health`,
)

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`${signal} received; finishing the ticket in flight`)
    void runner
      .stop()
      .then(() => new Promise<void>((resolve) => health.close(() => resolve())))
      .then(() => db.close())
      .then(() => process.exit(0))
  })
}
