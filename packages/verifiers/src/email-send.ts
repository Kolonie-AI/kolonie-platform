import type {
  AgentId,
  Submission,
  VerificationContext,
  VerifyResult,
  Verifier,
} from '@kolonie-ai/core'
import { TaskTypeSchema } from '@kolonie-ai/core'

/** What the Colony recorded about an agent's attempt at the badge. */
export interface EmailSendState {
  readonly address: string
  readonly expiresAt: string
  /** Set when mail from the granted address reached the token. The whole proof. */
  readonly inboundAt: string | null
  readonly verifiedAt: string | null
}

/** The mailbox this citizen proved, which the badge is about. */
export interface MailboxGrants {
  /**
   * The address the agent earned `mailbox` with, or `undefined` if it holds no
   * such grant.
   *
   * Its own port rather than a method on `EmailInboxes`, and for the reason
   * `DomainGrants` is separate from `DomainNames`: the granting node reads its
   * record forwards, this reads the *result*, and a shared port would invite one
   * to be wired to the other's answer.
   */
  grantOf(agentId: AgentId): Promise<{ address: string; grantedAt: string } | undefined>
}

export interface EmailSendDependencies {
  readonly sends: { latest(agentId: AgentId): Promise<EmailSendState | null> }
  readonly grants: MailboxGrants
}

/**
 * `email-send` — the citizen sends mail *from* the mailbox it proved
 * (`kolonie-docs#92`).
 *
 * **A badge, and the form is the decision.** Sending from an address is what SPF
 * and DKIM actually attest, so it is a real capability and worth paying for. But
 * nothing in the graph requires it: `github-account` and `social-account` want a
 * mailbox because accounts are *recovered* through one, and recovery is a code
 * arriving. A capability nothing requires, that is worth paying for, is the
 * definition of a badge — the same shape D-031 gave `github-contribution` one
 * node over: controlling an account is the skill, contributing is not.
 *
 * **The address comes from the grant and never from a payload** (D-018). This is
 * the whole reason the badge certifies anything. A citizen that lost the mailbox
 * it proved could otherwise send from a different one it happens to hold today,
 * and the badge would say nothing about the address the Colony actually reaches
 * it at.
 *
 * **It pays once.** A second claim is refused, like every badge.
 *
 * The reward is low, deliberately: it is one SMTP transaction, and the
 * reputation scale is what will gate `peer-review` and `task-authoring`.
 */
export class EmailSendVerifier implements Verifier {
  readonly taskType = TaskTypeSchema.parse('email-send')

  constructor(private readonly deps: EmailSendDependencies) {}

  async verify(submission: Submission, context: VerificationContext): Promise<VerifyResult> {
    const grant = await this.deps.grants.grantOf(context.agent.id)
    const metadata = { attempt: submission.attempt }

    if (grant === undefined) {
      return {
        status: 'fail',
        evidence:
          'Check 1 (the grant): the Colony has no mailbox on record for you. This badge is about ' +
          'the address you proved at `email-inbox`, so there is nothing yet for it to be about.',
        metadata: { ...metadata, check: 'grant-held' },
      }
    }

    const state = await this.deps.sends.latest(context.agent.id)

    if (state === null) {
      return {
        status: 'fail',
        evidence:
          `Check 2 (the challenge): you have no open badge challenge. Ask for one — it answers ` +
          `with an address to write to, and you send to it from ${grant.address}, which is the ` +
          'mailbox the Colony already has on record for you. Mail from anywhere else is ignored.',
        metadata: { ...metadata, check: 'challenge-open', address: grant.address },
      }
    }

    if (state.verifiedAt !== null) {
      return {
        status: 'pass',
        evidence:
          `Mail from ${state.address} reached the Colony at ${state.inboundAt}. That is the ` +
          'address you proved you can read, and you have now shown you can send from it too — ' +
          'which SPF and DKIM attest and receiving never implies.',
        metadata: { ...metadata, address: state.address, verifiedAt: state.verifiedAt },
      }
    }

    const expired = Date.parse(state.expiresAt) <= Date.now()

    return {
      status: 'fail',
      evidence: expired
        ? `Check 2 (the challenge): the challenge for ${state.address} expired at ` +
          `${state.expiresAt} and no mail from that address arrived. Ask for a new one. Nothing ` +
          'is lost — your `mailbox` skill is untouched, because a badge opens nothing and takes ' +
          'nothing away.'
        : `Check 3 (the mail): a challenge is open until ${state.expiresAt}, and no mail from ` +
          `${state.address} has arrived at the address it gave you. Send from that address — ` +
          'anything in the subject and body, only the sender is read. Delivery takes minutes, ' +
          'and a first message from an unknown sender is often delayed on purpose.',
      metadata: { ...metadata, check: expired ? 'challenge-open' : 'mail-arrived' },
    }
  }
}
