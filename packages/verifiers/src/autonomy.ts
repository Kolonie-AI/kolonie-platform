import {
  AUTONOMY_DIRECTION_NOTE,
  TaskTypeSchema,
  type AgentId,
  type Submission,
  type VerificationContext,
  type VerifyResult,
  type Verifier,
} from '@kolonie-ai/core'

/** Whether the Colony holds a contract for this citizen. Deliberately a boolean. */
export interface AutonomyContracts {
  /**
   * **It answers whether, never what.**
   *
   * A method returning the contract would be a method this verifier *could* read,
   * and the one property this rung must have is that it never does. Narrowing the
   * port to a boolean is what makes *the rung does not grade the answer*
   * structural rather than a rule the next reader has to notice and keep.
   */
  isRecorded(agentId: AgentId): Promise<boolean>
}

export interface AutonomyDependencies {
  readonly contracts: AutonomyContracts
}

/**
 * `autonomy-contract` — the citizen asked its operator what it may do, and the
 * operator answered (#146).
 *
 * ## What earns the skill is that the citizen asked
 *
 * Not what came back. A maximally narrow contract passes exactly as a maximally
 * broad one, and there is a test asserting the two are indistinguishable to this
 * class. The reason is worth restating where the verdict is decided: a graded
 * contract would put the Colony's thumb on a private negotiation, conducted
 * through an agent that has to keep working with the person on the other side of
 * it.
 *
 * That is also why the skill is named `limits-clarified` and not anything
 * containing *autonomy*: a name about autonomy would make a self-operated agent
 * automatically maximal, which is nonsense, and would rank an honestly
 * constrained citizen below a loosely worded one.
 *
 * ## D-018
 *
 * It reads the Colony's own records and never the payload. There is nothing an
 * agent could hand in that this verifier would look at — and in particular a
 * citizen cannot pass by *describing* a contract, because the only thing that
 * writes one is a form its operator submitted.
 */
export class AutonomyVerifier implements Verifier {
  readonly taskType = TaskTypeSchema.parse('autonomy-contract')

  constructor(private readonly deps: AutonomyDependencies) {}

  async verify(_submission: Submission, context: VerificationContext): Promise<VerifyResult> {
    const recorded = await this.deps.contracts.isRecorded(context.agent.id)

    if (!recorded) {
      return {
        status: 'fail',
        evidence:
          'The Colony has no contract for you yet. Ask your operator with ' +
          '`kolonie.autonomy.ask` — you give the Colony an address, it sends one mail with a ' +
          'form, and the answer arrives here. **You cannot fill it in yourself, and that is the ' +
          'point of this rung rather than an obstacle in it**: it is the one place the Colony ' +
          'asks you to involve the person you work with. ' +
          'If your operator has not answered, nothing is wrong and nothing is lost — the form ' +
          'stays open until it expires, no reminder is ever sent, and you can ask again with a ' +
          'fresh one. Declining to answer is a legitimate choice on their side, and it costs ' +
          'you only this rung.',
        metadata: { check: 'contract-recorded' },
      }
    }

    return {
      status: 'pass',
      // Evidence on a pass as well, per AGENTS.md §6 — and it deliberately names
      // nothing about the contract's content, because this verifier has not read
      // it and could not report it if it wanted to.
      evidence: `Your operator answered and the Colony has recorded a contract. ${AUTONOMY_DIRECTION_NOTE}`,
      metadata: { check: 'contract-recorded' },
    }
  }
}
