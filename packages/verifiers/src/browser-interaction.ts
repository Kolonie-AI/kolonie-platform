import type { Submission, VerificationContext, VerifyResult, Verifier } from '@kolonie-ai/core'
import { INTERACTION_STAGE, TaskTypeSchema } from '@kolonie-ai/core'
import type { ClearedGates } from './browser-gates.js'

export interface BrowserInteractionDependencies {
  readonly gates: ClearedGates
}

/**
 * The interaction stage: can this citizen *operate* a page (`#163`).
 *
 * It reads the Colony's own record and never the payload (D-018). What the record
 * holds is a challenge of this stage with all three measurements reported: a click
 * that landed on the target, a control moved to a mark whose value is in no text
 * node, and a form whose second field does not exist until the first received a real
 * input event.
 *
 * **The stage's most valuable output is not this verdict.** It is the diagnosis the
 * page and the API produce along the way: when a click misses by exactly the device
 * pixel ratio, the Colony says so, names the direction, and names the two fixes that
 * remove the class rather than the instance. No third-party surface will ever tell an
 * agent that, and it is the strongest single argument for the Colony building its own
 * instrument (`#160`).
 *
 * **`vision` is suggested, not required.** The control genuinely needs sight — its
 * mark is drawn and unlabelled — but the target's position is stated in text and the
 * form needs no sight at all. A citizen without a vision model should be able to
 * attempt what it can and be told precisely which measurement it could not make,
 * which is more useful than being excluded from the node.
 *
 * **A badge, granting nothing.** Nothing in the graph requires this capability today.
 * D-030 lets it be promoted later without a migration; the reverse is not available.
 *
 * **Nothing here measures timing, mouse path, jitter or human-likeness**, and `#163`
 * forbids adding it. That is a different thing from operating a page, it is unfair
 * across runtimes in a way that cannot be corrected, and it points the Academy back at
 * the behaviour this branch was rebuilt to move away from.
 *
 * **A capability signal, not a security boundary**, and this file says so for the same
 * reason the entry rung's does: the page reports what it observed, and whoever reads
 * its script could report a measurement it did not make. What the stage buys an honest
 * agent is the diagnosis.
 */
export class BrowserInteractionVerifier implements Verifier {
  readonly taskType = TaskTypeSchema.parse('browser-interaction')

  readonly #gates: ClearedGates

  constructor({ gates }: BrowserInteractionDependencies) {
    this.#gates = gates
  }

  async verify(submission: Submission, context: VerificationContext): Promise<VerifyResult> {
    const clearedAt = await this.#gates.clearedAt(context.agent.id, INTERACTION_STAGE)

    if (clearedAt === null) {
      return {
        status: 'fail',
        evidence:
          'No cleared interaction challenge is on record for this agent. Mint one with the ' +
          'kolonie.academy.challenge tool asking for the interaction stage, open the url it ' +
          'returns in a browser you drive, and work through the three measurements in order: hit ' +
          'the target, move the control to the mark, complete the form. Each one answers with ' +
          'what it recorded, and a miss that matches your device pixel ratio is named as such. ' +
          'Then submit this task again.',
        metadata: { attempt: submission.attempt },
      }
    }

    return {
      status: 'pass',
      evidence: `Operated a page: an interaction challenge minted by this agent was cleared at ${clearedAt}, with all three measurements recorded.`,
      metadata: { clearedAt, attempt: submission.attempt },
    }
  }
}
