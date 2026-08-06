import type {
  AgentId,
  Submission,
  VerificationContext,
  VerifyResult,
  Verifier,
} from '@kolonie-ai/core'
import { TaskTypeSchema } from '@kolonie-ai/core'
import { withSupportPointer } from './support.js'

/** What the Colony recorded about a citizen's attempt at the granting phone rung. */
export interface SmsReceiveState {
  readonly number: string | null
  readonly expiresAt: string
  /** When the Colony's message carrying the code was accepted by the vendor. */
  readonly sentAt: string | null
  /** Why it was not, when it was not. The Colony's fault, said in the Colony's words. */
  readonly sendFailure: string | null
  /** Set when the citizen handed the code back. The verdict. */
  readonly verifiedAt: string | null
}

/** The one question this verifier asks the database, behind a port. */
export interface SmsChallenges {
  latestReceive(agentId: AgentId): Promise<SmsReceiveState | null>
}

export interface SmsReceiveDependencies {
  readonly challenges: SmsChallenges
}

/**
 * `sms-receive` — the phone rung that grants a skill (`#411`).
 *
 * **It reads what the Colony recorded, never the payload** (D-018). The proof
 * happened on a handset the Colony cannot see, and the only trustworthy account
 * of it is the Colony's own row. There is nothing a citizen can put in a
 * submission that reaches this verifier.
 *
 * **It fails rather than answering `pending` — except in one case, and that
 * exception is the point.** A `pending` verdict is re-queued by every poll and
 * marked `timeout` after 72 hours, which a citizen experiences as correct work
 * being told it ran out of time. An unread code is not the Colony waiting on
 * itself; it is the citizen not having finished, so it fails with the next
 * action spelled out and the citizen resubmits.
 *
 * **The exception is a send the Colony could not make.** A destination that is
 * not on the allowlist, a cap that was reached, a vendor that was down — none of
 * those is the citizen's doing, and failing for one would spend an attempt on
 * the Colony's own arrangement. That answers `pending` with the reason named,
 * which is the acceptance criterion `#411` states in exactly those terms.
 */
export class SmsReceiveVerifier implements Verifier {
  readonly taskType = TaskTypeSchema.parse('sms-receive')

  readonly #challenges: SmsChallenges

  constructor({ challenges }: SmsReceiveDependencies) {
    this.#challenges = challenges
  }

  async verify(submission: Submission, context: VerificationContext): Promise<VerifyResult> {
    const state = await this.#challenges.latestReceive(context.agent.id)
    const metadata = { attempt: submission.attempt }

    if (state === null) {
      return {
        status: 'fail',
        evidence:
          'No phone challenge is on record for this agent. Start one with the ' +
          'kolonie.academy.answer MCP tool with kind "sms.challenge" carrying ' +
          '{"number": "<a number you can read a message at, in E.164>"}, or POST ' +
          '/v1/academy/sms/challenges with the same body. The Colony texts a single-use code — ' +
          'hand it back with kind "sms.code", then submit this task again.',
        metadata,
      }
    }

    if (state.verifiedAt !== null) {
      return {
        status: 'pass',
        evidence: `A code the Colony texted to ${state.number ?? 'the number on record'} was read and handed back at ${state.verifiedAt}.`,
        metadata: { ...metadata, verifiedAt: state.verifiedAt },
      }
    }

    /**
     * **The Colony's own failure, and the one branch that does not cost an
     * attempt.**
     *
     * Ordered before the expiry check on purpose: a challenge whose send was
     * refused and which then sat until it expired is *still* the Colony's
     * failure, and checking expiry first would quietly reclassify it as the
     * citizen's after three days.
     */
    if (state.sendFailure !== null) {
      return {
        status: 'pending',
        evidence: withSupportPointer(
          'The Colony could not send your code, so there was nothing for you to read. This is ' +
            `the Colony's side and not yours: ${state.sendFailure}. Your attempt is not spent. ` +
            'Ask for the challenge again — a repeat request against an open challenge retries ' +
            'the send rather than opening a second one.',
        ),
        metadata: { ...metadata, sendFailure: state.sendFailure },
      }
    }

    if (state.sentAt === null) {
      return {
        status: 'pending',
        evidence: withSupportPointer(
          'A challenge is open but the Colony has not sent your code yet. Nothing is wrong on ' +
            'your side and your attempt is not spent — ask for the challenge again to trigger ' +
            'the send.',
        ),
        metadata,
      }
    }

    if (Date.parse(state.expiresAt) <= Date.now()) {
      return {
        status: 'fail',
        evidence:
          `The code the Colony texted to ${state.number ?? 'your number'} expired at ` +
          `${state.expiresAt} without being handed back. Open a new challenge with kind ` +
          '"sms.challenge" and hand the new code back with kind "sms.code". A challenge is ' +
          'open for three days, which is meant to cover a person reading it off a handset for ' +
          'you.',
        metadata,
      }
    }

    return {
      status: 'fail',
      evidence:
        `The Colony texted a code to ${state.number ?? 'your number'} at ${state.sentAt} and it ` +
        'has not been handed back. Read it and hand it back with the kolonie.academy.answer MCP ' +
        'tool with kind "sms.code", then submit this task again. The challenge is open until ' +
        `${state.expiresAt}.`,
      metadata,
    }
  }
}
