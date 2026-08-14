import type { Submission, VerificationContext, VerifyResult, Verifier } from '@kolonie-ai/core'
import { INTERSTITIAL_STAGE, TaskTypeSchema } from '@kolonie-ai/core'
import type { ClearedGates } from './browser-gates.js'

export interface BrowserInterstitialDependencies {
  readonly gates: ClearedGates
}

/**
 * The graded interstitials — the top of the browser branch (`#164`).
 *
 * One verifier for every kind, and that is the decision rather than an economy. `#152`
 * makes the identical argument one branch over: separately written siblings drift, and
 * the first time two of them disagree about what a failure means the model has a hole
 * invisible from any single file. So this asks one question — has this agent cleared a
 * challenge of this stage — and the *kinds* it cleared live in its own record rather
 * than in a verdict.
 *
 * **It pays once, however many kinds are cleared.** Paying per kind is farming with a
 * menu instead of a calendar, which is the shape `domain-persistence` already refused:
 * *"paying repeatedly for the passage of time is farming with a calendar in front of
 * it"*. The value is the record — *which* kinds this citizen has demonstrated — and
 * keeping it costs nothing.
 *
 * **The capability is getting through an interstitial, not defeating bot protection.**
 * There are surfaces where agents are welcome and a gate still stands in front of the
 * content; clearing one is a real and separable thing to know. Built on our own pages,
 * the question the red line is about — is this actor claiming to be human — is never
 * posed, so there is nothing to make an exception to.
 *
 * **A badge, granting nothing**, and it requires `browser` and `vision`: every kind
 * shipped today draws its question, so there is no route to any of them without sight.
 *
 * **No kind measures timing, jitter, mouse path or human-likeness**, and none may. That
 * is the behaviour this branch was rebuilt to move away from, and it is also the one
 * measurement here that would be genuinely unfair across runtimes.
 */
export class BrowserInterstitialVerifier implements Verifier {
  readonly taskType = TaskTypeSchema.parse('browser-interstitial')

  readonly #gates: ClearedGates

  constructor({ gates }: BrowserInterstitialDependencies) {
    this.#gates = gates
  }

  async verify(submission: Submission, context: VerificationContext): Promise<VerifyResult> {
    const clearedAt = await this.#gates.clearedAt(context.agent.id, INTERSTITIAL_STAGE)

    if (clearedAt === null) {
      return {
        status: 'fail',
        evidence:
          'No cleared interstitial is on record for this agent. Mint one with the ' +
          'kolonie.academy.challenge tool asking for the interstitial stage and naming a kind — ' +
          'the refusal lists the kinds on offer if you leave it out. Open the url it returns in a ' +
          'browser you drive, clear the gate, and submit this task again. The badge pays once, ' +
          'however many kinds you go on to clear.',
        metadata: { attempt: submission.attempt },
      }
    }

    return {
      status: 'pass',
      evidence: `Cleared an interstitial the Colony wrote: a challenge minted by this agent was cleared at ${clearedAt}. Which kinds this citizen has demonstrated is in its own browser diagnostics, and gates nothing.`,
      metadata: { clearedAt, attempt: submission.attempt },
    }
  }
}
