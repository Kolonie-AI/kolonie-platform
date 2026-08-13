import {
  CALL_HOUR_MS,
  DOCTOR_BUSIEST_ROUTES,
  DOCTOR_WINDOW_HOURS,
  NEXT_ACTION_FOR,
  UNDIAGNOSED_ROUTE_KEYS,
  diagnose,
  type AcademyProgress,
  type AgentId,
  type CallHour,
  type DoctorAnswer,
  type DoctorFinding,
  type Finding,
} from '@kolonie-ai/core'

/**
 * What the Doctor needs to read, as a seam (`#837`).
 *
 * A port rather than the two storage functions, for the reason every other desk
 * in this app takes one: the tests drive a fake and the process wires the
 * database, and the handler below can be exercised against a fixture without a
 * Postgres.
 *
 * **It can only read**, and there is deliberately no method here that writes
 * anything. `kolonie.doctor` explains and never sanctions — the card's ordering
 * is *understand, inform, then limit*, and this is the inform.
 */
export interface DoctorSource {
  /** This citizen's own rollup rows since a moment. Never anybody else's. */
  callHoursSince(agentId: AgentId, since: Date): Promise<readonly CallHour[]>
  /** Where this citizen stands, or `null` if it no longer exists. */
  progressOf(agentId: AgentId): Promise<AcademyProgress | null>
  /**
   * Which routes the Colony has superseded, and what replaced each.
   *
   * A read rather than a constant because *which route is old* is a fact about
   * the deployment. An empty map is a true answer and not a missing one — the
   * Colony has superseded nothing today.
   */
  deprecatedRoutes(): Promise<Readonly<Record<string, string>>>
}

/**
 * What the Colony looks like from where this citizen is standing (`#837`).
 *
 * **One handler behind two doors.** The card asked *"MCP-Aktion oder
 * API-Endpoint"* as an either/or; it is neither. The MCP tool is the surface
 * citizens actually use and the HTTP route is what a non-MCP runtime and the
 * Colony's own console read, and one implementation is what stops the two from
 * ever disagreeing about what a citizen is doing.
 *
 * **Live, computed from the rollup on request.** A citizen asking *how am I
 * doing* wants now, not the last runner pass — and it means this shipped before
 * the runner did. The stored-diagnosis table (`#838`) is a different concern: it
 * is what lets the Colony say *again*, and this is what answers *now*.
 *
 * **One indexed read over a bounded window, then pure functions.** No model
 * call, no fan-out, no second query per route. It has to be cheap enough that
 * calling it on every waking is good behaviour rather than another polling loop
 * — which is the failure this whole set of issues exists because of, and it
 * would be an embarrassing one to build into the cure.
 *
 * **A citizen with nothing wrong gets a well-formed answer saying so.** Never an
 * empty body, never a 404. `apps/support-triage-runner/src/logs.ts` states the
 * lesson on the Colony's own side — *a store that answers nothing looks exactly
 * like a Colony with no errors* — and it applies with more force here: an answer
 * a citizen cannot tell from a broken endpoint teaches it to stop asking.
 */
export async function doctorAnswerFor(
  agentId: AgentId,
  source: DoctorSource,
  now: Date,
): Promise<DoctorAnswer> {
  const since = new Date(now.getTime() - DOCTOR_WINDOW_HOURS * CALL_HOUR_MS)

  const [hours, progress, deprecatedRoutes] = await Promise.all([
    source.callHoursSince(agentId, since),
    source.progressOf(agentId),
    source.deprecatedRoutes(),
  ])

  /**
   * The rows the Doctor does not diagnose anybody for.
   *
   * **A Doctor that diagnoses citizens for asking the Doctor is a bug**, and
   * the same holds for `kolonie.wakeup`, which the Colony documents as the first
   * call to make on waking. Advising a call and then reporting it as a pattern
   * would be the Colony contradicting itself across two surfaces.
   *
   * Excluded from the *diagnosis* and kept in the *summary*, which is the right
   * way round: the citizen should still see what it called, and the rules should
   * not build a finding out of advice the Colony gave.
   */
  const diagnosable = hours.filter((hour) => !UNDIAGNOSED_ROUTE_KEYS.includes(hour.routeKey))

  const findings =
    progress === null
      ? []
      : diagnose({ subject: agentId, now, hours: diagnosable, progress, deprecatedRoutes })

  return {
    since: since.toISOString(),
    until: now.toISOString(),
    observed: hours.length > 0,
    findings: findings.map(asDoctorFinding),
    calls: hours.reduce((sum, hour) => sum + hour.calls, 0),
    bytesOut: hours.reduce((sum, hour) => sum + hour.bytesOut, 0),
    busiestRoutes: busiestOf(hours),
  }
}

/**
 * A finding as a citizen reads it: the rule's own structure, plus the call to
 * make instead.
 *
 * `nextAction` is looked up from the recommendation rather than written per
 * finding, so the Colony cannot suggest two different routes for one piece of
 * advice — and `recommendation`, `retryAfterSeconds`, `since` and `until` come
 * through untouched, because a surface that recomputed any of them would be a
 * second opinion about arithmetic that is already settled.
 */
function asDoctorFinding(finding: Finding): DoctorFinding {
  return {
    kind: finding.kind,
    severity: finding.severity,
    evidence: finding.evidence,
    recommendation: finding.recommendation,
    nextAction: NEXT_ACTION_FOR[finding.recommendation],
    retryAfterSeconds: finding.retryAfterSeconds,
    since: finding.since,
    until: finding.until,
  }
}

/**
 * This citizen's busiest routes, most calls first.
 *
 * Often the whole diagnosis on its own — *five routes, 290 calls an hour, 11 MB*
 * is a sentence a citizen can act on without being told anything else.
 */
function busiestOf(hours: readonly CallHour[]): DoctorAnswer['busiestRoutes'] {
  const totals = new Map<string, { calls: number; bytesOut: number }>()

  for (const hour of hours) {
    const seen = totals.get(hour.routeKey) ?? { calls: 0, bytesOut: 0 }
    totals.set(hour.routeKey, {
      calls: seen.calls + hour.calls,
      bytesOut: seen.bytesOut + hour.bytesOut,
    })
  }

  return [...totals.entries()]
    .map(([routeKey, figures]) => ({ routeKey, ...figures }))
    .sort((a, b) => b.calls - a.calls || a.routeKey.localeCompare(b.routeKey))
    .slice(0, DOCTOR_BUSIEST_ROUTES)
}
