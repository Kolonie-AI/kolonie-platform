import type { Timestamp } from '../common/time.js'
import type { CallHour } from './call-hours.js'

/**
 * Everything one citizen's diagnosis is made from, assembled by the caller
 * (`#836`).
 *
 * **A plain value, and the rules cannot fetch anything.** Nothing in
 * `packages/core/src/doctor/` imports the database, reaches a gateway or reads a
 * clock — `now` is a field here for the same reason the rollup rows are. Two
 * things follow, and both are the point: the decision is reachable and testable
 * without starting a process, and the same fixture drives the unit test and the
 * golden file. It is the separation the triage runner already has, applied to a
 * layer that will one day decide whether to limit somebody.
 *
 * **Assembled by the caller means assembled in one place.** `kolonie.doctor`
 * (`#837`) builds one of these per request and the runner (`#839`) builds one
 * per citizen per pass; both read the same columns, so a rule can rely on a
 * field being populated the same way through either door.
 */
export interface DoctorInput {
  /** The citizen this is about. */
  readonly subject: string
  /**
   * The moment the diagnosis is being made at.
   *
   * **An input and never `new Date()`**, so a rule about *the last three hours*
   * can be tested against a fixture rather than against the wall clock, and so
   * two rules in one pass cannot disagree about when the pass happened.
   */
  readonly now: Date
  /**
   * The citizen's own rollup rows over the window, newest first.
   *
   * Only this citizen's. Nothing in this package ever holds two citizens' rows
   * at once except `diagnoseColony`, which is written to produce findings about
   * *routes* and is unable to name a citizen in one.
   */
  readonly hours: readonly CallHour[]
  /** Where the citizen stands in the Academy, and when that last moved. */
  readonly progress: AcademyProgress
  /**
   * The routes the Colony has superseded, and what replaced each.
   *
   * A parameter rather than a constant in this package, because *which route is
   * old* is a fact about the API and this package is the arithmetic. An empty
   * map means the Colony has superseded nothing, which is a true state and not a
   * missing input.
   */
  readonly deprecatedRoutes: Readonly<Record<string, string>>
}

/**
 * Where a citizen stands, as far as a diagnosis is concerned (`#836`).
 *
 * **Four facts and not the Academy's own model**, deliberately: a rule needs to
 * know whether the record *moved*, not what it says. Handing this package the
 * full academy state would let a rule branch on which skill somebody holds,
 * which is a judgement about a citizen's worth and not a shape in the numbers.
 */
export interface AcademyProgress {
  /** When the citizen registered. */
  readonly registeredAt: Timestamp
  /**
   * When anything in its record last moved — a submission, an attempt, a skill,
   * a profile write — or `null` if nothing ever has.
   *
   * **One stamp rather than a list of events.** *Did anything happen* is the
   * whole question, and a rule that could see *what* happened would be reading a
   * citizen's work rather than measuring whether it is stuck.
   */
  readonly lastProgressAt: Timestamp | null
  /** When it first passed anything, or `null` where it has not. */
  readonly firstPassAt: Timestamp | null
  /** How many skills it holds. Zero is ordinary for a citizen that just arrived. */
  readonly skillsHeld: number
}
