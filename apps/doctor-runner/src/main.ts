import { createLog } from '@kolonie-ai/core'
import {
  academyProgressFor,
  callHoursSince,
  citizensWithCallsSince,
  createDatabase,
  databaseUrlFromEnv,
  recordDiagnosis,
  resolveDisappeared,
  supersedeOlderPolicies,
  sweepCallHours,
  sweepDiagnoses,
} from '@kolonie-ai/db'
import { startRunner, type DoctorStore, type Log } from './loop.js'
import { createHealthServer, STALE_POLLS } from './health.js'

/**
 * Entry point of the doctor runner (`#839`).
 *
 * Wiring only, like the other three runners: the loop is in `loop.ts`, the
 * decision is in `packages/core/src/doctor`, the SQL is in `packages/db`.
 * Nothing here decides anything, which is why nothing here is tested —
 * everything with behaviour is reachable without starting a process.
 *
 * ## This process holds no GitHub credential, and that is its topology
 *
 * **Two processes each holding a write credential is the outcome to avoid**, and
 * this codebase decided that once already: `#407` routed log-derived defects
 * through the support triage runner rather than giving them a runner of their
 * own, because that runner is the only process with a GitHub App key.
 *
 * So there is no App id here, no key path, no token, and nothing that reads one.
 * `no-credential.test.ts` asserts the absence over this directory rather than
 * leaving it to a reviewer, because the way it would arrive is somebody adding a
 * convenient escalation two years from now — and the whole argument for a fourth
 * runner rests on it not being there.
 *
 * ## What it therefore does not do
 *
 * It records diagnoses and nothing else. **Colony-scoped findings are not
 * escalated to anything from here** — see the comment on `#839` for why the
 * shape the issue assumed is not available, and the follow-up that holds it.
 */

const POLL_INTERVAL_MS = Number(process.env['POLL_INTERVAL_MS'] ?? 3_600_000)
const HEALTH_PORT = Number(process.env['HEALTH_PORT'] ?? 3004)

// One JSON object per line, on stdout, with `service` set once here (`#230`).
const log: Log = createLog({ service: 'doctor-runner' })

// Throws with an explanation if DATABASE_URL is missing (D-009), like every
// other process here.
const db = createDatabase(databaseUrlFromEnv())

const store: DoctorStore = {
  active: (since) => citizensWithCallsSince(db, since),
  callHours: (agentId, since) => callHoursSince(db, agentId, since),
  progress: (agentId) => academyProgressFor(db, agentId),
  /**
   * **Empty, and that is a true answer rather than a missing one.** The Colony
   * has superseded no route today. When it does, this is one of the two places
   * that fact enters the Doctor — the other is `apps/api/src/server.ts`, and the
   * two agreeing is what keeps a citizen's live answer and its stored diagnosis
   * from disagreeing about the same route.
   */
  deprecatedRoutes: async () => ({}),
  record: (finding, policyVersion, now) => recordDiagnosis(db, finding, policyVersion, now),
  resolveDisappeared: (subject, stillFound, now) =>
    resolveDisappeared(db, subject, stillFound, now),
  supersedeOlderPolicies: (policyVersion, now) => supersedeOlderPolicies(db, policyVersion, now),
  /**
   * The two retention windows, run from the pass rather than from a scheduler of
   * their own (`#835`, `#838`).
   *
   * A second process for two deletes would be a container, a health endpoint and
   * a deployment for one statement each — and this pass already runs at exactly
   * the cadence a daily-ish sweep wants.
   */
  sweepCallHours: (now) => sweepCallHours(db, now),
  sweepDiagnoses: (now) => sweepDiagnoses(db, now),
}

const runner = startRunner(
  { store, log, now: () => new Date() },
  { pollIntervalMs: POLL_INTERVAL_MS },
)

const health = createHealthServer({
  port: HEALTH_PORT,
  staleAfterMs: POLL_INTERVAL_MS * STALE_POLLS,
  health: () => runner.health(),
})

log.info(
  `kolonie-doctor-runner started; passing every ${POLL_INTERVAL_MS}ms, ` +
    `health on :${HEALTH_PORT}/health`,
  { event: 'runner.started', pollIntervalMs: POLL_INTERVAL_MS, healthPort: HEALTH_PORT },
)

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log.info(`${signal} received; finishing the pass in flight`, {
      event: 'runner.stopping',
      signal,
    })
    void runner
      .stop()
      .then(() => new Promise<void>((resolve) => health.close(() => resolve())))
      .then(() => db.close())
      .then(() => process.exit(0))
  })
}
