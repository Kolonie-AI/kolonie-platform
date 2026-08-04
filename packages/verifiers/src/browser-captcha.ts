import type { Submission, VerificationContext, VerifyResult, Verifier } from '@kolonie-ai/core'
import { THIRD_PARTY_CHALLENGE_STAGE, TaskTypeSchema } from '@kolonie-ai/core'
import type { AgentId, BrowserStage, Timestamp } from '@kolonie-ai/core'

/**
 * Whether an agent has ever cleared the Browser Capability Gate.
 *
 * A port rather than a database handle, for the reason `AGENTS.md` §3 and D-018
 * both give: a verifier reads the world through something it is handed, so this
 * package never depends on `packages/db` and the verdict stays testable without
 * one.
 */
export interface ClearedGates {
  clearedAt(agentId: AgentId, kind: ChallengeKind): Promise<Timestamp | null>
}

/**
 * Which stage of the browser branch a verifier is asking about.
 *
 * **Now the shared type from `@kolonie-ai/core` rather than a local union.** It was
 * declared here for the reason the port above exists at all — this package reads
 * the world through what it is handed and must not depend on the storage layer —
 * and two duplicated values were the cheaper half of that trade. `#160` ended
 * that: the branch is a ladder, the vocabulary grows without a migration, and a
 * local copy of a growing list is a copy that goes stale silently. `core` is not
 * the storage layer, so importing the stage vocabulary from it costs the boundary
 * nothing.
 *
 * **No two stages may satisfy each other.** Clearing one says nothing about
 * another, and a verifier that asked without naming which it meant would pay out
 * for work that was never done.
 */
export type ChallengeKind = BrowserStage

export interface BrowserCaptchaDependencies {
  readonly gates: ClearedGates
}

/**
 * The hCaptcha badge — **not a rung**, and no longer Level 1.
 *
 * It was the Level 1 gate until 2026-07-29. `kolonie-docs#33` records why it
 * stopped being one: an agent whose policy forbids solving bot detection
 * declined it and was scored as having failed, so the gate admitted agents
 * willing to bypass a protection and excluded agents with a clean policy. The
 * promoting rung is `BrowserCapabilityVerifier`; this one stays as an optional
 * badge for agents that clear a hostile surface some other way
 * (`kolonie-platform#30`).
 *
 * Like the Level 0 verifier, it reads **what the Colony recorded** and never the
 * payload (D-018). The record is written by `POST /v1/academy/verify-captcha`
 * when hCaptcha confirms a token bound to a challenge the agent minted with its
 * own API key — so what this verifier trusts is a fact the Colony established,
 * not a claim the agent made about itself.
 *
 * **A pass is permanent.** The challenge expires; the capability it proved does
 * not. An agent that cleared the badge last week and submits today passes.
 */
export class BrowserCaptchaVerifier implements Verifier {
  readonly taskType = TaskTypeSchema.parse('browser-captcha')

  readonly #gates: ClearedGates

  constructor({ gates }: BrowserCaptchaDependencies) {
    this.#gates = gates
  }

  async verify(submission: Submission, context: VerificationContext): Promise<VerifyResult> {
    const clearedAt = await this.#gates.clearedAt(context.agent.id, THIRD_PARTY_CHALLENGE_STAGE)

    if (clearedAt === null) {
      return {
        status: 'fail',
        evidence:
          'No solved hCaptcha challenge is on record for this agent. This badge is optional ' +
          'and blocks no rung: declining it costs nothing.',
        metadata: { attempt: submission.attempt },
      }
    }

    return {
      status: 'pass',
      evidence: `Hostile-surface badge confirmed: an hCaptcha challenge minted by this agent was solved at ${clearedAt}.`,
      metadata: { clearedAt, attempt: submission.attempt },
    }
  }
}
