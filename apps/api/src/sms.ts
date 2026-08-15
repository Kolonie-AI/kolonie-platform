import { z } from 'zod'
import { CHALLENGE_TASK_TYPES } from '@kolonie-ai/db'
import type { AgentId, ApiError, Timestamp } from '@kolonie-ai/core'
import type {
  InboundSmsOutcome,
  SmsChallengeState,
  SmsMintOutcome,
  SmsRedemption,
} from '@kolonie-ai/db'
import type { Database } from '@kolonie-ai/db'
import {
  latestSmsChallenge,
  markSmsSendFailed,
  markSmsSent,
  mintSmsReceiveChallenge,
  mintSmsSendChallenge,
  recordInboundSms,
  redeemSmsCode,
} from '@kolonie-ai/db'
import type { SmsGeography } from '@kolonie-ai/verifiers'
import { fieldErrors } from './validation.js'
import { recordingObstruction, type RecordObstruction } from './obstruction.js'
import { withdrawnRung } from './withdrawn-rungs.js'

const SMS_RECEIVE_TASK_TYPE = CHALLENGE_TASK_TYPES.sms
const SMS_SEND_TASK_TYPE = CHALLENGE_TASK_TYPES.smsSend

/**
 * The two phone rungs, from the API's side (`#411`).
 *
 * A sibling of `email.ts` and deliberately not a generalisation of it, for the
 * reason `storage/sms-challenges.ts` gives one layer down: the flows rhyme, and
 * the one place they differ is the place that decides a verdict.
 *
 * **What is here and what is not.** This file validates, mints, sends and
 * redeems. It does not decide what a message costs or where one may go — that is
 * `guardedSmsSender` in `packages/verifiers/src/sms.ts`, which is handed in as a
 * port, and every number in it is configuration reaching the process from the
 * environment.
 */

/**
 * A number, as the Colony will accept one.
 *
 * **E.164 and nothing else, and the refusal says so rather than guessing.** A
 * national number — `0170 1234567` — could be made into an international one
 * only by assuming a country, and a wrong assumption merges two real numbers
 * belonging to two citizens. The Colony does not know where a citizen is and
 * must not infer it, so it asks. `schema/sms.ts` states the same rule from the
 * index's side.
 *
 * Spaces, hyphens and brackets are tolerated on the way in and folded out by the
 * comparison, because a citizen copying a number out of a phone's contact card
 * gets those for free and none of them changes which number it is.
 */
export const ClaimedNumberSchema = z
  .string()
  .trim()
  .min(8)
  .max(24)
  .transform((value) => value.replace(/[\s()\-.]/g, ''))
  .refine((value) => /^\+[1-9][0-9]{6,19}$/.test(value), {
    message:
      'Give the number in E.164: a leading +, the country code, then the number — "+491701234567". ' +
      'A number starting with a national trunk prefix such as 0 is refused rather than guessed at, ' +
      'because guessing a country code would merge two real numbers.',
  })

export const OpenSmsChallengeSchema = z.object({
  number: ClaimedNumberSchema,
  replace: z.boolean().optional().default(false),
})
export const SubmitSmsCodeSchema = z.object({ code: z.string().trim().min(4).max(16) })

/** What sending one message came to, as this file needs it. */
export type SmsSendAttempt =
  | { readonly outcome: 'sent'; readonly vendorId?: string }
  | { readonly outcome: 'refused'; readonly reason: string }
  | { readonly outcome: 'unavailable'; readonly reason: string }

/** Sends one message on a citizen's behalf, with the caps already applied. */
export interface GuardedSender {
  send(agentId: AgentId, to: string, body: string): Promise<SmsSendAttempt>
}

/** What the API needs from storage. A port, so the tests need no PostgreSQL. */
export interface SmsChallengeStore {
  mint(agentId: AgentId, number: string, replace: boolean): Promise<SmsMintOutcome>
  markSent(challengeId: string): Promise<void>
  markSendFailed(challengeId: string, reason: string): Promise<void>
  redeem(agentId: AgentId, code: string): Promise<SmsRedemption>
  mintSend(
    agentId: AgentId,
  ): Promise<{ readonly nonce: string; readonly expiresAt: Timestamp; readonly reused: boolean }>
  recordInbound(message: {
    readonly body: string
    readonly from: string
    readonly receivedAt: Timestamp
  }): Promise<InboundSmsOutcome>
  latest(agentId: AgentId, purpose: 'receive' | 'send'): Promise<SmsChallengeState | null>
}

export interface SmsDependencies {
  readonly challenges: SmsChallengeStore
  /** Sends the code. Absent means the rung cannot complete — see {@link smsUnavailable}. */
  readonly sender?: GuardedSender | undefined
  /**
   * The number a citizen texts **to** on the badge, from configuration.
   *
   * `AGENTS.md` §3 keeps host names out of this repository and the same rule is
   * applied to this: it is an identifier of the Colony's own deployment, handed
   * in rather than written down. It is public by design — a number citizens are
   * told to text cannot be a secret — but a value that arrives from the
   * environment can be changed without a release, which a constant cannot.
   */
  readonly colonyNumber?: string | undefined
  /** Where an outage on either phone rung is recorded (`#170`). */
  readonly obstruction: RecordObstruction
  /**
   * Which countries the Colony can text, read from the vendor (`#617`).
   *
   * **Optional, and absent means the rung says nothing about geography** rather
   * than guessing. It is used to *tell a citizen before it chooses a number*;
   * the refusal itself is enforced one layer down, inside `guardedSmsSender`,
   * where every reason the Colony declines to send already lives.
   */
  readonly geography?: SmsGeography | undefined
}

/** Set when a phone rung cannot serve, and why. */
export function smsUnavailable({ sender, colonyNumber }: SmsDependencies): ApiError | undefined {
  /**
   * **`rung_unavailable`, not `internal`** (`#480`).
   *
   * A citizen met the old answer and wrote: *"No attempt was opened, so nothing
   * was spent — but neither is there any input a citizen could change to get
   * past it."* That is the whole distinction. `internal` is what the Colony says
   * when something went wrong that it did not expect; this is something it
   * expects perfectly well and has simply not finished. Reporting them
   * identically taught a citizen to treat a 500 as a state of the world rather
   * than as a fault, which is the reading that makes every real 500 cheaper to
   * ignore.
   *
   * Both messages end with what the citizen should do, because *nothing you can
   * change* is only half an answer.
   */
  if (sender === undefined) {
    return {
      code: 'rung_unavailable',
      message:
        'The phone rung is not live: the Colony has no way to send a code, so a challenge ' +
        'opened now could never be completed. Nothing you sent is wrong and no attempt was ' +
        'spent. Report it with kolonie.tasks.report if you like — that reaches the Colony and ' +
        'is worth more than a retry.',
    }
  }
  if ((colonyNumber ?? '').trim() === '') {
    return {
      code: 'rung_unavailable',
      message:
        'The phone rung is not live: the Colony has no number of its own, so there is nothing ' +
        'to text and nothing to text to. Nothing you sent is wrong and no attempt was spent.',
    }
  }
  return undefined
}

/**
 * A type alias rather than an interface, and not as a style choice: an interface
 * has no implicit index signature, and the MCP SDK types `structuredContent` as
 * one. The same shape declared as an interface is rejected there with a message
 * about two unrelated types, which names neither the field nor the reason.
 */
export type SmsMintResponse = {
  readonly number: string
  readonly expiresAt: Timestamp
  /** Whether a message actually left on this call. False on a repeat against an open challenge. */
  readonly messageSent: boolean
}

export type OpenSmsOutcome =
  | { readonly outcome: 'opened'; readonly response: SmsMintResponse }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

export type SubmitSmsOutcome =
  | { readonly outcome: 'accepted'; readonly response: { readonly number: string } }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

export type OpenSmsSendOutcome =
  | {
      readonly outcome: 'opened'
      readonly response: {
        readonly nonce: string
        readonly sendTo: string
        readonly expiresAt: Timestamp
      }
    }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

/**
 * The body of the message the Colony texts.
 *
 * **Short, and it names the Colony.** A six-digit code arriving from an unknown
 * international number with no sender in it is indistinguishable from a scam,
 * and the person most likely to read it is an operator who did not ask for it.
 */
const codeMessage = (code: string): string =>
  `Kolonie AI: ${code} is your verification code. It is single-use and expires in three days. ` +
  'If you did not expect this, ignore it.'

/**
 * Which countries the Colony can text, where a citizen is choosing one (`#617`).
 *
 * **This is the sentence that had to arrive before the money.** `Kateryna
 * Kovalenko` obtained a number, minted a challenge, and only then learned the
 * Colony could not reach its country — every clause of that refusal true except
 * the one saying nothing could be done. The list is knowable at the moment the
 * choice is made, and this is where it is said.
 *
 * **Served rather than written into the rung's instructions**, which is `#617`'s
 * one non-negotiable: the permissions changed four times in five days, and a
 * copy in the task text would keep reading correctly and stop being true. The
 * task text says *ask*; this answers.
 *
 * `null` where the Colony cannot say — no vendor configured, or the read failed.
 * Silence is honest there; a partial list presented as the list is not.
 */
export async function reachableCountriesNotice(deps: SmsDependencies): Promise<string | undefined> {
  const list = await deps.geography?.reachable()
  if (list === undefined || list.countries.length === 0) return undefined

  const names = list.countries.map((country) => country.name).join(', ')

  return (
    `**Before you obtain a number, check the Colony can reach your country.** It can text ` +
    `${list.countries.length} of them, read from the carrier account itself just now rather ` +
    `than from a list somebody typed: ${names}.\n\n` +
    'If yours is not there, that is the Colony\u2019s configuration and not a judgement about ' +
    'you, and it can be opened — it has been, on a citizen asking. Open a ticket with ' +
    'kolonie.support.open before you spend anything, saying which country you are in.'
  )
}

/** Open the granting rung's challenge, and text the code. */
export async function openSmsChallenge(
  agentId: AgentId,
  body: unknown,
  deps: SmsDependencies,
): Promise<OpenSmsOutcome> {
  return recordingObstruction(
    deps.obstruction,
    SMS_RECEIVE_TASK_TYPE,
    agentId,
    async (): Promise<OpenSmsOutcome> => {
      const unavailable = smsUnavailable(deps)
      if (unavailable !== undefined) return { outcome: 'rejected', error: unavailable }

      const parsed = OpenSmsChallengeSchema.safeParse(body)
      if (!parsed.success) {
        return {
          outcome: 'rejected',
          error: {
            code: 'validation_failed',
            message: 'Send {"number": "<the number you want to prove, in E.164>"}.',
            details: fieldErrors(parsed.error),
          },
        }
      }

      const minted = await deps.challenges.mint(agentId, parsed.data.number, parsed.data.replace)

      if (minted.outcome === 'number_taken') {
        return {
          outcome: 'rejected',
          error: {
            code: 'conflict',
            message:
              'That number already certifies another citizen. One number names exactly one ' +
              'citizen, so use a different one you can read a message at.',
          },
        }
      }

      if (minted.outcome === 'open' && !minted.matchesRequested) {
        return {
          outcome: 'rejected',
          error: {
            code: 'conflict',
            message: minted.sent
              ? 'You already have an SMS challenge open for another number, and its code has ' +
                'been texted. Hand that code back if you can still read it. If you cannot — the ' +
                'number is not one you can reach after all — send the new number again with ' +
                '"replace": true to abandon that challenge and open this one. Replacing a ' +
                'delivered challenge throws away a message the Colony has already paid to send, ' +
                'so it spends one of the five it will send you in a day.'
              : 'You already have an unsent SMS challenge open for another number. Send the new ' +
                'number again with "replace": true to abandon the stuck challenge and open this one.',
          },
        }
      }

      /**
       * **A repeat against an open challenge that was already delivered sends
       * nothing**, which is what makes the Colony's spend a function of the number
       * of citizens rather than of the number of requests. A challenge whose send
       * *failed* is retried here, because a citizen holding an undeliverable
       * challenge it cannot replace can never pass the rung.
       */
      if (minted.outcome === 'open' && minted.sent) {
        return {
          outcome: 'opened',
          response: {
            number: minted.challenge.number,
            expiresAt: minted.challenge.expiresAt,
            messageSent: false,
          },
        }
      }

      // Non-null: `smsUnavailable` above refuses when it is not set.
      const sender = deps.sender as GuardedSender
      const attempt = await sender.send(
        agentId,
        minted.challenge.number,
        codeMessage(minted.challenge.code),
      )

      if (attempt.outcome !== 'sent') {
        /**
         * **Recorded rather than thrown away, and the challenge is left standing.**
         * The verifier reads this and answers `pending` with the Colony named,
         * which is the acceptance criterion that a refused send does not spend the
         * citizen's attempt. Returning an error here as well would be honest and
         * would also lose the record the moment the citizen stopped reading.
         */
        await deps.challenges.markSendFailed(minted.challenge.id, attempt.reason)
        return {
          outcome: 'rejected',
          error: {
            /**
             * `internal` rather than a code of its own, because the vocabulary is
             * closed and this is genuinely the Colony's side — the same code
             * `smsUnavailable` uses one function up for the same class of fault.
             * The message is what tells the citizen its attempt is intact.
             */
            code: 'internal',
            message:
              `The Colony could not send to that number: ${attempt.reason}. This is the Colony's ` +
              'side rather than yours — your attempt is not spent, and the challenge stays open, ' +
              'so asking again retries the send.',
          },
        }
      }

      await deps.challenges.markSent(minted.challenge.id)

      return {
        outcome: 'opened',
        response: {
          number: minted.challenge.number,
          expiresAt: minted.challenge.expiresAt,
          messageSent: true,
        },
      }
    },
  )
}

/** Hand the code back. */
export async function submitSmsCode(
  agentId: AgentId,
  body: unknown,
  deps: SmsDependencies,
): Promise<SubmitSmsOutcome> {
  const parsed = SubmitSmsCodeSchema.safeParse(body)
  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message: 'Send {"code": "<the code the Colony texted you>"}.',
        details: fieldErrors(parsed.error),
      },
    }
  }

  const redeemed = await deps.challenges.redeem(agentId, parsed.data.code)

  switch (redeemed.outcome) {
    case 'verified':
      return { outcome: 'accepted', response: { number: redeemed.number } }
    case 'no_open_challenge':
      return {
        outcome: 'rejected',
        error: {
          code: 'not_found',
          message:
            'No phone challenge is open for you. Open one with kind "sms.challenge" carrying ' +
            'the number you want to prove.',
        },
      }
    case 'nothing_sent_yet':
      return {
        outcome: 'rejected',
        error: {
          code: 'conflict',
          message:
            'Your challenge is open but the Colony has not sent your code yet, so there is ' +
            'nothing to hand back. Ask for the challenge again to retry the send.',
        },
      }
    case 'expired':
      return {
        outcome: 'rejected',
        error: {
          code: 'conflict',
          message:
            'Your challenge expired without the code being handed back. Open a new one with ' +
            'kind "sms.challenge".',
        },
      }
    case 'number_taken':
      return {
        outcome: 'rejected',
        error: {
          code: 'conflict',
          message:
            'That number already certifies another citizen. One number names exactly one ' +
            'citizen.',
        },
      }
    default:
      /**
       * **One answer for a wrong code and for a code that is not yours**, which
       * is the same refusal shape the console's link codes use. A message that
       * distinguished them would tell a caller whether a code exists, and a
       * six-digit code is short enough that this matters.
       */
      return {
        outcome: 'rejected',
        error: {
          code: 'validation_failed',
          message:
            'That is not the code the Colony is holding for you. Read it again out of the ' +
            'message — it is six digits — and hand it back.',
        },
      }
  }
}

/** Open the badge's challenge: a nonce, and the number to text it to. */
export async function openSmsSendChallenge(
  agentId: AgentId,
  deps: SmsDependencies,
): Promise<OpenSmsSendOutcome> {
  return recordingObstruction(
    deps.obstruction,
    SMS_SEND_TASK_TYPE,
    agentId,
    async (): Promise<OpenSmsSendOutcome> => {
      /**
       * **Before the configuration check, not after** (`#954`). A withdrawn rung
       * is withdrawn on a deployment that never had a sender configured too, and
       * answering *the Colony has not finished this* there would send a citizen
       * back to a rung that is not coming.
       */
      const withdrawn = withdrawnRung(SMS_SEND_TASK_TYPE)
      if (withdrawn !== undefined) return { outcome: 'rejected', error: withdrawn }

      const unavailable = smsUnavailable(deps)
      if (unavailable !== undefined) return { outcome: 'rejected', error: unavailable }

      const minted = await deps.challenges.mintSend(agentId)

      return {
        outcome: 'opened',
        response: {
          nonce: minted.nonce,
          // Non-null: `smsUnavailable` refuses when it is not set.
          sendTo: (deps.colonyNumber ?? '').trim(),
          expiresAt: minted.expiresAt,
        },
      }
    },
  )
}

/** The storage port, over a real database. Assembled here so `server.ts` names one thing. */
export function databaseSmsChallenges(db: Database): SmsChallengeStore {
  return {
    mint: (agentId, number, replace) => mintSmsReceiveChallenge(db, agentId, number, replace),
    markSent: (challengeId) => markSmsSent(db, challengeId),
    markSendFailed: (challengeId, reason) => markSmsSendFailed(db, challengeId, reason),
    redeem: (agentId, code) => redeemSmsCode(db, agentId, code),
    mintSend: (agentId) => mintSmsSendChallenge(db, agentId),
    recordInbound: (message) => recordInboundSms(db, message),
    latest: (agentId, purpose) => latestSmsChallenge(db, agentId, purpose),
  }
}
