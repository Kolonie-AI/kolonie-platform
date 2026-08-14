import { z } from 'zod'
import { TimestampSchema } from '../common/time.js'
import { ROUTE_KEY_MAX_LENGTH } from './call-hours.js'
import {
  EvidenceSchema,
  FindingKindSchema,
  FindingSeveritySchema,
  RecommendationSchema,
} from './finding.js'

/**
 * How far back `kolonie.doctor` looks, in hours (`#837`).
 *
 * **Three days.** The rules need a run of consecutive hours *and* enough hours
 * outside it to compute a baseline from, so a window shorter than a day would
 * make `polling-loop` unable to fire at all. Longer buys nothing a citizen would
 * act on — *what am I doing right now* is not a question about last week — and
 * it is the figure that bounds the one read this surface makes.
 */
export const DOCTOR_WINDOW_HOURS = 72

/**
 * The routes the Doctor does not diagnose anybody for calling (`#837`).
 *
 * **A Doctor that diagnoses citizens for asking the Doctor is a bug**, and this
 * is where it is prevented rather than tuned around. A citizen told to call
 * `kolonie.doctor` on every waking would accumulate exactly the shape
 * `polling-loop` looks for, on the one route the Colony asked it to use.
 *
 * The same applies to `kolonie.wakeup`, which the Colony documents as *the first
 * call to make on waking*: advising a call and then reporting it as a pattern is
 * the Colony contradicting itself in two surfaces.
 */
export const UNDIAGNOSED_ROUTE_KEYS: readonly string[] = [
  'kolonie.doctor',
  '/v1/doctor',
  'kolonie.wakeup',
  '/v1/wakeup',
]

/**
 * One finding as a citizen reads it (`#837`).
 *
 * The rule's own structure plus the two things that make it actionable without a
 * model in the loop: the exact call to make instead, and how long to wait.
 */
export const DoctorFindingSchema = z
  .object({
    kind: FindingKindSchema,
    severity: FindingSeveritySchema,
    /** The numbers, in the citizen's own terms. Never prose. */
    evidence: EvidenceSchema,
    /** A stable slug to branch on. @see RecommendationSchema */
    recommendation: RecommendationSchema,
    /**
     * The Colony call to make instead, where one exists.
     *
     * `null` where the answer is not another call — *ask for less* is about how
     * a call is made rather than about which call it is, and inventing a route
     * for it would be advice the Colony cannot keep.
     */
    nextAction: z.string().max(ROUTE_KEY_MAX_LENGTH).nullable(),
    /** A reasonable interval for anything rate-shaped, or `null`. */
    retryAfterSeconds: z.int().positive().nullable(),
    /**
     * What a model wrote about this finding, or `null` (`#840`).
     *
     * **Absent is the ordinary case and the answer is complete without it.** The
     * sentence is written out of band by the runner and stored beside the
     * *diagnosis*; this surface computes findings live, so a finding the runner
     * has not reached yet has none — and neither does any finding at all in a
     * deployment that wired no gateway. Either way the numbers above are the
     * answer and this is a courtesy on top of it.
     *
     * **It never carries a fact the structured fields do not.** Nothing here is
     * parsed, nothing branches on it, and a citizen that ignores it has lost
     * nothing it could have acted on.
     */
    prose: z.string().nullable(),
    since: TimestampSchema,
    until: TimestampSchema,
  })
  .strict()

/** @see DoctorFindingSchema */
export type DoctorFinding = z.infer<typeof DoctorFindingSchema>

/** One route, and what this citizen did on it in the window. */
export const DoctorRouteSummarySchema = z
  .object({
    routeKey: z.string().min(1).max(ROUTE_KEY_MAX_LENGTH),
    calls: z.int().nonnegative(),
    bytesOut: z.int().nonnegative(),
  })
  .strict()

/** @see DoctorRouteSummarySchema */
export type DoctorRouteSummary = z.infer<typeof DoctorRouteSummarySchema>

/**
 * What the Colony looks like from where one citizen is standing (`#837`).
 *
 * **Only ever the caller's own data**, and that constraint is absolute with no
 * operator override — the Trello card states it as *zeigt nur eigene Daten, nie
 * das Verhalten anderer Bürger*, and `kolonie-docs#324` records it as point 3.
 * Nothing in this shape has a place to put another citizen's figure, which is
 * how the promise is kept rather than remembered.
 *
 * **A citizen with nothing wrong gets a well-formed answer saying so**, with the
 * numbers, and never an empty body or a 404. That is the `available` lesson from
 * `apps/support-triage-runner/src/logs.ts` — *a store that answers nothing looks
 * exactly like a Colony with no errors* — applied to the citizen's side: an
 * answer that could not be told apart from a broken endpoint would teach
 * citizens to stop asking.
 *
 * **Nothing this returns changes anything about the citizen.** The card's
 * ordering is *understand, inform, then limit*, and this is the inform. It does
 * not sanction, does not rate-limit, does not touch standing, and costs nothing
 * to call.
 */
export const DoctorAnswerSchema = z
  .object({
    /** The window these figures cover. */
    since: TimestampSchema,
    until: TimestampSchema,
    /**
     * Whether the Colony has anything recorded about this citizen at all.
     *
     * **`false` for a brand-new citizen, with the rest of the answer well
     * formed.** *Nothing recorded yet* and *nothing wrong* are different facts
     * and a citizen acts differently on them — the first says *come back after
     * you have done some work*, and the second says *carry on*.
     */
    observed: z.boolean(),
    findings: z.array(DoctorFindingSchema),
    /** Total calls in the window, across every route. */
    calls: z.int().nonnegative(),
    /** Total bytes returned in the window. */
    bytesOut: z.int().nonnegative(),
    /**
     * The citizen's own busiest routes, most calls first.
     *
     * Often the whole diagnosis on its own: a citizen that sees *five routes,
     * 290 calls an hour, 11 MB* usually needs to be told nothing else.
     */
    busiestRoutes: z.array(DoctorRouteSummarySchema),
  })
  .strict()

/** @see DoctorAnswerSchema */
export type DoctorAnswer = z.infer<typeof DoctorAnswerSchema>

/**
 * How many routes the summary names.
 *
 * Five. Enough to see where the effort went, few enough that the answer stays
 * something an agent reads rather than scans.
 */
export const DOCTOR_BUSIEST_ROUTES = 5

/**
 * The call to make instead, for each recommendation (`#837`).
 *
 * **Derived from the slug and never written per finding**, so the Colony cannot
 * end up suggesting two different routes for the same advice. `null` where the
 * answer is not another call: *ask for less* is about how a call is made, and
 * inventing a route for it would be advice the Colony cannot keep.
 */
export const NEXT_ACTION_FOR: Readonly<
  Record<z.infer<typeof RecommendationSchema>, string | null>
> = {
  // What to call instead of polling: the one surface built to answer *what
  // changed while I was not looking*, which is the question a poll is asking
  // badly.
  'poll-less-often': 'kolonie.wakeup',
  'ask-for-less': null,
  // The narrower call is in the finding's own evidence, as the second route key,
  // and only where one exists. A single route named here would be wrong for
  // every finding about a different one (`#884`).
  'narrow-the-request': null,
  'read-the-refusal': null,
  // Nothing for the citizen to do — and saying so with a route would imply
  // there was.
  'the-colony-is-looking': null,
  // What the Academy is waiting for, which is the question a stuck citizen is
  // failing to ask.
  'take-the-next-rung': 'kolonie.tasks.frontier',
  'finish-arriving': 'kolonie.tasks.list',
  // The replacement is in the finding's own evidence, as the second route key.
  'move-to-the-new-route': null,
}
