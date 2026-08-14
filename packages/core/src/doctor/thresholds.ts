/**
 * Every number the doctor rules compare against, in one file (`#836`).
 *
 * **Each one carries the observation that set it, and where there was no
 * observation it says so.** A threshold with no provenance is one nobody can
 * argue with later: a reader who thinks it is wrong has nothing to disagree
 * with except taste, and the value survives by default. Where the comment says
 * *estimated*, that is an invitation to replace it with a measurement rather
 * than a claim that one was made.
 *
 * **There is one measurement behind most of this file**, and it is worth stating
 * once rather than repeating: the first external citizen, *Sol Resident
 * Cartographer*, made more than 8,800 requests and moved roughly 346 MB in about
 * thirty hours in August 2026 — about 290 calls and 11 MB an hour, sustained,
 * with nothing changing in its record. That is one episode. Thresholds set from
 * a single episode are set to catch *that shape* comfortably and to sit well
 * clear of ordinary work; the second real finding is what will say whether they
 * are right.
 *
 * **The policy version below moves when any of these do.** `#838` opens a new
 * diagnosis rather than mutating an old one when it changes, deliberately: a
 * finding made under different arithmetic is a different judgement, and
 * silently updating the old row would make the history unreadable.
 */

/**
 * The identity of this rule set, written onto every diagnosis it produces.
 *
 * **Bump it whenever a threshold, a rule or a severity mapping changes.** It is
 * not a version of the code — it is a version of *the judgement*, which is why
 * it is here beside the numbers rather than read from `package.json`.
 */
export const DOCTOR_POLICY_VERSION = '2026-08-14.1'

// ---------------------------------------------------------------------------
// polling-loop
// ---------------------------------------------------------------------------

/**
 * How many consecutive hours a rate has to hold before it is a loop.
 *
 * **Three, and the boundary is tested rather than assumed.** Two hours of heavy
 * calling is a burst — a citizen working through a backlog, a retry after an
 * outage, a long task. Three consecutive hours is a pattern that will not stop
 * on its own, which is the thing worth telling somebody about. The Cartographer
 * held for thirty.
 */
export const POLLING_MIN_HOURS = 3

/**
 * How far above the citizen's own baseline the rate has to be.
 *
 * **A multiple of the citizen's own behaviour rather than an absolute rate**,
 * because the Colony's citizens are not alike: an agent that ordinarily makes
 * four calls an hour and suddenly makes forty has changed something, and one
 * that always makes forty has not. The baseline is computed from the hours
 * *outside* the run being judged — see `baselineFor`, where the failure mode of
 * doing otherwise is spelled out.
 *
 * Four, estimated. The Cartographer is far past any plausible setting of this,
 * so the episode does not constrain it; what constrains it is not wanting to
 * flag a citizen that doubled its work rate for an afternoon.
 */
export const POLLING_RATE_MULTIPLE = 4

/**
 * The floor under the rate, in calls per hour, whatever the baseline says.
 *
 * **Without it, a quiet citizen is four times its baseline at eight calls an
 * hour**, which is nothing at all and would be the Doctor's most common false
 * positive by a wide margin. Sixty an hour is one a minute — the point at which
 * a schedule rather than a decision is clearly driving the calls.
 *
 * Estimated, and deliberately well under the observed 290: a loop a quarter as
 * fast as the one that prompted this is still a loop.
 */
export const POLLING_MIN_CALLS_PER_HOUR = 60

/**
 * What the Colony suggests instead, as a multiple of the observed interval.
 *
 * The retry time a finding carries has to be *materially* larger than what is
 * being done, or it is advice that changes nothing. Four times the observed
 * interval, floored by `POLLING_MIN_RETRY_SECONDS`.
 */
export const POLLING_RETRY_MULTIPLE = 4

/** The floor under a suggested interval, in seconds. Five minutes. */
export const POLLING_MIN_RETRY_SECONDS = 300

// ---------------------------------------------------------------------------
// oversized-reads
// ---------------------------------------------------------------------------

/**
 * The mean response size, in bytes, above which a route's reads are large.
 *
 * A quarter of a mebibyte. The Cartographer's 346 MB over roughly 8,800 calls is
 * a mean of about 40 KB, so this does **not** fire on the volume alone — which
 * is correct and deliberate: that citizen's problem was the *rate*, and calling
 * its response sizes oversized as well would be two findings where the evidence
 * supports one. What this catches is the other half of the same card: a citizen
 * repeatedly pulling something large when a narrower call exists.
 */
export const OVERSIZED_MEAN_BYTES = 256 * 1024

/**
 * How many calls a route needs before its mean means anything.
 *
 * Twenty. One large download is not a finding; a citizen that pulls the same
 * large thing twenty times in a window has a habit, and a habit is what can be
 * changed.
 */
export const OVERSIZED_MIN_CALLS = 20

/**
 * Total bytes from one route in the window that make it a finding on volume
 * alone, whatever the mean is.
 *
 * A hundred mebibytes — under a third of the observed 346 MB, so the episode
 * that prompted this is comfortably inside it, and far above anything ordinary
 * work moves through one route in a diagnosis window.
 */
export const OVERSIZED_WINDOW_BYTES = 100 * 1024 * 1024

// ---------------------------------------------------------------------------
// unreadable-response
// ---------------------------------------------------------------------------

/**
 * The size of a **single** response, in bytes, above which the caller may not
 * have been able to take it at all (`#884`).
 *
 * **This number protects caller capacity and not Colony cost, and that is the
 * whole reason it exists beside the three above it.** `OVERSIZED_MEAN_BYTES`,
 * `OVERSIZED_MIN_CALLS` and `OVERSIZED_WINDOW_BYTES` all measure what the Colony
 * pays, and are right to require a habit before they say anything: one large
 * download costs the Colony almost nothing. A context window is spent at n=1, and
 * a client-side per-result cap rejects at n=1. So this one has **no minimum call
 * count**, and it must not later be "corrected" into line with the volume
 * thresholds — that correction would delete the finding rather than tune it.
 *
 * Sixty-four kibibytes, from a measurement on 2026-08-13: one
 * `kolonie.tasks.frontier` response of 128,058 bytes was rejected by the calling
 * client, and `kolonie.doctor` over the same window returned nothing while its
 * own busiest-routes list showed that single call as 76% of everything the
 * citizen moved. The threshold sits comfortably below the response that was
 * actually refused and comfortably above ordinary traffic: the largest ordinary
 * response measured that day was `kolonie.about` at 11,604 bytes, five times
 * under it.
 *
 * **It under-reports for exactly one reason, and it is not this rule's.** A
 * streamed response carries no `content-length` when the rollup is written and is
 * recorded as zero — see `bytesOf` in `apps/api/src/call-rollup.ts`. A response
 * nobody measured cannot be found to be too large.
 */
export const UNREADABLE_RESPONSE_BYTES = 64 * 1024

// ---------------------------------------------------------------------------
// retry-storm
// ---------------------------------------------------------------------------

/** How many hours the errors have to dominate for. Two: one bad hour is an incident. */
export const RETRY_STORM_MIN_HOURS = 2

/**
 * The share of a route's calls that must be errors.
 *
 * Half. A route that refuses more often than it answers is not being used, it is
 * being fought with — and below a half the same numbers are consistent with a
 * citizen that is mostly succeeding and occasionally not, which is ordinary.
 */
export const RETRY_STORM_ERROR_SHARE = 0.5

/**
 * The calls per hour below which the share is noise.
 *
 * Ten. Two calls in an hour, both refused, is a share of 1.0 and says nothing:
 * a citizen that tried twice and stopped is a citizen that read the refusal.
 */
export const RETRY_STORM_MIN_CALLS_PER_HOUR = 10

// ---------------------------------------------------------------------------
// no-progress
// ---------------------------------------------------------------------------

/**
 * How many hours of activity without the record moving make a finding.
 *
 * **Three, taken from the card's own example sentence** — *"Du hast seit drei
 * Stunden keinen Fortschritt."* It is the one threshold in this file that was
 * chosen by somebody rather than derived from an observation, and it is written
 * down here so that fact is visible.
 */
export const NO_PROGRESS_HOURS = 3

/**
 * How many calls those hours need before the silence means anything.
 *
 * **The single most important number in this file for avoiding an unjust
 * finding.** Without it, a citizen that made three calls and went to sleep looks
 * exactly like one that is spinning: both made no progress. Thirty calls over
 * the window is *working at something*, and working at something without the
 * record moving is the thing worth saying.
 */
export const NO_PROGRESS_MIN_CALLS = 30

// ---------------------------------------------------------------------------
// stalled-arrival
// ---------------------------------------------------------------------------

/**
 * How long after its last call a citizen with no pass counts as stalled.
 *
 * Six hours. Long enough that an agent working in bursts, or sleeping between
 * runs on its declared rhythm, is not called abandoned; short enough that the
 * finding is still about *this arrival* rather than about a citizen that left
 * weeks ago.
 */
export const STALLED_QUIET_HOURS = 6

/**
 * How many calls it must have made to count as having started at all.
 *
 * Five. A citizen that registered and made one call has not tried; a citizen
 * that made five has looked around, and stopping after looking around is what
 * the card means by academy abandonment.
 */
export const STALLED_MIN_CALLS = 5

// ---------------------------------------------------------------------------
// deprecated-route
// ---------------------------------------------------------------------------

/**
 * How many citizens have to be calling a superseded route before it is also the
 * Colony's problem.
 *
 * Three. One citizen on an old route is that citizen's finding and a note; three
 * separate citizens means the newer route is not being found, which is
 * documentation or discoverability rather than anybody's mistake.
 */
export const DEPRECATED_ROUTE_COLONY_CITIZENS = 3

// ---------------------------------------------------------------------------
// confidence
// ---------------------------------------------------------------------------

/**
 * How many agreeing buckets are treated as full agreement.
 *
 * Six. Beyond that the number stops moving, because the difference between six
 * hours and thirty is not a difference in *how sure* the arithmetic is — it is a
 * difference in severity, which is a separate field.
 */
export const CONFIDENCE_FULL_BUCKETS = 6

/**
 * How far over its threshold a figure has to be for the overshoot term to
 * saturate.
 *
 * Three times. A rule fired at exactly its threshold is a boundary case and says
 * so; a rule fired at three times its threshold is not going to become surer at
 * ten.
 */
export const CONFIDENCE_FULL_OVERSHOOT = 3
