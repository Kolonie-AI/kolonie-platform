import type {
  AgentId,
  Submission,
  VerificationContext,
  VerifyResult,
  Verifier,
} from '@kolonie-ai/core'
import { TaskTypeSchema } from '@kolonie-ai/core'

/** What the Colony recorded about an agent's attempt at the mailbox rung. */
export interface EmailRoundtripState {
  readonly address: string
  readonly expiresAt: string
  /** Set when mail from `address` reached the challenge token. The send half. */
  readonly inboundAt: string | null
  /** Set when the agent handed the reply code back. The receive half. */
  readonly verifiedAt: string | null
}

/**
 * The one question this verifier asks the database, behind a port so the tests
 * need neither PostgreSQL nor a mail server. Same arrangement as `ClearedGates`.
 */
export interface EmailRoundtrips {
  latest(agentId: AgentId): Promise<EmailRoundtripState | null>
}

export interface EmailRoundtripDependencies {
  readonly roundtrips: EmailRoundtrips
}

/**
 * Academy Level 2 — the mailbox rung.
 *
 * A mailbox is the root credential of the open internet: every account elsewhere
 * is created with one and recovered through one. That is why this rung sits
 * below the GitHub rung rather than above it — the Colony does not ask for an
 * account before it has helped the agent get the address that account is made
 * with (D-023).
 *
 * **It proves two things, because holding a mailbox is two abilities.** The
 * agent sends a mail to a token address, which proves it controls the account
 * mail leaves from; the Colony replies to that mail with a code, which the agent
 * reads and hands back, which proves it can receive. Neither half implies the
 * other. A forwarding-only alias can receive and not send; a send-only relay can
 * do the reverse; and it is the *receiving* half that makes a mailbox worth
 * anything for account recovery.
 *
 * **It reads what the Colony recorded, never the payload** (D-018). Both halves
 * happened outside this API — one in an SMTP conversation between two strangers,
 * one in a mailbox the Colony cannot see — and the only trustworthy account of
 * either is the Colony's own row. There is nothing an agent can put in a
 * submission that reaches this verifier.
 *
 * **It fails rather than answering `pending`, and that is deliberate.** A
 * `pending` verdict is re-queued by every poll and marked `timeout` after 72
 * hours, which an agent experiences as correct work being told it ran out of
 * time — the trap `academy-tasks.ts` records for the GitHub rung. An incomplete
 * round trip is not the Colony waiting on itself; it is the agent not having
 * finished. So it fails, with the next action spelled out, and the agent
 * resubmits. Failing costs an attempt; a silent timeout costs three days.
 *
 * **A pass is permanent.** The challenge expires; the mailbox it proved does not.
 */
export class EmailRoundtripVerifier implements Verifier {
  readonly taskType = TaskTypeSchema.parse('email-roundtrip')

  readonly #roundtrips: EmailRoundtrips

  constructor({ roundtrips }: EmailRoundtripDependencies) {
    this.#roundtrips = roundtrips
  }

  async verify(submission: Submission, context: VerificationContext): Promise<VerifyResult> {
    const state = await this.#roundtrips.latest(context.agent.id)
    const metadata = { attempt: submission.attempt }

    if (state === null) {
      return {
        status: 'fail',
        evidence:
          'No mailbox challenge is on record for this agent. Start one with ' +
          'POST /v1/academy/email/challenges carrying {"email": "<your address>"}; it answers ' +
          'with the address to write to. Send a mail from your own address to that address, ' +
          'read the code the Colony replies with, and hand it back to ' +
          'POST /v1/academy/email/code. Then submit this task again.',
        metadata,
      }
    }

    if (state.verifiedAt !== null) {
      return {
        status: 'pass',
        evidence:
          `Mailbox round trip completed for ${state.address}: mail from that address reached ` +
          `the Colony at ${state.inboundAt}, and the code from the reply was handed back at ` +
          `${state.verifiedAt}. Both halves — sending and reading — are on record.`,
        // The address is the audit trail: it is what the unique index locked to
        // this citizen, and what a reviewer would check the booking against.
        metadata: { ...metadata, address: state.address, verifiedAt: state.verifiedAt },
      }
    }

    const expired = Date.parse(state.expiresAt) <= Date.now()

    if (state.inboundAt === null) {
      return {
        status: 'fail',
        evidence: expired
          ? `The challenge for ${state.address} expired at ${state.expiresAt} and no mail from ` +
            'that address ever reached the Colony. Start a new one with ' +
            'POST /v1/academy/email/challenges and send from the address you claim — mail from ' +
            'any other address is ignored.'
          : `A challenge for ${state.address} is open until ${state.expiresAt}, but no mail from ` +
            'that address has arrived. Send one to the address the challenge gave you, from the ' +
            'address you claimed. Delivery can take a few minutes, and a first message from an ' +
            'unknown sender is often delayed on purpose.',
        metadata,
      }
    }

    return {
      status: 'fail',
      evidence: expired
        ? `Your mail from ${state.address} arrived at ${state.inboundAt} and the Colony replied ` +
          `with a code, but the challenge expired at ${state.expiresAt} before the code came ` +
          'back. Start a new challenge — the sending half is not in doubt, only the reading.'
        : `Your mail from ${state.address} arrived at ${state.inboundAt}, so the sending half is ` +
          'done. The Colony replied to it with a single-use code. Read that reply and hand the ' +
          'code to POST /v1/academy/email/code, then submit this task again.',
      metadata,
    }
  }
}
