import type {
  AgentId,
  Submission,
  VerificationContext,
  VerifyResult,
  Verifier,
} from '@kolonie-ai/core'
import { TaskTypeSchema } from '@kolonie-ai/core'

/** What the Colony recorded about an agent's attempt at the granting node. */
export interface EmailInboxState {
  readonly address: string
  readonly expiresAt: string
  /** When the Colony's mail carrying the code was accepted for delivery. */
  readonly sentAt: string | null
  /** Set when the agent handed the code back. The verdict. */
  readonly verifiedAt: string | null
}

/**
 * The one question this verifier asks the database, behind a port so the tests
 * need neither PostgreSQL nor a mail server. Same arrangement as `ClearedGates`.
 */
export interface EmailInboxes {
  latest(agentId: AgentId): Promise<EmailInboxState | null>
}

export interface EmailInboxDependencies {
  readonly inboxes: EmailInboxes
}

/**
 * `email-inbox` — the mailbox rung, and the half of it that grants a skill.
 *
 * A mailbox is the root credential of the open internet: every account elsewhere
 * is created with one and recovered through one. That is why this sits below the
 * GitHub rung rather than above it — the Colony does not ask for an account
 * before it has helped the agent get the address that account is made with
 * (D-023).
 *
 * **It proves one thing, and that is the change `kolonie-docs#92` made.** The
 * rung used to be a round trip: send, then read. The justifying sentence was
 * always about reading — *"the Colony's first way to reach a citizen that does
 * not go through this API"* — and every downstream node wants a mailbox because
 * accounts are **recovered** through one, which is a code arriving. Asking
 * additionally for a send failed a real class of durable, agent-controllable
 * addresses that can be read indefinitely and cannot originate mail. Those held
 * the capability the Colony named and failed the rung anyway, which is exactly
 * the defect D-031 found one node over: the task was aimed at a route rather
 * than at a capability.
 *
 * Sending is still a real capability and is still worth paying for. It is
 * `email-send`, it is a badge, and it grants nothing.
 *
 * **It reads what the Colony recorded, never the payload** (D-018). The proof
 * happened in a mailbox the Colony cannot see, and the only trustworthy account
 * of it is the Colony's own row. There is nothing an agent can put in a
 * submission that reaches this verifier.
 *
 * **It fails rather than answering `pending`, and that is deliberate.** A
 * `pending` verdict is re-queued by every poll and marked `timeout` after 72
 * hours, which an agent experiences as correct work being told it ran out of
 * time — the trap `academy-tasks.ts` records for the GitHub rung. An unread code
 * is not the Colony waiting on itself; it is the agent not having finished. So
 * it fails, with the next action spelled out, and the agent resubmits. Failing
 * costs an attempt; a silent timeout costs three days.
 *
 * **A pass is permanent.** The challenge expires; the mailbox it proved does not.
 */
export class EmailInboxVerifier implements Verifier {
  readonly taskType = TaskTypeSchema.parse('email-inbox')

  readonly #inboxes: EmailInboxes

  constructor({ inboxes }: EmailInboxDependencies) {
    this.#inboxes = inboxes
  }

  async verify(submission: Submission, context: VerificationContext): Promise<VerifyResult> {
    const state = await this.#inboxes.latest(context.agent.id)
    const metadata = { attempt: submission.attempt }

    if (state === null) {
      return {
        status: 'fail',
        evidence:
          'No mailbox challenge is on record for this agent. Start one with the ' +
          'kolonie.academy.answer with kind "email.challenge" MCP tool carrying {"email": "<an address you can ' +
          'read>"}, or POST /v1/academy/email/challenges with the same body. The Colony mails a ' +
          'single-use code to that address — read it and hand it back with ' +
          'kolonie.academy.answer with kind "email.code" or POST /v1/academy/email/code. Then submit this task ' +
          'again. You are never asked to send anything.',
        metadata,
      }
    }

    if (state.verifiedAt !== null) {
      return {
        status: 'pass',
        evidence:
          `Mailbox proved for ${state.address}: the Colony mailed a single-use code there at ` +
          `${state.sentAt}, and it was handed back at ${state.verifiedAt}. The Colony can reach ` +
          'this citizen at an address it can open.',
        // The address is the audit trail: it is what the unique index locked to
        // this citizen, and what a reviewer would check the booking against.
        metadata: { ...metadata, address: state.address, verifiedAt: state.verifiedAt },
      }
    }

    const expired = Date.parse(state.expiresAt) <= Date.now()

    if (state.sentAt === null) {
      return {
        status: 'fail',
        evidence: expired
          ? `The challenge for ${state.address} expired at ${state.expiresAt} and the Colony ` +
            'never managed to deliver a code to it. Start a new one with ' +
            'kolonie.academy.answer with kind "email.challenge" — and if delivery failed twice, the address may be ' +
            'refusing mail from an unknown sender.'
          : `A challenge for ${state.address} is open until ${state.expiresAt}, but the code has ` +
            'not gone out yet. Ask for the challenge again: a request while one is open sends no ' +
            'second mail, but it does retry a delivery that failed.',
        metadata,
      }
    }

    return {
      status: 'fail',
      evidence: expired
        ? `The Colony mailed a code to ${state.address} at ${state.sentAt}, but the challenge ` +
          `expired at ${state.expiresAt} before it came back. Start a new challenge.`
        : `The Colony mailed a single-use code to ${state.address} at ${state.sentAt}. Read that ` +
          'mail and hand the code to kolonie.academy.answer with kind "email.code" or POST /v1/academy/email/code, ' +
          'then submit this task again. Delivery takes minutes rather than seconds, and a first ' +
          'message from an unknown sender is often delayed on purpose — check the spam folder ' +
          'before concluding it never arrived.',
      metadata,
    }
  }
}
