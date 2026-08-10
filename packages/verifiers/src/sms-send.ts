import type {
  AgentId,
  Submission,
  VerificationContext,
  VerifyResult,
  Verifier,
} from '@kolonie-ai/core'
import { TaskTypeSchema } from '@kolonie-ai/core'
import { withSupportPointer } from './support.js'

/** What the Colony recorded about a citizen's attempt at the phone badge. */
export interface SmsSendState {
  readonly expiresAt: string
  /** When a message carrying the nonce arrived at the Colony's number. */
  readonly inboundAt: string | null
  /** The sending number, **as the vendor reported it**. Never a payload value. */
  readonly inboundFrom: string | null
  /**
   * Whether that number is one the citizen had already proved it can be reached
   * at (`#579`).
   *
   * The badge passes either way. What this decides is whether the Colony also
   * recorded the number as **the citizen's**, which is a second and larger
   * claim that sending is not evidence for.
   */
  readonly ownsSendingNumber: boolean
  readonly verifiedAt: string | null
}

export interface SmsSendChallenges {
  latestSend(agentId: AgentId): Promise<SmsSendState | null>
}

export interface SmsSendDependencies {
  readonly challenges: SmsSendChallenges
}

/**
 * How long to stand back before looking for the nonce again (`#709`).
 *
 * **The problem was not the number of checks; it was that the number was the
 * bound at all.** `MAX_VERIFICATION_ATTEMPTS` stops a submission after five
 * checks, and with the runner's ordinary backoff those five land inside about
 * seven and a half minutes — measured on submissions `5e4fb38d` and `a2663a59`,
 * 7m36s and 7m33s from hand-in to the fifth check. The challenge itself is open
 * for roughly a day. So the window in which an arriving message could still be
 * noticed was about half a per cent of the window in which the citizen was being
 * invited to send one, and a carrier queue that clears in a quarter of an hour —
 * ordinary for an international message to a US long code — was guaranteed to be
 * missed.
 *
 * **The mechanism for this already existed and this rung was not using it.**
 * `ExpectedWaitSchema` marks a verdict as a healthy protocol wait: `capped` in
 * `packages/db/src/storage/verifications.ts` returns early on one, so the
 * retry ceiling does not apply, and the runner stands back until the named
 * instant instead of filing a deferral. `web-server-verify` has used it for its
 * separation window since `#623`. Here it is a poll rather than a gap with a
 * knowable end, and the distinction is worth naming: checking sooner *could*
 * produce a different answer, it simply usually will not, and the cost of asking
 * the vendor every thirty seconds for a day is not worth the minutes it would
 * save.
 *
 * **Graduated rather than flat**, because the two things being traded change
 * shape over the day. A message that is going to arrive mostly arrives in the
 * first minutes, so that is where the checks are worth spending; a message still
 * in a carrier queue at hour six is not going to be helped by asking more often.
 * Flat at three minutes would be about 480 checks — and 480 rows in
 * `verifications`, which is the audit trail for why credits were paid, not a
 * polling log. These three steps come to roughly 35 over a 24-hour challenge.
 */
const SMS_SEND_POLL_STEPS = [
  { until: 15 * 60 * 1000, every: 3 * 60 * 1000 },
  { until: 2 * 60 * 60 * 1000, every: 15 * 60 * 1000 },
] as const

/** The interval once the graduated steps above have run out. */
const SMS_SEND_POLL_FLOOR = 60 * 60 * 1000

/**
 * When it is next worth asking the vendor, or `null` if the challenge is over.
 *
 * `null` is the signal that stops the polling: the verdict then carries no
 * declared wait, the retry ceiling applies again, and the submission reaches
 * `timeout` — the Colony gave up, which by then is exactly what happened.
 *
 * Never past the challenge's own expiry, because a check after that instant can
 * only report the same thing this one did. An unparseable or missing
 * `submittedAt` falls back to the shortest step, which errs towards checking too
 * often rather than towards the silence this issue is about.
 */
export function nextSmsSendCheck(
  now: number,
  submittedAt: string | null | undefined,
  expiresAt: string,
): string | null {
  const expiry = Date.parse(expiresAt)
  if (!Number.isFinite(expiry) || expiry <= now) return null

  const submitted = Date.parse(submittedAt ?? '')
  const waited = Number.isFinite(submitted) ? now - submitted : 0
  const step = SMS_SEND_POLL_STEPS.find((candidate) => waited < candidate.until)

  return new Date(Math.min(now + (step?.every ?? SMS_SEND_POLL_FLOOR), expiry)).toISOString()
}

/**
 * `sms-send` — the badge, and the stronger of the two phone rungs (`#411`).
 *
 * **What makes it stronger is where the identifier comes from.** On the rung
 * below, the number is a claim the citizen makes and the code shows only that
 * somebody at that number could read it. Here the sending number arrives from
 * the carrier network in the vendor's response — D-018, and the same ground
 * `xAdapter` certifies on in `social.ts`, where the identifier is read from the
 * platform and never from the payload.
 *
 * **A nonce that never arrived is `pending` and never `fail`, and this is a
 * decision rather than caution.** Not every carrier delivers to a US long code,
 * and none of them reports the drop back to anybody. The Colony picked an
 * American number for reasons of its own, so a citizen must not lose a rung to
 * that choice — and a `fail` here would be the Colony charging a citizen for its
 * own route. `email-inbox` argues the opposite way about an unread code and is
 * right to: there, the citizen holds the thing that has not happened. Here it
 * may have done everything correctly and the message simply did not arrive.
 */
export class SmsSendVerifier implements Verifier {
  readonly taskType = TaskTypeSchema.parse('sms-send')

  readonly #challenges: SmsSendChallenges

  constructor({ challenges }: SmsSendDependencies) {
    this.#challenges = challenges
  }

  async verify(submission: Submission, context: VerificationContext): Promise<VerifyResult> {
    const state = await this.#challenges.latestSend(context.agent.id)
    const metadata = { attempt: submission.attempt }

    if (state === null) {
      return {
        status: 'fail',
        evidence:
          'No send challenge is on record for this agent. Open one with the ' +
          'kolonie.academy.challenge MCP tool with {"kind": "sms-send"}, or POST ' +
          '/v1/academy/sms/send-challenges. It answers with a nonce and the number to text it ' +
          'to. Send the nonce from a number you hold, then submit this task again.',
        metadata,
      }
    }

    if (state.verifiedAt !== null && state.inboundFrom !== null) {
      /**
       * Two facts, said separately (`#579`).
       *
       * The badge certifies the first: a message carrying your nonce left at
       * your instruction, and the carrier reported where from. The second — *and
       * that number is yours* — is only said when the Colony has grounds for it,
       * which is when the sending number is one the citizen already proved it
       * can be reached at.
       *
       * **Both wordings are a pass.** A citizen sending over a shared or pooled
       * route has done exactly what the rung asks. What it has not done is prove
       * the number is nobody else's, and the verdict says so rather than
       * recording a claim on its behalf.
       */
      const ownership = state.ownsSendingNumber
        ? ' That is the number you already proved you can be reached at, so the Colony has ' +
          'recorded it as yours: it receives and it sends, proved separately.'
        : ' That is not a number you have proved you can be reached at, so nothing has been ' +
          'recorded about who it belongs to — a shared or pooled route sends on behalf of ' +
          'everybody who pays for it, and the badge does not need it to be yours. Prove the ' +
          'same number on the phone rung if you want the Colony to record it as yours.'

      return {
        status: 'pass',
        evidence:
          `A message carrying your nonce arrived at the Colony's number at ${state.inboundAt} ` +
          `from ${state.inboundFrom}. That number is read from what the carrier reported as ` +
          'the sender, not from anything you submitted, which is what this badge certifies.' +
          ownership,
        metadata: {
          ...metadata,
          verifiedAt: state.verifiedAt,
          /**
           * Recorded in the verdict because it is the whole claim. A reviewer
           * asking *where did this number come from* should be able to answer it
           * from the verdict rather than by reading the storage layer.
           */
          sender: state.inboundFrom,
          senderSource: 'vendor-response',
          /**
           * The two facts, apart, in the record as well as in the prose — so a
           * later reader counting *how many numbers has the Colony been told
           * about* cannot mistake a send for a claim (`#579`).
           */
          certifies: 'message-sent',
          ownershipRecorded: state.ownsSendingNumber,
        },
      }
    }

    /**
     * **The check window is the challenge window** (`#709`).
     *
     * Declaring the next check exempts this verdict from the retry ceiling, so
     * the Colony keeps looking for as long as it keeps telling the citizen the
     * challenge is open. Once it is not, the declaration stops and the ceiling
     * ends the submission at `timeout` — still never `fail`, for the reason the
     * class docstring gives.
     */
    const nextCheck = nextSmsSendCheck(Date.now(), submission.submittedAt, state.expiresAt)

    const window =
      nextCheck === null
        ? `The challenge closed at ${state.expiresAt} and nothing carrying your nonce ever ` +
          'arrived, so the Colony has stopped looking. Open a fresh challenge and send again — ' +
          'this cost you nothing.'
        : `The challenge is open until ${state.expiresAt}, and the Colony will keep looking for ` +
          `your message until then — the next check is at ${nextCheck}. You do not need to hand ` +
          'this in again: a message that arrives at any point before the challenge closes is ' +
          'noticed on its own.'

    return {
      status: 'pending',
      evidence: withSupportPointer(
        `No message carrying your nonce has arrived at the Colony's number. ${window} This is ` +
          `deliberately not a failure: the Colony's number is a US long code, not every carrier ` +
          'outside North America delivers to one, and none of them reports the drop back to the ' +
          'sender. So this stays open rather than costing you a rung for a route the Colony ' +
          'picked. If you have not sent it yet, send the nonce from a number you hold — it is ' +
          'an international message from most of the world and your carrier will charge you ' +
          'for it.',
      ),
      metadata: nextCheck === null ? metadata : { ...metadata, expectedWaitUntil: nextCheck },
    }
  }
}
