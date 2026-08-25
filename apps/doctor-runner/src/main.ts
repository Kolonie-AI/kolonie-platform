import {
  GATEWAY_API_KEY_VARS,
  GATEWAY_MODEL_VARS,
  createLog,
  gatewayFromEnvironment,
  maxTokensFromEnvironment,
} from '@kolonie-ai/core'
import {
  academyProgressFor,
  applyThrottle,
  attachProse,
  callHoursSince,
  citizensWithCallsSince,
  createDatabase,
  databaseUrlFromEnv,
  openDiagnosesFor,
  openThrottleNotice,
  recordDiagnosis,
  resolveDisappeared,
  supersedeOlderPolicies,
  sweepCallHours,
  sweepDiagnoses,
  sweepThrottles,
  throttleHistoryFor,
} from '@kolonie-ai/db'
import { startRunner, type DoctorStore, type Log } from './loop.js'
import { createHealthServer, STALE_POLLS } from './health.js'
import { gatewayProse, noProse } from './prose.js'

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
  /**
   * The store's own answer, narrowed to what the pass needs (`#840`).
   *
   * `RecordedDiagnosis` carries the whole row; the pass is handed the outcome,
   * the id and whether a sentence is already there. Narrowing here rather than
   * widening `DoctorStore` keeps the prose step unable to read a stored evidence
   * blob, which is the property `#838` refuses free text to protect.
   */
  record: async (finding, policyVersion, now) => {
    const written = await recordDiagnosis(db, finding, policyVersion, now)
    return {
      outcome: written.outcome,
      refusal: written.refusal,
      diagnosisId: written.diagnosis?.id ?? null,
      hasProse: written.diagnosis?.prose !== null && written.diagnosis?.prose !== undefined,
    }
  },
  attachProse: (diagnosisId, prose, proseModel) => attachProse(db, diagnosisId, prose, proseModel),
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
  sweepThrottles: (now) => sweepThrottles(db, now),
  openDiagnoses: (subject) => openDiagnosesFor(db, subject),
  throttleHistory: (diagnosisId, now) => throttleHistoryFor(db, diagnosisId, now),
  applyThrottle: async (plan) => {
    const written = await applyThrottle(db, plan)
    return {
      outcome: written.outcome,
      throttle: written.outcome === 'applied' ? written.throttle : null,
    }
  },
  /**
   * **The outcome is dropped here, and that is the wiring rather than a
   * swallow.** `openThrottleNotice` answers `already-sent` when a previous pass
   * told the citizen about this throttle and `no-such-throttle` when the row is
   * gone — a resolved diagnosis takes its throttle with it, and a pass may lose
   * that race. Neither is a fault, neither is actionable, and the pass has
   * already logged the thing that matters: that a citizen was narrowed.
   */
  noticeThrottle: async (notice) => {
    await openThrottleNotice(db, notice)
  },
}

/**
 * Who writes the sentences, or nobody (`#840`).
 *
 * **The gateway and nothing else.** `gatewayFromEnvironment` answers `undefined`
 * unless the base URL, this service's key and a model are all set — so the
 * ordinary state of a deployment that has not configured one is no prose at all,
 * with every diagnosis stored complete and silent.
 *
 * **No model name in this file and none in any other** (`#207`): the slug arrives
 * in `LLM_GATEWAY_MODEL_DOCTOR`, is written onto the diagnosis row for audit, and
 * appears nowhere in the repository.
 */
const gateway = gatewayFromEnvironment('doctor')
const prose =
  gateway === undefined
    ? noProse
    : gatewayProse(gateway, {
        log,
        // The operator's ceiling, or nothing — the ordinary state (`#1694`).
        ...(maxTokensFromEnvironment('doctor') !== undefined && {
          maxTokens: maxTokensFromEnvironment('doctor'),
        }),
      })

if (!prose.available) {
  log.warn(
    `${GATEWAY_API_KEY_VARS.doctor} or ${GATEWAY_MODEL_VARS.doctor} is not set. ` +
      'Diagnoses will be stored with no sentence, which every surface treats as complete.',
    { event: 'config.missing', variable: GATEWAY_API_KEY_VARS.doctor },
  )
}

/**
 * Whether this deployment lets the Doctor narrow anybody (`#843`).
 *
 * **Off unless the variable says exactly `true`.** Every other setting in this
 * file has a working default; this one does not, because it is the first thing
 * the Colony has ever built that takes something away from a citizen. A
 * deployment runs the pass observing, reads `throttlesWithheld` on the pass line
 * to see what the guard would have done, and turns it on when that number is one
 * it recognises.
 */
const THROTTLING = process.env['DOCTOR_THROTTLING'] === 'true'

if (!THROTTLING) {
  log.info(
    'DOCTOR_THROTTLING is not "true". Findings are recorded and citizens are told, and ' +
      'nothing is limited; the pass reports what it would have limited as throttlesWithheld.',
    { event: 'config.default', variable: 'DOCTOR_THROTTLING' },
  )
}

const runner = startRunner(
  { store, prose, log, throttling: THROTTLING, now: () => new Date() },
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
