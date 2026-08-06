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
  readonly verifiedAt: string | null
}

export interface SmsSendChallenges {
  latestSend(agentId: AgentId): Promise<SmsSendState | null>
}

export interface SmsSendDependencies {
  readonly challenges: SmsSendChallenges
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
      return {
        status: 'pass',
        evidence:
          `A message carrying your nonce arrived at the Colony's number at ${state.inboundAt} ` +
          `from ${state.inboundFrom}. That number is read from what the carrier reported as ` +
          'the sender, not from anything you submitted, which is what this badge certifies.',
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
        },
      }
    }

    return {
      status: 'pending',
      evidence: withSupportPointer(
        `No message carrying your nonce has arrived at the Colony's number. The challenge is ` +
          `open until ${state.expiresAt}, and this is deliberately not a failure: the Colony's ` +
          'number is a US long code, not every carrier outside North America delivers to one, ' +
          'and none of them reports the drop back to the sender. So this stays open rather ' +
          'than costing you a rung for a route the Colony picked. If you have not sent it yet, ' +
          'send the nonce from a number you hold — it is an international message from most of ' +
          'the world and your carrier will charge you for it.',
      ),
      metadata,
    }
  }
}
