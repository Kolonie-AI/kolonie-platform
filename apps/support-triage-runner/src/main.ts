import { createLog } from '@kolonie-ai/core'
import { readFileSync } from 'node:fs'
import {
  createDatabase,
  databaseUrlFromEnv,
  openTickets,
  queueDepth,
  recordTriage,
  resolveFromClosedIssue,
  ticketContext,
  ticketsAwaitingTheirIssue,
  triagedTickets,
  defectIssuesFiledSince,
  recordDefectComment,
  recordDefectIssue,
  recordSeenDefects,
} from '@kolonie-ai/db'
import { startRunner, type Log, type TriageStore } from './loop.js'
import {
  noDefectWriter,
  openRouterDefectWriter,
  openRouterModel,
  unavailableModel,
  OPENROUTER_API_KEY_VAR,
} from './llm.js'
import { APP_ID_VAR, APP_KEY_PATH_VAR, githubIssues, noIssues } from './github.js'
import { LOKI_TOKEN_VAR, LOKI_URL_VAR, LOKI_USER_VAR, lokiLogs, noLogs } from './logs.js'
import type { DefectStore } from './watch.js'
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

// One JSON object per line, on stdout, with `service` set once here (`#230`).
// The three methods that forwarded to `console` printed prose, and
// `console.error(message, error)` printed a stack through Node's inspector —
// one failure, N lines, and nothing able to rejoin them.
const log: Log = createLog({ service: 'support-triage-runner' })

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
        log,
      })

if (apiKey === '') {
  log.warn(
    `${OPENROUTER_API_KEY_VAR} is not set. ` +
      'Tickets will accumulate unread, exactly as they did before this service existed.',
    { event: 'config.missing', variable: OPENROUTER_API_KEY_VAR },
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
    log.warn(
      `${APP_ID_VAR} or ${APP_KEY_PATH_VAR} is not set. ` +
        'Nothing will be triaged: with no App the corpus of open issues is empty, and a ' +
        'ticket the Colony already has an issue for cannot be recognised as one.',
      { event: 'config.missing', variable: `${APP_ID_VAR}/${APP_KEY_PATH_VAR}` },
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
    log.error(`could not read the App key at ${keyPath}; nothing will be filed`, error, {
      event: 'github.key.unreadable',
      keyPath,
    })
    return noIssues
  }
})()

const store: TriageStore = {
  queue: (limit) => openTickets(db, limit),
  context: (ticketId) => ticketContext(db, ticketId),
  answered: (limit) => triagedTickets(db, limit),
  record: (outcome) => recordTriage(db, outcome),
  awaiting: (limit) => ticketsAwaitingTheirIssue(db, limit),
  resolve: (outcome) => resolveFromClosedIssue(db, outcome),
  depth: () => queueDepth(db),
}

/**
 * The log store, or nothing (`#407`).
 *
 * **The same credential the Watch Agent reads with**, not a new one: `#407` is
 * explicit that a second stored credential where a fitting one exists is the
 * wrong trade, and `ARCHITECTURE.md` is deliberately strict about them.
 *
 * Absent means the detector does not run and tickets are triaged exactly as
 * before — which is honest degradation rather than a process that refuses to
 * start and takes its own health endpoint down with it.
 */
const lokiUrl = process.env[LOKI_URL_VAR] ?? ''

/**
 * **The URL alone decides whether the detector runs**, and the token is
 * optional. Loki sits on the same network as this container, so the internal
 * address passes no edge and there is nothing to authenticate to; the token
 * exists for `logs.kolonie.ai`, where Traefik's basicAuth is. Requiring it would
 * make the ordinary configuration look like the missing one.
 */
const logs =
  lokiUrl === ''
    ? noLogs
    : lokiLogs({
        url: lokiUrl,
        user: process.env[LOKI_USER_VAR] ?? 'watch',
        token: process.env[LOKI_TOKEN_VAR] ?? '',
        log,
      })

if (logs === noLogs) {
  log.warn(
    `${LOKI_URL_VAR} is not set. ` +
      'No defect in the logs will become an issue; the Watch Agent’s daily read is all there is.',
    { event: 'config.missing', variable: LOKI_URL_VAR },
  )
}

const defects: DefectStore = {
  seen: (found) => recordSeenDefects(db, found),
  filed: (signature, issueUrl, regression) =>
    recordDefectIssue(db, signature, issueUrl, regression),
  commented: (signature) => recordDefectComment(db, signature),
  filedSince: (since) => defectIssuesFiledSince(db, since),
}

const runner = startRunner(
  {
    store,
    model,
    issues,
    log,
    watch: {
      logs,
      issues,
      store: defects,
      // The prose half, on the key triage already uses. Unavailable is a
      // degradation and not a stop: an issue is complete without a reading.
      writer: apiKey === '' ? noDefectWriter : openRouterDefectWriter(apiKey, { log }),
      log,
    },
  },
  { pollIntervalMs: POLL_INTERVAL_MS },
)

const health = createHealthServer({
  port: HEALTH_PORT,
  staleAfterMs: POLL_INTERVAL_MS * STALE_POLLS,
  health: () => runner.health(),
  // Reported beside the liveness and deliberately not folded into it: a growing
  // backlog is the failure this service exists to prevent and restarting the
  // container would do nothing about it.
  depth: () => store.depth(),
})

log.info(
  `kolonie-support-triage-runner started; polling every ${POLL_INTERVAL_MS}ms, ` +
    `model ${model.name}, health on :${HEALTH_PORT}/health`,
  {
    event: 'service.started',
    pollIntervalMs: POLL_INTERVAL_MS,
    model: model.name,
    healthPort: HEALTH_PORT,
  },
)

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log.info(`${signal} received; finishing the ticket in flight`, {
      event: 'service.stopping',
      signal,
    })
    void runner
      .stop()
      .then(() => new Promise<void>((resolve) => health.close(() => resolve())))
      .then(() => db.close())
      .then(() => process.exit(0))
  })
}
