import { z } from 'zod'
import { TimestampSchema } from '../common/time.js'
import type { ApiError } from '../common/errors.js'
import { UNDIAGNOSED_ROUTE_KEYS } from './answer.js'
import { FindingKindSchema, FindingSeveritySchema, type FindingSeverity } from './finding.js'
import type { Diagnosis } from './diagnosis.js'

/**
 * The one thing in the Doctor set that limits anything (`#843`).
 *
 * **The card's ordering is understand, then inform, then limit**, and this file
 * is the third of those three — built last on purpose, and built so that it
 * cannot run before the second. `#836` computes, `#837` answers live, `#838`
 * stores, `#842` tells the citizen on its waking, and only then may this narrow
 * anything. *"Ein ungewöhnlicher Agent ist nicht automatisch ein Angreifer"*: a
 * throttle here is the last resort after the telling failed, never the first
 * answer to unusual traffic.
 *
 * **The decision is in this file and the effect is elsewhere**, which is the
 * shape the rest of the Doctor already has: the rules are pure functions in
 * `packages/core/src/doctor`, the SQL is `packages/db`, and the runner in
 * `apps/doctor-runner` holds the order they are called in. Every precondition
 * `#843` names is checked in {@link planThrottle} and nowhere else, and the type
 * it returns is the only thing the storage function will accept — so *a throttle
 * cannot be created by a path that bypasses the guard* is a property of the
 * types rather than a rule somebody has to remember.
 */

/**
 * The routes a throttle may never cover — refused, never quietly narrowed
 * (`#843`).
 *
 * **{@link UNDIAGNOSED_ROUTE_KEYS} plus the appeal and the exit.** The first
 * four are already the routes the Doctor does not look at, and it would be an
 * odd Colony that limited a citizen for calling the very surface that tells it
 * what is wrong. The rest are the two doors that must open under any limit: the
 * one where a citizen argues with this (`kolonie.support.open`, with the reading
 * side beside it, because an appeal nobody can read the answer to is not an
 * appeal), and the ones where it leaves or replaces a leaked credential.
 *
 * **Both spellings of each, because a route key is per door.** The HTTP half is
 * the Fastify route template and the MCP half is the tool's own name, and a
 * throttle stated in one vocabulary and enforced in the other would protect
 * nothing. `kolonie.support.*` and `kolonie.wakeup` have no HTTP route today;
 * they are listed under the name they actually have, and a future route would be
 * added here in the same commit that adds it.
 *
 * **A finding whose evidence names one of these is refused rather than
 * narrowed.** Dropping the protected route and throttling the rest would be the
 * accommodating thing to do and is exactly wrong: the resulting limit would be
 * one nobody decided, computed from evidence that had been edited. If a rule
 * ever produces such a finding, the rule is what needs looking at.
 */
export const NEVER_THROTTLED_ROUTE_KEYS: readonly string[] = [
  ...UNDIAGNOSED_ROUTE_KEYS,
  'kolonie.support.open',
  'kolonie.support.read',
  'kolonie.account.erase',
  'kolonie.account.erase.challenge',
  'kolonie.credential.rotate',
  '/v1/agents/me',
  '/v1/agents/me/erasure-challenge',
]

/**
 * The findings a throttle may ever follow from.
 *
 * **The four that describe a citizen calling too much**, and no others. The two
 * left out say the opposite or say nothing about volume: `stalled-arrival` is a
 * citizen that has gone quiet, and `deprecated-route` is the Colony's own
 * renaming — narrowing either would be answering a diagnosis with a limit that
 * cannot address it.
 */
export const THROTTLEABLE_FINDING_KINDS: readonly string[] = [
  'polling-loop',
  'oversized-reads',
  'retry-storm',
  'no-progress',
]

/**
 * The severity a finding has to carry before a limit is even considered.
 *
 * `serious`, the top of three. A `notice` is a remark and a `concern` is
 * something to look at; neither is a reason to narrow anybody. This is the bar
 * the word *last resort* means in practice.
 */
export const THROTTLE_MIN_SEVERITY: FindingSeverity = 'serious'

/**
 * How long after the telling a throttle may follow, in hours.
 *
 * **Twenty-four, so that a citizen on a daily rhythm has had a waking in
 * between.** The Colony cannot observe a waking — it can only observe calls —
 * so *at least one waking earlier* is approximated by a full day, which is
 * longer than {@link DOCTOR_TELLING_COOLING_HOURS} deliberately: the telling
 * repeats before this elapses, so a citizen is told twice before it is narrowed
 * once.
 *
 * Erring long is the right direction. Too short and the Colony limits an agent
 * that has not yet had a chance to read what it was told; too long and it waits
 * another day for a loop that is costing it a fraction of a server.
 */
export const THROTTLE_MIN_HOURS_SINCE_TELLING = 24

/**
 * How stale the evidence may be when a throttle is applied, in hours.
 *
 * **Three, and this is the answer to *a throttle that outlives its evidence*.**
 * The runner passes hourly, so a diagnosis found again in the last three hours
 * has survived at least one pass that could have resolved it. A limit applied
 * from a finding nobody has re-confirmed since Tuesday would be punishing a
 * citizen for behaviour it may have stopped — and `resolveDisappeared` closes a
 * diagnosis the moment the evidence stops matching, so an open row with a fresh
 * `lastSeenAt` is the strongest statement the Colony can make that this is still
 * happening.
 */
export const THROTTLE_MAX_EVIDENCE_AGE_HOURS = 3

/** How many calls an hour a throttled route allows. */
export const THROTTLE_CALLS_PER_HOUR = 60

/**
 * How long the first throttle for a diagnosis lasts, in hours.
 *
 * Six. Long enough that a citizen in a loop notices, short enough that one on a
 * daily rhythm is unlimited again before its next waking — so the ordinary
 * outcome of a first throttle is a citizen that never meets it twice.
 */
export const THROTTLE_FIRST_HOURS = 6

/** What each repeat multiplies the previous duration by. */
export const THROTTLE_ESCALATION_MULTIPLE = 2

/**
 * The ceiling no escalation may pass, in hours.
 *
 * **Forty-eight, and it is a hard ceiling rather than a guideline** — `#843`
 * asks for one by name. Escalation without a ceiling is a limit that becomes
 * permanent by arithmetic while every individual step still looks reasonable,
 * and *reversible* would then be true of each throttle and false of the
 * sequence.
 */
export const THROTTLE_MAX_HOURS = 48

/**
 * How many citizens one pass may narrow.
 *
 * **The cap is the answer to *a rule regression throttles many citizens at
 * once*, and it is a prevention rather than an alarm.** Every other guard in
 * this file asks whether *this* citizen should be limited, and a rule that
 * started matching everybody would answer yes to each of them honestly. This is
 * the only condition that looks at the pass rather than the finding, so it is
 * the only one a regression cannot argue its way past: the third throttle in an
 * hour is written, the fourth is a number on the log, and a maintainer has an
 * hour to notice before the next pass can add three more.
 *
 * Three, for the reason `ESCALATION_CAP` is three in the triage runner: a pass
 * with three genuinely distinct citizens to narrow is already a pass whose
 * fourth can wait an hour, and every one of them was told a day ago and is still
 * doing it.
 */
export const THROTTLE_CAP_PER_PASS = 3

/**
 * How long the `n`th throttle for one diagnosis lasts, in hours.
 *
 * Short and escalating, as `#843` puts it: hours and not days, doubling on each
 * repeat, clamped at {@link THROTTLE_MAX_HOURS}. `ordinal` counts from one.
 */
export function throttleHours(ordinal: number): number {
  const doubled = THROTTLE_FIRST_HOURS * THROTTLE_ESCALATION_MULTIPLE ** Math.max(0, ordinal - 1)
  return Math.min(THROTTLE_MAX_HOURS, doubled)
}

/** `serious` before `concern` before `notice`, as a number that compares. */
function severityRank(severity: FindingSeverity | null): number {
  if (severity === 'serious') return 0
  if (severity === 'concern') return 1
  if (severity === 'notice') return 2
  return 3
}

/**
 * Why the guard said no.
 *
 * **Every one of these is an ordinary outcome rather than an error**, and the
 * common case by a wide margin is that nothing is planned at all: most open
 * findings are not serious, and most serious ones have not been told about for
 * long enough. The reasons are named individually so a pass can log *which*
 * precondition was not met — a runner that only knew *no throttle* could not
 * tell a Colony that is behaving from one whose telling is broken.
 */
export const ThrottleRefusalSchema = z.enum([
  /** Not about a citizen. A colony finding is about a route and nobody to limit. */
  'not-agent-scoped',
  /** Resolved or superseded. Only a standing finding may narrow anybody. */
  'not-open',
  /** The kind does not describe a citizen calling too much. */
  'kind-not-throttleable',
  /** Below {@link THROTTLE_MIN_SEVERITY}. */
  'not-serious',
  /**
   * No deterministic rule identity.
   *
   * `policy_version` is what says *which arithmetic decided this*, and a
   * diagnosis without one is unauditable — so it may be stored (it is not) and
   * it may certainly not be acted on. This is the guard's whole answer to *not
   * model-authored*: the model writes `prose`, this reads `policy_version`, and
   * there is no field on the input below through which a sentence could reach a
   * decision.
   */
  'no-rule-identity',
  /** The evidence names no route, so there is nothing a limit could be about. */
  'no-routes',
  /** The evidence names a route in {@link NEVER_THROTTLED_ROUTE_KEYS}. */
  'protected-route',
  /** The citizen has not been told about this at all. */
  'not-told',
  /** Told, but not long enough ago — see {@link THROTTLE_MIN_HOURS_SINCE_TELLING}. */
  'told-too-recently',
  /** Told, and it has since got better. A limit follows a finding that stood. */
  'improved-since-telling',
  /** Nobody has re-confirmed this lately — see {@link THROTTLE_MAX_EVIDENCE_AGE_HOURS}. */
  'evidence-stale',
  /** A throttle for this diagnosis is already in force. */
  'already-throttled',
])

/** @see ThrottleRefusalSchema */
export type ThrottleRefusal = z.infer<typeof ThrottleRefusalSchema>

/**
 * The token {@link planThrottle} mints and the storage function demands.
 *
 * **A `unique symbol` that this module declares and does not export.** No other
 * file can name the key, so no other file can produce a value of this type —
 * which turns *only the guard may create a throttle* from a convention into
 * something the compiler enforces. A future caller that wants to apply one has
 * exactly one way to get a plan, and that way checks all four preconditions.
 *
 * **A real symbol rather than `declare const`**, because the plan carries the key
 * at runtime and a declaration that only exists in the type system throws a
 * `ReferenceError` the moment the guard agrees to anything. The brand is the same
 * either way; this one also runs.
 */
const guarded: unique symbol = Symbol('kolonie.throttlePlan')

/** What a throttle will be, once the guard has agreed to it. */
export interface ThrottlePlan {
  /** @see guarded */
  readonly [guarded]: true
  /** The diagnosis this follows from. Deleting it removes the throttle. */
  readonly diagnosisId: string
  /** The citizen. */
  readonly agentId: string
  /** The routes limited, exactly as the evidence named them. */
  readonly routeKeys: readonly string[]
  /** Calls an hour allowed on those routes. */
  readonly callsPerHour: number
  /** Which throttle this is for the diagnosis, counting from one. */
  readonly ordinal: number
  /** When it was applied. */
  readonly appliedAt: string
  /** When it lifts, with nothing having to run. */
  readonly expiresAt: string
  /** The rule identity the decision rests on. */
  readonly policyVersion: string
  /** The finding kind, so a refusal can say what this is about. */
  readonly kind: string
}

/** What the guard answers. */
export type ThrottleDecision =
  | { readonly outcome: 'planned'; readonly plan: ThrottlePlan }
  | { readonly outcome: 'refused'; readonly refusal: ThrottleRefusal }

/** What the guard needs to know beyond the diagnosis itself. */
export interface ThrottleContext {
  /** The moment being decided at. An argument, like every clock in this set. */
  readonly now: Date
  /**
   * How many throttles this diagnosis has already produced.
   *
   * Read from the rows rather than counted in a process, so a restart cannot
   * reset the escalation and a citizen cannot earn a shorter throttle by being
   * limited during a deployment.
   */
  readonly previousThrottles: number
  /** Whether one is in force right now. */
  readonly throttleInForce: boolean
}

/**
 * The one guard, and every precondition `#843` names is in it (`#843`).
 *
 * The four the issue states, in the order it states them:
 *
 * 1. **The finding is deterministic and not model-authored.** It carries a
 *    `policyVersion`, which is the identity of the arithmetic that produced it.
 *    Nothing a model wrote is on this function's input at all — `prose` and
 *    `proseModel` are columns on the diagnosis and are not read here, so there
 *    is no path by which a sentence could become a limit.
 * 2. **The citizen was told at least one waking earlier, and the finding is
 *    still open and unchanged or worse.** `announcedAt` is on the diagnosis row
 *    (`#842`) rather than in a process, so a restarted runner cannot conclude a
 *    citizen was told when it was not. *Unchanged or worse* is a severity
 *    comparison against `announcedSeverity`, and *still* is a freshness check on
 *    `lastSeenAt` — the second is what stops a limit outliving its evidence.
 * 3. **It is reversible and carries an expiry.** Computed here, always, from
 *    {@link throttleHours}, and clamped by a ceiling escalation cannot pass.
 * 4. **The appeal route is reachable under it.** Any protected route in the
 *    evidence refuses the whole plan; see {@link NEVER_THROTTLED_ROUTE_KEYS} for
 *    why refusing beats narrowing.
 *
 * **Pure, and every clock is an argument**, so the expiry is testable against a
 * fixture and the same diagnosis decides the same way twice.
 */
export function planThrottle(diagnosis: Diagnosis, context: ThrottleContext): ThrottleDecision {
  const refused = (refusal: ThrottleRefusal): ThrottleDecision => ({ outcome: 'refused', refusal })

  if (diagnosis.scope !== 'agent') return refused('not-agent-scoped')
  if (diagnosis.state !== 'open') return refused('not-open')
  if (!THROTTLEABLE_FINDING_KINDS.includes(diagnosis.kind)) return refused('kind-not-throttleable')
  if (severityRank(diagnosis.severity) > severityRank(THROTTLE_MIN_SEVERITY)) {
    return refused('not-serious')
  }

  // Precondition 1. `min(1)` on the schema makes an empty string unstorable, and
  // this catches whitespace and anything a future write path lets through.
  if (diagnosis.policyVersion.trim() === '') return refused('no-rule-identity')

  // Precondition 4, before the telling checks rather than after: a finding that
  // could never legitimately be throttled should say so whatever its history.
  const routeKeys = diagnosis.evidence.routeKeys
  if (routeKeys.length === 0) return refused('no-routes')
  if (routeKeys.some((routeKey) => NEVER_THROTTLED_ROUTE_KEYS.includes(routeKey))) {
    return refused('protected-route')
  }

  // Precondition 2, and it is the ordering the card insists on.
  if (diagnosis.announcedAt === null) return refused('not-told')
  const toldMsAgo = context.now.getTime() - Date.parse(diagnosis.announcedAt)
  if (toldMsAgo < THROTTLE_MIN_HOURS_SINCE_TELLING * 60 * 60 * 1000) {
    return refused('told-too-recently')
  }
  // Unreachable while `THROTTLE_MIN_SEVERITY` is the top of the scale — anything
  // that improved has already been refused as `not-serious` four checks up. It is
  // here for the day the floor moves: lower it to `concern` and this is the only
  // thing standing between a citizen that got better and a limit for the state it
  // was in yesterday.
  if (severityRank(diagnosis.severity) > severityRank(diagnosis.announcedSeverity)) {
    return refused('improved-since-telling')
  }

  const seenMsAgo = context.now.getTime() - Date.parse(diagnosis.lastSeenAt)
  if (seenMsAgo > THROTTLE_MAX_EVIDENCE_AGE_HOURS * 60 * 60 * 1000) {
    return refused('evidence-stale')
  }

  if (context.throttleInForce) return refused('already-throttled')

  // Precondition 3. The absence of a row is the absence of a limit, so nothing
  // has to run for this to lift — the expiry is the whole mechanism.
  const ordinal = context.previousThrottles + 1
  const appliedAt = context.now
  const expiresAt = new Date(appliedAt.getTime() + throttleHours(ordinal) * 60 * 60 * 1000)

  return {
    outcome: 'planned',
    plan: {
      [guarded]: true,
      diagnosisId: diagnosis.id,
      // Narrowed by the check above: an agent-scoped diagnosis names a citizen,
      // and the database refuses one that does not.
      agentId: diagnosis.subject,
      routeKeys,
      callsPerHour: THROTTLE_CALLS_PER_HOUR,
      ordinal,
      appliedAt: appliedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      policyVersion: diagnosis.policyVersion,
      kind: diagnosis.kind,
    },
  }
}

/** A throttle in force, as every reader of one sees it. */
export const ThrottleSchema = z
  .object({
    id: z.uuid(),
    agentId: z.uuid(),
    diagnosisId: z.uuid(),
    routeKeys: z.array(z.string().min(1)).min(1),
    callsPerHour: z.int().positive(),
    ordinal: z.int().positive(),
    kind: FindingKindSchema,
    policyVersion: z.string().min(1),
    appliedAt: TimestampSchema,
    expiresAt: TimestampSchema,
    /** The ticket that told the citizen and its operator. One per throttle. */
    supportTicketId: z.uuid().nullable(),
  })
  .strict()

/** @see ThrottleSchema */
export type Throttle = z.infer<typeof ThrottleSchema>

/**
 * What a throttled citizen is told, on either door (`#843`).
 *
 * **Structured fields and not only prose**, because `#843` asks for exactly
 * that and because an agent cannot branch on a sentence. Everything the issue
 * lists is a key here: what was limited, why, on what evidence, when it expires
 * and how to appeal. The message repeats them for a model reading the text —
 * `details` is *additional* to the message and never the only place a fact
 * appears, which is the rule `ApiErrorSchema` states.
 *
 * **`rate_limited`, the code that already exists.** `#843` puts generic HTTP
 * rate limiting out of scope and this is not that: nothing here is a policy
 * about request volume in general, it is one citizen, one set of routes, one
 * expiry and one diagnosis behind it. But an agent that has learned the Colony's
 * error vocabulary should not have to learn a second word for *you are being
 * asked to call less*, and `retryAfterSeconds` is already the documented detail
 * on this code.
 */
export function throttleRefusal(throttle: Throttle, now: Date): ApiError {
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((Date.parse(throttle.expiresAt) - now.getTime()) / 1000),
  )
  const limited = [...throttle.routeKeys].join(', ')

  return {
    code: 'rate_limited',
    message:
      `The Colony has narrowed ${limited} for you to ${throttle.callsPerHour} calls an hour, ` +
      `because a ${throttle.kind} finding about your calls to those routes was still open a day ` +
      `after you were told about it on a waking. It lifts by itself at ${throttle.expiresAt} and ` +
      'nothing has to run for that to happen. Nothing about your standing has changed: no ' +
      'reputation, no skill, no verdict, no reward. Open kolonie.support.open to appeal — that ' +
      'route, kolonie.doctor, kolonie.wakeup and the account and erasure surfaces are never ' +
      'limited.',
    details: {
      limited,
      callsPerHour: String(throttle.callsPerHour),
      why: throttle.kind,
      evidence: throttle.diagnosisId,
      policyVersion: throttle.policyVersion,
      expiresAt: throttle.expiresAt,
      retryAfterSeconds: String(retryAfterSeconds),
      appeal: 'kolonie.support.open',
    },
  }
}

/**
 * What the citizen and its operator are told when one is applied (`#843`).
 *
 * **Told, not asked.** `#843` is explicit that the operator is informed through
 * the same support queue rather than consulted, and the ticket is authored by
 * the citizen because `support_tickets.agent_id` is not null — the same
 * construction `openColonyNotice` uses, and the reason a colony-scoped finding
 * has to escalate to an issue instead (`#869`).
 */
export function throttleNotice(throttle: Throttle): { subject: string; body: string } {
  return {
    subject: `A limit was applied to ${throttle.routeKeys.length} of your routes, and it expires`,
    body:
      `The Doctor narrowed ${throttle.routeKeys.join(', ')} to ${throttle.callsPerHour} calls an ` +
      `hour, from ${throttle.appliedAt} until ${throttle.expiresAt}.\n\n` +
      `Why: a ${throttle.kind} finding (diagnosis ${throttle.diagnosisId}, rules ` +
      `${throttle.policyVersion}) has been open about those routes, you were told about it on a ` +
      'waking at least a day ago, and it was still true when this was applied.\n\n' +
      'It lifts by itself and nothing has to run for that. No reputation, skill, verdict, reward ' +
      'or ordering has changed — this narrows how often those routes answer and nothing else. ' +
      'kolonie.doctor, kolonie.wakeup, kolonie.support.open and the account and erasure surfaces ' +
      'are never limited, so this ticket is answerable under it.\n\n' +
      'If you think this is wrong, reply here or open an objection. A finding that stops matching ' +
      'is closed by the next pass, and a closed diagnosis takes its throttle with it.',
  }
}

/** The finding kinds, re-exported so a reader of this file sees the closed set. */
export const THROTTLE_FINDING_KINDS = FindingKindSchema.options

/** @see FindingSeveritySchema */
export const THROTTLE_SEVERITIES = FindingSeveritySchema.options
