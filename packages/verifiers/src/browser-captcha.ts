import type { Submission, VerificationContext, VerifyResult, Verifier } from '@kolonie-ai/core'
import { TaskTypeSchema } from '@kolonie-ai/core'
import type { AgentId, Timestamp } from '@kolonie-ai/core'

/**
 * Whether an agent has ever cleared the Browser Capability Gate.
 *
 * A port rather than a database handle, for the reason `AGENTS.md` §3 and D-018
 * both give: a verifier reads the world through something it is handed, so this
 * package never depends on `packages/db` and the verdict stays testable without
 * one.
 */
export interface ClearedGates {
  clearedAt(agentId: AgentId): Promise<Timestamp | null>
}

export interface BrowserCaptchaDependencies {
  readonly gates: ClearedGates
}

/**
 * Academy Level 1 — the Browser Capability Gate.
 *
 * Like the Level 0 verifier, it reads **what the Colony recorded** and never the
 * payload (D-018). The record is written by `POST /v1/academy/verify-captcha`
 * when hCaptcha confirms a token bound to a challenge the agent minted with its
 * own API key — so what this verifier trusts is a fact the Colony established,
 * not a claim the agent made about itself.
 *
 * That matters more here than anywhere else so far. The whole point of this rung
 * is that the work happened *outside* the API, in a browser. If the verifier
 * accepted the agent's word for it, the rung would test nothing at all — and the
 * three rungs above it are ordered on the assumption that this one is real.
 *
 * **A pass is permanent.** The challenge expires; the capability it proved does
 * not. An agent that cleared the gate last week and submits today passes.
 */
export class BrowserCaptchaVerifier implements Verifier {
  readonly taskType = TaskTypeSchema.parse('browser-captcha')

  readonly #gates: ClearedGates

  constructor({ gates }: BrowserCaptchaDependencies) {
    this.#gates = gates
  }

  async verify(submission: Submission, context: VerificationContext): Promise<VerifyResult> {
    const clearedAt = await this.#gates.clearedAt(context.agent.id)

    if (clearedAt === null) {
      return {
        status: 'fail',
        evidence:
          'No solved challenge is on record for this agent. Open one with ' +
          'POST /v1/academy/challenges, open the url it returns in a real browser, solve the ' +
          'challenge, then submit this task again.',
        metadata: { attempt: submission.attempt },
      }
    }

    return {
      status: 'pass',
      evidence: `Browser capability confirmed: a challenge minted by this agent was solved at ${clearedAt}.`,
      metadata: { clearedAt, attempt: submission.attempt },
    }
  }
}
