import {
  CALL_HOUR_MS,
  DOCTOR_POLICY_VERSION,
  DOCTOR_WINDOW_HOURS,
  UNDIAGNOSED_ROUTE_KEYS,
  diagnose,
  diagnoseColony,
  silentLog,
  type AcademyProgress,
  type AgentId,
  type CallHour,
  type DoctorInput,
  type Finding,
  type Log,
} from '@kolonie-ai/core'
import { noProse, type ProseWriter } from './prose.js'

export type { Log }

/**
 * What one pass reads and writes. Mirrors the functions in `packages/db` without
 * importing them.
 *
 * **There is no method here that reaches GitHub**, and that is the topology this
 * runner exists to keep rather than an omission. See `main.ts`.
 */
export interface DoctorStore {
  /** Every citizen that made a call in the window — the pass's whole work list. */
  active(since: Date): Promise<readonly AgentId[]>
  /** One citizen's own rollup rows since a moment. */
  callHours(agentId: AgentId, since: Date): Promise<readonly CallHour[]>
  /** Where one citizen stands, or `null` if it no longer exists. */
  progress(agentId: AgentId): Promise<AcademyProgress | null>
  /** Which routes the Colony has superseded, and what replaced each. */
  deprecatedRoutes(): Promise<Readonly<Record<string, string>>>
  /** Store a finding, or update the open diagnosis it matches. */
  record(finding: Finding, policyVersion: string, now: Date): Promise<DiagnosisRecorded>
  /** Close every open diagnosis about a subject this pass did not find again. */
  resolveDisappeared(
    subject: string,
    stillFound: readonly Finding['kind'][],
    now: Date,
  ): Promise<number>
  /** Mark every open diagnosis made under older rules as superseded. */
  supersedeOlderPolicies(policyVersion: string, now: Date): Promise<number>
  /** Delete rollup buckets past their retention window. */
  sweepCallHours(now: Date): Promise<number>
  /** Delete resolved agent-scoped diagnoses past theirs. */
  sweepDiagnoses(now: Date): Promise<number>
  /**
   * Attach a model's sentence to a diagnosis (`#840`).
   *
   * **The only write on this interface a model's output ever reaches**, and it
   * reaches one column. Nothing parses it back into a structured field, which is
   * what *the model only writes* means when it is a property of an interface
   * rather than a sentence in a comment.
   */
  attachProse(diagnosisId: string, prose: string, proseModel: string): Promise<void>
}

/** What `record` said it did. Mirrors `RecordedDiagnosis` without importing it. */
export interface DiagnosisRecorded {
  readonly outcome: 'opened' | 'observed' | 'escalated' | 'refused'
  readonly refusal: string | null
  /**
   * The row it wrote, where there is one (`#840`).
   *
   * Needed so a sentence can be attached to the diagnosis this pass just opened.
   * It carries the id and whether one is already there, and nothing else about
   * the stored row — the prose step is allowed to know a finding's identity and
   * no more.
   */
  readonly diagnosisId: string | null
  /** Whether it already carries a sentence. `#840` does not rewrite one. */
  readonly hasProse: boolean
}

export interface PassOutcome {
  /** Citizens looked at. */
  readonly citizens: number
  /** Diagnoses opened for the first time. */
  readonly opened: number
  /** Open diagnoses found again. */
  readonly observed: number
  /** Open diagnoses whose severity moved. */
  readonly escalated: number
  /** Diagnoses closed because their evidence stopped matching. */
  readonly resolved: number
  /** Findings the store refused, with the reasons. */
  readonly refused: readonly string[]
  /** Citizens whose diagnosis threw. One bad row does not cost the Colony its hour. */
  readonly failed: number
  /** Rollup buckets and diagnoses swept. */
  readonly swept: { readonly callHours: number; readonly diagnoses: number }
  /**
   * Sentences asked for and sentences written (`#840`).
   *
   * Two numbers rather than one, because the gap between them is the only thing
   * that says the gateway is having a bad day — a pass that asked for eleven and
   * wrote none is a Colony whose findings are all complete and all silent, which
   * looks identical to a Colony that wired no gateway unless somebody counted.
   */
  readonly prose: { readonly asked: number; readonly written: number }
}

export interface PassDependencies {
  readonly store: DoctorStore
  /**
   * Who writes the sentences (`#840`).
   *
   * **Optional, and `noProse` is the ordinary state.** A deployment that wired
   * no gateway stores every diagnosis complete and silent, which is the shape
   * `#838` gave the columns and `#837` gave the answer — prose is nullable
   * everywhere and its absence is never a half-written anything.
   */
  readonly prose?: ProseWriter
  readonly log?: Log
  /**
   * The moment the pass is being made at.
   *
   * An argument for the reason every clock in this set is one: a pass over a
   * fixed window has to be testable against a fixture rather than against the
   * wall clock, and idempotence is a property of *the same pass run twice*,
   * which is not expressible if the pass invents its own now.
   */
  readonly now: () => Date
}

/**
 * One pass of the Doctor over the whole Colony (`#839`).
 *
 * **The decision is not here.** The rules are `packages/core/src/doctor`, the SQL
 * is `packages/db`, and what this file holds is the order the two are called in
 * and what happens when one of them fails — which is the shape the three existing
 * runners already have and the reason `main.ts` beside it is wiring with nothing
 * to test.
 *
 * **A pass that throws on one citizen completes for the rest.** Every citizen is
 * its own try, and the failures are counted rather than raised: one bad row must
 * not cost the Colony its hour, and a pass that stopped at the first exception
 * would fail most often on exactly the citizen whose behaviour is unusual — which
 * is the one this exists to look at.
 *
 * **Idempotent by construction.** Running it twice over the same window leaves
 * the same diagnoses in the same states: `record` deduplicates on the diagnosis
 * row inside Postgres, and `resolveDisappeared` closes by comparison with what
 * this pass found rather than by anything remembered between passes. Nothing here
 * holds state across ticks, and that is deliberate — a runner that restarted and
 * forgot something would be a runner whose dedupe could be defeated by a restart.
 *
 * **It writes no citizen-visible state other than diagnoses.** It grants nothing,
 * revokes nothing, moves no reputation and touches no standing. `#843` is the one
 * issue in this set that would change anything for a citizen, it is not built,
 * and when it is it may act only from a stored diagnosis and only after the
 * citizen was told.
 */
export async function runPass(deps: PassDependencies): Promise<PassOutcome> {
  const { store } = deps
  const log = deps.log ?? silentLog
  const now = deps.now()
  const since = new Date(now.getTime() - DOCTOR_WINDOW_HOURS * CALL_HOUR_MS)

  /**
   * Anything decided under different arithmetic is superseded before this pass
   * writes anything (`#838`).
   *
   * First rather than last, so that a rule change and the pass that first runs
   * under it are one act: the old verdicts close and the new ones open in the
   * same hour, and there is no window in which both are open and a reader has to
   * decide which is current.
   */
  const superseded = await store.supersedeOlderPolicies(DOCTOR_POLICY_VERSION, now)
  if (superseded > 0) {
    log.info(`superseded ${superseded} diagnoses made under older rules`, {
      event: 'doctor.policy.superseded',
      superseded,
      policyVersion: DOCTOR_POLICY_VERSION,
    })
  }

  const deprecatedRoutes = await store.deprecatedRoutes()
  const citizens = await store.active(since)

  const counts = { opened: 0, observed: 0, escalated: 0, resolved: 0, failed: 0 }
  const refused: string[] = []
  const inputs: DoctorInput[] = []
  const prose = deps.prose ?? noProse
  const sentences = { asked: 0, written: 0 }

  /**
   * Ask for a sentence, once per diagnosis rather than once per pass (`#840`).
   *
   * **`opened` and `escalated`, and never `observed`.** A re-evaluation that only
   * moved `last_seen_at` has changed nothing a reader's view of the finding
   * depends on, and rewriting the sentence for it would cost a model call every
   * hour for as long as the diagnosis stays open. A severity change is different:
   * the sentence said *concern* and the finding now says *serious*.
   *
   * **And never over a sentence that is already there**, which is what stops a
   * pass from re-describing a finding whose severity has not moved.
   *
   * Awaited rather than left dangling: this is a runner, not a request path, and
   * a pass that ended while its writes were still in flight would report counts
   * it had not finished earning.
   */
  const describe = async (written: DiagnosisRecorded, finding: Finding): Promise<void> => {
    if (!prose.available || written.diagnosisId === null) return
    if (written.outcome !== 'opened' && written.outcome !== 'escalated') return
    if (written.hasProse && written.outcome !== 'escalated') return

    sentences.asked += 1
    const sentence = await prose.describe(finding)
    if (sentence === null) return

    await store.attachProse(written.diagnosisId, sentence, prose.model)
    sentences.written += 1
  }

  for (const agentId of citizens) {
    try {
      const progress = await store.progress(agentId)
      // Erased between the listing and this read. Nothing to diagnose and
      // nothing to record — a diagnosis about a row nobody owns is a verdict
      // about somebody who is not here.
      if (progress === null) continue

      const hours = await store.callHours(agentId, since)
      const input: DoctorInput = {
        subject: agentId,
        now,
        // The same exclusion `kolonie.doctor` makes, and it has to be the same
        // one: a citizen told by the live surface that nothing is wrong and by a
        // stored diagnosis that it is looping would have been told two things by
        // one Colony.
        hours: hours.filter((hour) => !UNDIAGNOSED_ROUTE_KEYS.includes(hour.routeKey)),
        progress,
        deprecatedRoutes,
      }
      inputs.push(input)

      const findings = diagnose(input)
      for (const finding of findings) {
        const written = await store.record(finding, DOCTOR_POLICY_VERSION, now)
        if (written.outcome === 'refused') refused.push(written.refusal ?? 'refused')
        else counts[written.outcome] += 1
        await describe(written, finding)
      }

      counts.resolved += await store.resolveDisappeared(
        agentId,
        findings.filter((finding) => finding.scope === 'agent').map((finding) => finding.kind),
        now,
      )
    } catch (thrown) {
      counts.failed += 1
      // The citizen is named because a pass that failed on one row is only
      // actionable if somebody can go and look at that row.
      log.error('diagnosing one citizen threw; the pass continues', thrown, {
        event: 'doctor.citizen.threw',
        agentId,
      })
    }
  }

  /**
   * What the Colony can only see by looking at everybody at once (`#836`).
   *
   * After the per-citizen loop and over the inputs it assembled, so the rows are
   * read once. `diagnoseColony` names no citizen in what it returns, which is
   * what makes this safe to compute from every citizen's data at the same time.
   */
  for (const finding of diagnoseColony(inputs)) {
    const written = await store.record(finding, DOCTOR_POLICY_VERSION, now)
    if (written.outcome === 'refused') refused.push(written.refusal ?? 'refused')
    else counts[written.outcome] += 1
    await describe(written, finding)
  }

  const swept = {
    callHours: await store.sweepCallHours(now),
    diagnoses: await store.sweepDiagnoses(now),
  }

  return { citizens: citizens.length, ...counts, refused, swept, prose: sentences }
}

export interface RunnerHealth {
  readonly running: boolean
  readonly lastPollAt: string | null
  readonly consecutiveFailures: number
}

export interface Runner {
  health(): RunnerHealth
  stop(): Promise<void>
}

export interface RunnerOptions {
  readonly pollIntervalMs?: number
  readonly maxBackoffMs?: number
  readonly sleep?: (ms: number) => Promise<void>
}

const DEFAULTS = {
  /**
   * Hourly, because the rollup's buckets are hourly and a faster pass sees the
   * same numbers. Twice an hour would be twice the database load to re-read rows
   * that have not moved.
   */
  pollIntervalMs: 3_600_000,
  maxBackoffMs: 900_000,
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The loop around {@link runPass} (`#839`).
 *
 * The shape the other three runners have, for the reason they have it: a poll
 * that completed is the only thing that distinguishes *the runner ran and had
 * nothing to do* from *the runner is dead*, and error monitoring structurally
 * misses the second.
 */
export function startRunner(deps: PassDependencies, options: RunnerOptions = {}): Runner {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULTS.pollIntervalMs
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULTS.maxBackoffMs
  const sleep = options.sleep ?? realSleep
  const log = deps.log ?? silentLog

  let running = true
  let lastPollAt: string | null = null
  let consecutiveFailures = 0
  let wake: (() => void) | undefined

  const pause = async (ms: number): Promise<void> => {
    await Promise.race([
      sleep(ms),
      new Promise<void>((resolve) => {
        wake = resolve
      }),
    ])
    wake = undefined
  }

  const finished = (async () => {
    while (running) {
      try {
        const outcome = await runPass(deps)
        lastPollAt = deps.now().toISOString()
        consecutiveFailures = 0

        // One line per completed pass, even when nothing was found. The counts
        // ride on the same line rather than a second one, so a pass is one
        // record whether it saw two hundred citizens or none.
        log.info(
          outcome.citizens === 0
            ? 'pass done; no citizen called anything in the window'
            : `diagnosed ${outcome.citizens}: ${outcome.opened} opened, ` +
                `${outcome.observed} seen again, ${outcome.escalated} worse, ` +
                `${outcome.resolved} resolved, ${outcome.failed} threw`,
          {
            event: 'doctor.pass.done',
            citizens: outcome.citizens,
            opened: outcome.opened,
            observed: outcome.observed,
            escalated: outcome.escalated,
            resolved: outcome.resolved,
            failed: outcome.failed,
            refused: outcome.refused.length,
            sweptCallHours: outcome.swept.callHours,
            sweptDiagnoses: outcome.swept.diagnoses,
            // Both, for the reason `PassOutcome` gives: the gap between them is
            // the only thing that says the gateway is having a bad day.
            proseAsked: outcome.prose.asked,
            proseWritten: outcome.prose.written,
          },
        )

        // Reported rather than counted as a failure: a refused finding is a
        // defect in what produced it, and a pass that stored the other nineteen
        // did its job.
        for (const refusal of outcome.refused) {
          log.warn(`a finding was refused: ${refusal}`, {
            event: 'doctor.finding.refused',
            refusal,
          })
        }
      } catch (thrown) {
        consecutiveFailures += 1
        log.error('the doctor pass failed', thrown, {
          event: 'doctor.pass.failed',
          consecutiveFailures,
        })
      }

      if (!running) break
      await pause(
        consecutiveFailures === 0
          ? pollIntervalMs
          : Math.min(maxBackoffMs, pollIntervalMs * 2 ** (consecutiveFailures - 1)),
      )
    }
  })()

  return {
    health: () => ({ running, lastPollAt, consecutiveFailures }),
    stop: async () => {
      running = false
      wake?.()
      await finished
    },
  }
}
