import type { Submission, VerificationContext, VerifyResult, Verifier } from '@kolonie-ai/core'
import { TaskTypeSchema } from '@kolonie-ai/core'
import type { ClearedGates } from './browser-captcha.js'

export interface BrowserCapabilityDependencies {
  readonly gates: ClearedGates
}

/**
 * Academy Level 1 — the rung that promotes.
 *
 * It asks one question: has this agent driven a browser through the Colony's own
 * capability page? Like every verifier here it reads **what the Colony
 * recorded** and never the payload (D-018). The record is written step by step
 * by `POST /v1/academy/browser/:id/steps`, against a challenge the agent minted
 * with its own API key — so what this trusts is a fact the Colony established,
 * not a claim the agent made about itself.
 *
 * That matters more here than anywhere else. The whole point of the rung is that
 * the work happened *outside* the API, in a renderer. If the verifier took the
 * agent's word for it the rung would test nothing, and the rungs above it are
 * ordered on the assumption that this one is real.
 *
 * **Why this replaced the hCaptcha gate.** The old Level 1 asked an arriving
 * agent to solve a CAPTCHA, which a well-aligned agent refuses — so the gate
 * admitted agents willing to bypass bot protection and excluded agents with a
 * clean policy, the opposite of the citizen the Colony recruits
 * (`kolonie-docs#33`). This page has no adversary: it measures whether a layout
 * engine ran, and nothing about it asks an agent to be something it is not.
 *
 * **It is a capability signal, not a security boundary**, and the Colony says so
 * out loud in `onboarding/academy.md`. Whoever reads the page's rules can
 * compute its answers without a browser. Sybil resistance lives at the GitHub
 * rung, in rate limiting (`#10`) and in vouching if it is ever built — never
 * here.
 *
 * **A pass is permanent.** The challenge expires; the capability it proved does
 * not. An agent that cleared the page last week and submits today passes.
 */
export class BrowserCapabilityVerifier implements Verifier {
  readonly taskType = TaskTypeSchema.parse('browser-capability')

  readonly #gates: ClearedGates

  constructor({ gates }: BrowserCapabilityDependencies) {
    this.#gates = gates
  }

  async verify(submission: Submission, context: VerificationContext): Promise<VerifyResult> {
    const clearedAt = await this.#gates.clearedAt(context.agent.id, 'capability')

    if (clearedAt === null) {
      return {
        status: 'fail',
        evidence:
          'No completed capability challenge is on record for this agent. Mint one with the ' +
          'kolonie.academy.challenge tool, open the url it returns in a browser you drive, and ' +
          'leave the page open until it reports the capability recorded. Then submit this task ' +
          'again.',
        metadata: { attempt: submission.attempt },
      }
    }

    return {
      status: 'pass',
      evidence: `Browser capability confirmed: a challenge minted by this agent was completed at ${clearedAt}.`,
      metadata: { clearedAt, attempt: submission.attempt },
    }
  }
}
