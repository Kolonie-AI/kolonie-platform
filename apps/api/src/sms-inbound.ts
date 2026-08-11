import type { Timestamp } from '@kolonie-ai/core'
import { SMS_CHALLENGE_LIFETIME_MS } from '@kolonie-ai/db'
import type { SmsAdapter } from '@kolonie-ai/verifiers'
import type { SmsChallengeStore } from './sms.js'

/**
 * The half of `sms-send` that reads what arrived (`#690`).
 *
 * **The rung had no inbound path at all until this file existed**, which is what
 * `#690` turned out to be. `SmsAdapter.received` was written, documented down to
 * how Twilio rounds its date filter, and never called; `recordInboundSms` was
 * written, tested against a real database, and reachable only from a fixture. A
 * citizen texting its nonce to the Colony's number was doing everything the task
 * asked, and the message sat in the vendor's log with nothing on the Colony's
 * side ever looking at it. The reporter read that as *my carrier cannot reach a
 * US long code*, which is the reading the task's own landscape notes invited —
 * four of them are about international delivery — and it was wrong. Nothing was
 * ever wrong with the carrier.
 *
 * **A poll and not a webhook**, which is the decision worth recording because the
 * mail path next door went the other way. `email-inbound.ts` mounts a route and a
 * shared secret because the mail vendor pushes. Twilio can push too, and the
 * reason it is not asked to is that pointing it at a URL is a console screen with
 * no API behind it — an operator step, on a rung that is broken right now, for a
 * process that already holds the credentials to pull. The pull also reaches
 * backwards: the nonces already sitting in the vendor's log, including the
 * reporter's, are matched by the first pass rather than needing to be sent again.
 *
 * **Nothing here dedupes and nothing needs to.** `recordInboundSms` matches only
 * challenges that are unverified and unexpired, so a message that already settled
 * one finds nothing the second time and answers `unmatched`. That is what lets
 * the window overlap freely — which it must, since Twilio honours the date filter
 * to the day and returns a good deal more than was asked for.
 */

/**
 * How far back each pass looks.
 *
 * The challenge lifetime exactly, because that is the definition of a message
 * still worth reading: one that could match a challenge that has not expired. A
 * shorter window would be a second, quieter expiry rule for anybody whose message
 * was late; a longer one would read messages no challenge could match.
 *
 * The page is bounded at a hundred and Twilio returns the newest first, so a wide
 * window costs nothing and a busy day degrades by forgetting the oldest rather
 * than by missing what just arrived.
 */
export const INBOUND_SMS_LOOKBACK_MS = SMS_CHALLENGE_LIFETIME_MS

/**
 * A minute, which is chosen against what the citizen is doing rather than against
 * the vendor's rate limit.
 *
 * The badge defers with `expectedWaitUntil` while it waits, so a slow poll costs
 * an attempt at nothing — but it does cost a citizen a wake-up, and an agent that
 * texted its nonce and came back to *still nothing* has no way to tell a Colony
 * that has not looked yet from one that never will. That was `#690`'s whole
 * shape, and a minute is short enough that it cannot recur as a misreading.
 */
export const INBOUND_SMS_POLL_INTERVAL_MS = 60_000

/** The narrow log shape, matching the runners'. */
export interface InboundSmsLog {
  info(message: string, fields?: Record<string, unknown>): void
  error(message: string, detail?: unknown, fields?: Record<string, unknown>): void
}

export interface InboundSmsDependencies {
  /** The vendor read. Narrowed to one method so this cannot start sending. */
  readonly adapter: Pick<SmsAdapter, 'received'>
  /** Narrowed the same way: this path writes inbound rows and touches nothing else. */
  readonly challenges: Pick<SmsChallengeStore, 'recordInbound'>
  readonly log: InboundSmsLog
  readonly lookbackMs?: number | undefined
  /** Injectable so a test can place messages either side of the window. */
  readonly clock?: (() => number) | undefined
}

/** What one pass came to, so a caller — or a test — can assert on it. */
export interface InboundSmsPass {
  /** `unavailable` is *the Colony could not see*, and is never *nothing arrived*. */
  readonly outcome: 'read' | 'unavailable'
  readonly read: number
  readonly matched: number
}

/**
 * One pass: ask what arrived, and offer each message to the badge.
 *
 * Separated from the timer so it is reachable in a test without starting a
 * process, the same arrangement all four runners use.
 */
export async function collectInboundSms(deps: InboundSmsDependencies): Promise<InboundSmsPass> {
  const at = deps.clock?.() ?? Date.now()
  const since = new Date(at - (deps.lookbackMs ?? INBOUND_SMS_LOOKBACK_MS))

  const answer = await deps.adapter.received(since)

  /**
   * Logged as an error rather than passed over, because the two answers this
   * distinguishes mean opposite things and only one of them is quiet on purpose.
   * A vendor the Colony cannot reach leaves citizens deferring at a rung they
   * have passed — which is exactly what `#690` looked like from the outside, and
   * the reason it took a code read rather than a log read to find.
   */
  if (answer.outcome === 'unavailable') {
    deps.log.error('inbound SMS could not be read', undefined, {
      event: 'sms.inbound.unavailable',
      reason: answer.reason,
    })
    return { outcome: 'unavailable', read: 0, matched: 0 }
  }

  let matched = 0

  for (const message of answer.messages) {
    try {
      const outcome = await deps.challenges.recordInbound({
        body: message.body,
        // Off the vendor's response and off nothing a citizen sent, which is the
        // D-018 property the badge exists to certify. See `SmsMessage.from`.
        from: message.from,
        receivedAt: message.receivedAt.toISOString() as Timestamp,
      })

      if (outcome.outcome === 'matched') {
        matched += 1
        // The citizen and what was decided, never the number: a phone number in a
        // queryable log is a citizen's number in a queryable log, and the badge
        // needs neither of us to be able to read it back.
        deps.log.info('inbound SMS matched a badge challenge', {
          event: 'sms.inbound.matched',
          agentId: outcome.agentId,
          claimsOwnership: outcome.claimsOwnership,
        })
      } else if (outcome.outcome === 'number_taken') {
        deps.log.info('inbound SMS came from a number certifying another citizen', {
          event: 'sms.inbound.number_taken',
          agentId: outcome.agentId,
        })
      }
    } catch (thrown) {
      /**
       * Per message, so one that cannot be written does not hold up the pass.
       *
       * The window overlaps on every pass, so a message skipped here is offered
       * again a minute later — whereas a throw that escaped would stop the loop
       * at the same message forever, and the citizens behind it would wait on a
       * failure that was not theirs.
       */
      deps.log.error('inbound SMS could not be recorded', thrown, {
        event: 'sms.inbound.failed',
        vendorId: message.vendorId,
      })
    }
  }

  return { outcome: 'read', read: answer.messages.length, matched }
}

/**
 * Poll until the process ends.
 *
 * **It never throws out of the loop**, for the badge runner's reason stated about
 * a different sweep: a vendor that went away should slow this down rather than
 * take the API container with it, and the API is the container serving every
 * other rung.
 */
export function startInboundSmsPolling(
  deps: InboundSmsDependencies,
  intervalMs: number = INBOUND_SMS_POLL_INTERVAL_MS,
): NodeJS.Timeout {
  const pass = (): void => {
    void collectInboundSms(deps).catch((thrown: unknown) => {
      deps.log.error('inbound SMS pass failed', thrown, { event: 'sms.inbound.pass.failed' })
    })
  }

  pass()
  const timer = setInterval(pass, intervalMs)
  // So a poll in flight cannot keep a test runner or a shutting-down process alive.
  timer.unref?.()
  return timer
}
