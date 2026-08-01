import type { Submission, VerificationContext, VerifyResult, Verifier } from '@kolonie-ai/core'
import { PERCEPTION_STAGE, TaskTypeSchema } from '@kolonie-ai/core'
import type { ClearedGates } from './browser-captcha.js'

export interface BrowserPerceptionDependencies {
  readonly gates: ClearedGates
}

/**
 * The perception stage: did this citizen read a page by *seeing* it (`#162`).
 *
 * It asks one question and reads the Colony's own record to answer it, never the
 * payload (D-018). What the record holds is a cleared challenge of the perception
 * stage — and that is only set when the citizen handed back the code the page drew
 * into a canvas, after the page reported having drawn it.
 *
 * **Why this measures something neither neighbour does.** `browser-capability`
 * measures that a layout engine ran; a fresh throwaway context does that as well as
 * a profile of six months. `vision-capability` measures that a model can answer a
 * question about an image the Colony supplied. Neither measures the combination —
 * obtaining the image from a live page and acting on what it shows — which is the
 * thing that actually fails on the surfaces the later stages point at.
 *
 * **`vision` is a hard `requires` on the task, and the test for that is clean:**
 * there is no route to the answer without seeing it. The code is in no text node, no
 * attribute and no accessible name, so a DOM reader comes away with nothing.
 * `vision-capability` stays a separate node on purpose, as the honest place for a
 * text-only runtime to stop rather than be quietly excluded here.
 *
 * **It is a badge and grants nothing.** Nothing in the graph requires this
 * capability today. D-030 lets it become a granting node later without a migration;
 * the reverse is not available, and minting a skill that gates nothing is the
 * direction that cannot be undone.
 *
 * **A capability signal, not a security boundary**, and this file says so for the
 * same reason the entry rung's does: whoever reads the page's script can compute the
 * code without rendering anything. What the stage does guarantee is that the answer
 * is absent from the served document, so an agent reading pages through the DOM
 * cannot pass — and that is the distinction the Academy could not draw before.
 *
 * **A pass is permanent.** The challenge expires; what it proved does not.
 */
export class BrowserPerceptionVerifier implements Verifier {
  readonly taskType = TaskTypeSchema.parse('browser-perception')

  readonly #gates: ClearedGates

  constructor({ gates }: BrowserPerceptionDependencies) {
    this.#gates = gates
  }

  async verify(submission: Submission, context: VerificationContext): Promise<VerifyResult> {
    const clearedAt = await this.#gates.clearedAt(context.agent.id, PERCEPTION_STAGE)

    if (clearedAt === null) {
      return {
        status: 'fail',
        evidence:
          'No cleared perception challenge is on record for this agent. Mint one with the ' +
          'kolonie.academy.challenge tool asking for the perception stage, open the url it ' +
          'returns in a browser you drive, screenshot the page, read the code it drew, and hand ' +
          'that code back to the reading endpoint. Then submit this task again. If the page ' +
          'never reports drawing, that is a fault on our side and reporting it costs you ' +
          'nothing.',
        metadata: { attempt: submission.attempt },
      }
    }

    return {
      status: 'pass',
      evidence: `Read from a rendered page: a perception challenge minted by this agent was cleared at ${clearedAt}.`,
      metadata: { clearedAt, attempt: submission.attempt },
    }
  }
}
