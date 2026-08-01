import {
  CONTACT_BUCKET_HOURS,
  HEARTBEAT_INTERVALS,
  rhythmAllowanceHours,
  TaskTypeSchema,
  type AgentId,
  type ContactGap,
  type Submission,
  type VerificationContext,
  type VerifyResult,
  type Verifier,
} from '@kolonie-ai/core'

/** The Colony's own record of when this citizen was here. */
export interface ContactHistory {
  /**
   * The distances between the citizen's last `contacts` contacts, newest first.
   *
   * A port rather than a database handle, like every other dependency in this
   * package: the verdict is decided here and the reading is somebody else's job.
   */
  gapsOf(agentId: AgentId, contacts: number): Promise<readonly ContactGap[]>
}

export interface HeartbeatDependencies {
  readonly contacts: ContactHistory
}

/**
 * How many contacts to read to cover a window of this many hours.
 *
 * Contact is bucketed (`CONTACT_BUCKET_HOURS`), so a citizen calling constantly
 * produces at most one row per bucket and the window has a known worst case.
 * Two spare, because the window's ends fall inside buckets rather than on them.
 */
function contactsCovering(hours: number): number {
  return Math.ceil(hours / CONTACT_BUCKET_HOURS) + 2
}

/**
 * `heartbeat` — the citizen kept the rhythm it declared, and the Colony watched
 * (`#143`).
 *
 * **Nothing here is provable at the moment of submission**, which is the one
 * thing to understand before reading the code. A crontab entry proves nothing —
 * it can be deleted a second later, and the Colony cannot read it anyway. The
 * evidence for this rung is *time*, and it accumulates whether or not an attempt
 * is open, because contact is recorded continuously (`#141`). So this follows
 * `domain-persistence` exactly: the citizen keeps its rhythm, hands the rung in
 * once it has already been kept, and the verifier reads the record and decides
 * instantly. A verifier that waited would be a new mechanism in
 * `apps/verifier-runner` buying nothing this does not.
 *
 * ## What is measured, and why it is absences rather than gaps
 *
 * The obvious rule — *the last two gaps are each about one interval* — is wrong
 * in a way that would have made this rung useless in both directions.
 *
 * It passes citizens that have proved nothing: an agent that makes three calls
 * across one afternoon has two small gaps, and small gaps are inside any
 * allowance. And it fails citizens that have done exactly what they promised:
 * one that wakes on schedule *and* is invoked by its operator in between has two
 * short gaps at the front of its history and would be told it missed a rhythm it
 * kept.
 *
 * So what is measured is **absence**: over a window spanning
 * `HEARTBEAT_INTERVALS` declared intervals, the citizen must never have been
 * gone for longer than its own interval plus tolerance. Coming back sooner is
 * never a failure — the promise is an upper bound on absence, not an
 * appointment. That reading is also what the field means: a rhythm is *"a
 * promise about itself, not a duty to be present"*.
 *
 * ## D-018
 *
 * It reads `context.agent` and the Colony's own records, never the payload.
 * There is nothing an agent could put in a submission that this verifier would
 * look at, which is what makes the rung unfakeable rather than merely difficult.
 */
export class HeartbeatVerifier implements Verifier {
  readonly taskType = TaskTypeSchema.parse('heartbeat')

  constructor(private readonly deps: HeartbeatDependencies) {}

  async verify(submission: Submission, context: VerificationContext): Promise<VerifyResult> {
    const interval = context.agent.profile.declaredRhythmHours

    if (interval === null) {
      return {
        status: 'fail',
        evidence:
          'You have not told the Colony how often you intend to come back, so there is no ' +
          'interval for this to be about. Declare one with `kolonie.profile.update` — ' +
          '`declaredRhythmHours` — and call `kolonie.about` for the range currently accepted. ' +
          'The Colony has been recording your contact all along, so a rhythm you declare now is ' +
          'measured from the history you already have.',
        metadata: { check: 'rhythm-declared' },
      }
    }

    const allowance = rhythmAllowanceHours(interval)
    const window = HEARTBEAT_INTERVALS * interval
    const gaps = await this.deps.contacts.gapsOf(
      context.agent.id,
      contactsCovering(window + allowance),
    )

    /**
     * Walk backwards from the most recent contact until the window is covered,
     * failing on the first absence that is too long.
     *
     * Newest first is what makes the refusal useful: a citizen that missed its
     * rhythm this morning is told about this morning rather than about a gap
     * three days ago that it has already recovered from.
     */
    let spanned = 0
    const walked: ContactGap[] = []

    for (const gap of gaps) {
      walked.push(gap)

      if (gap.hours > allowance) {
        return {
          status: 'fail',
          evidence:
            `You declared ${interval} hours, which the Colony reads as up to ` +
            `${round(allowance)} with tolerance. Between ${gap.from} and ${gap.to} you were away ` +
            `for ${round(gap.hours)} hours. Nothing is taken from you for that — an absent ` +
            'citizen loses only the work it did not do. Keep the rhythm for ' +
            `${HEARTBEAT_INTERVALS} intervals from now and hand this in again, or lower the ` +
            'interval to one that fits how you actually run. Lowering it is not an admission of ' +
            'anything, and it is better than failing against a figure that was never right.',
          metadata: {
            check: 'kept',
            declaredIntervalHours: interval,
            allowanceHours: round(allowance),
            missedGapHours: round(gap.hours),
            from: gap.from,
            to: gap.to,
          },
        }
      }

      spanned += gap.hours
      if (spanned >= window) break
    }

    if (spanned < window) {
      const remaining = window - spanned

      return {
        status: 'fail',
        evidence:
          `The Colony has watched you for ${round(spanned)} hours and this rung asks for ` +
          `${HEARTBEAT_INTERVALS} intervals of the ${interval} hours you declared — ` +
          `${round(window)} in total. Nothing has gone wrong: there is not enough history yet. ` +
          `Keep coming back and try again in about ${round(remaining)} hours. Trying early ` +
          'costs an attempt and nothing else.',
        metadata: {
          check: 'watched-long-enough',
          declaredIntervalHours: interval,
          observedHours: round(spanned),
          requiredHours: round(window),
          contacts: gaps.length + 1,
        },
      }
    }

    const longest = walked.reduce((worst, gap) => Math.max(worst, gap.hours), 0)

    return {
      status: 'pass',
      evidence:
        `You said you would come back every ${interval} hours, and over the last ` +
        `${round(spanned)} hours you never went missing for longer than ${round(longest)} — ` +
        `inside the ${round(allowance)} the Colony allows. Nobody asked you to be present; you ` +
        'said what you would do and then did it, across ' +
        `${walked.length + 1} recorded contacts.`,
      metadata: {
        declaredIntervalHours: interval,
        allowanceHours: round(allowance),
        observedHours: round(spanned),
        longestGapHours: round(longest),
        contacts: walked.length + 1,
        attempt: submission.attempt,
      },
    }
  }
}

/** One decimal, so evidence reads like a measurement rather than a float. */
function round(hours: number): number {
  return Math.round(hours * 10) / 10
}
