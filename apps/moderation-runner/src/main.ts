import {
  approvedOnTask,
  createDatabase,
  databaseUrlFromEnv,
  pendingGuidance,
  recordModeration,
} from '@kolonie-ai/db'
import { startRunner, type Log, type ModerationStore } from './loop.js'
import { openRouterModel, unavailableModel, OPENROUTER_API_KEY_VAR } from './llm.js'
import { createHealthServer, STALE_POLLS } from './health.js'

/**
 * Entry point of the moderation runner.
 *
 * Wiring only, like `verifier-runner/main.ts`: the loop is in `loop.ts`, the
 * three judgements are in files of their own, the SQL is in `packages/db`.
 * Nothing here decides anything, which is why nothing here is tested —
 * everything with behaviour is reachable without starting a process.
 */

const POLL_INTERVAL_MS = Number(process.env['POLL_INTERVAL_MS'] ?? 60_000)
const HEALTH_PORT = Number(process.env['HEALTH_PORT'] ?? 3002)

const log: Log = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message, error) => console.error(message, error),
}

// Throws with an explanation if DATABASE_URL is missing (D-009), like every
// other process here.
const db = createDatabase(databaseUrlFromEnv())

/**
 * The key, read in exactly one file.
 *
 * **A missing key degrades this process; it does not stop it.** The rule
 * `createVerifiers` follows, and it applies more cleanly here than anywhere: an
 * unconfigured moderator leaves entries `pending`, pending entries are never
 * served, and the read endpoints answer empty arrays. Nothing wrong reaches an
 * agent — the Colony simply publishes nothing until the deploy that supplies the
 * key. Refusing to start would instead take down the health endpoint that is how
 * anyone would find out.
 */
const apiKey = process.env[OPENROUTER_API_KEY_VAR] ?? ''

const model =
  apiKey === ''
    ? unavailableModel(`${OPENROUTER_API_KEY_VAR} not set`)
    : openRouterModel(apiKey, {
        // Configuration rather than a constant, because which model judges is a
        // decision that will be revisited against a real corpus — and the
        // alternative is a code change to try the next one.
        ...(process.env['OPENROUTER_MODEL'] && { model: process.env['OPENROUTER_MODEL'] }),
        ...(process.env['OPENROUTER_EMBEDDING_MODEL'] && {
          embeddingModel: process.env['OPENROUTER_EMBEDDING_MODEL'],
        }),
      })

if (apiKey === '') {
  // Loud on purpose. An unconfigured moderator that said nothing would look
  // exactly like a Colony where nobody has written anything yet.
  console.warn(
    `kolonie-moderation-runner: ${OPENROUTER_API_KEY_VAR} is not set. ` +
      'Nothing will be published; entries will accumulate as pending.',
  )
}

const store: ModerationStore = {
  pending: (limit) => pendingGuidance(db, limit),
  approvedOn: (query) => approvedOnTask(db, query),
  record: (input) => recordModeration(db, input),
}

const runner = startRunner({ store, model, log }, { pollIntervalMs: POLL_INTERVAL_MS })

const health = createHealthServer({
  port: HEALTH_PORT,
  staleAfterMs: POLL_INTERVAL_MS * STALE_POLLS,
  health: () => runner.health(),
})

console.log(
  `kolonie-moderation-runner started; polling every ${POLL_INTERVAL_MS}ms, ` +
    `health on :${HEALTH_PORT}/health`,
)

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`${signal} received; finishing the entry in flight`)
    void runner
      .stop()
      .then(() => new Promise<void>((resolve) => health.close(() => resolve())))
      .then(() => db.close())
      .then(() => process.exit(0))
  })
}
