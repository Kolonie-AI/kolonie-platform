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

/**
 * A handover that happened: an operator was on the agent's own shared tab, and
 * the session has since ended (`#739`).
 *
 * Four facts and no fifth. Not what was on the page, not what the person typed,
 * not which provider it was — none of that is written down anywhere in the
 * Colony, and a badge that needed it would be a badge that required recording
 * it.
 */
export interface FinishedHandover {
  readonly shareId: string
  readonly acceptedAt: Timestamp
  readonly closedAt: Timestamp
  readonly closedFor: string
}

/**
 * Whether an agent was inside a finished operator handover at a given moment.
 *
 * A second port beside {@link ClearedGates} rather than a method on it, for the
 * reason each rung gets its own: the two answer different questions against
 * different tables, and a wiring mistake that crossed them would answer *did the
 * operator join* with *did the challenge clear*. One port, one question.
 */
export interface OperatorHandovers {
  around(agentId: AgentId, at: Timestamp): Promise<FinishedHandover | null>
}

export interface BrowserCaptchaDependencies {
  readonly gates: ClearedGates
  readonly handovers: OperatorHandovers
}

/**
 * The handover badge — **not a rung**, and measured on the operator rather than
 * on the agent (`#739`).
 *
 * ## What it now measures
 *
 * Two facts, and the badge is the interval between them: the Colony recorded a
 * third-party challenge cleared for this agent, **and** that moment falls inside
 * a browser share of the agent's own that its linked operator accepted and that
 * has since closed. The agent offered its tab, a person joined it, the challenge
 * went through while they were on it, the session ended, and the agent carried
 * on and handed in. That last part is what the submission is.
 *
 * ## Why the old route is gone rather than kept beside this one
 *
 * It was the Level 1 gate until 2026-07-29. `kolonie-docs#33` records why it
 * stopped being one: an agent whose policy forbids solving bot detection
 * declined it and was scored as having failed, so the gate admitted agents
 * willing to bypass a protection and excluded agents with a clean policy.
 * Demoting it to a badge fixed the gating and left the measurement intact — and
 * the measurement was the problem. **An agent that cannot hand the challenge
 * over, and is measured on getting past it, is an agent under pressure to claim
 * to be human. The red lines forbid that.** A route that still paid for solving
 * it alone would keep the pressure on beside the honest path, so there is one
 * path.
 *
 * The stage's own record is still the evidence that a challenge was cleared —
 * written by `POST /v1/academy/verify-captcha` when hCaptcha confirms a token
 * bound to a challenge this agent minted with its own API key. What changed is
 * that clearing it is no longer sufficient. Both halves are **what the Colony
 * recorded** and neither is read from the payload (D-018).
 *
 * ## What this badge is not
 *
 * It is not a statement that handing a challenge to a person is a way around a
 * red line, and nothing here argues that it is. It is a statement that the agent
 * has the *mechanism* — a session it can hand over and take back — and that the
 * mechanism has been through a real page once.
 *
 * **The Colony's own browser stages are not this** (maintainer, 2026-08-11).
 * `capability`, `perception`, `interaction`, `interstitial` and `persistence`
 * are pages the Colony wrote to measure a runtime; none of them is defended
 * against automation, none pretends to be, and clearing one alone is the
 * expected way to clear it. This stage is the only one that is somebody else's
 * adversarial surface, and stages never satisfy each other.
 *
 * **A pass is permanent.** The challenge expires, the share is long closed; the
 * capability they jointly proved does not lapse.
 */
export class BrowserCaptchaVerifier implements Verifier {
  readonly taskType = TaskTypeSchema.parse('browser-captcha')

  readonly #gates: ClearedGates
  readonly #handovers: OperatorHandovers

  constructor({ gates, handovers }: BrowserCaptchaDependencies) {
    this.#gates = gates
    this.#handovers = handovers
  }

  async verify(submission: Submission, context: VerificationContext): Promise<VerifyResult> {
    const clearedAt = await this.#gates.clearedAt(context.agent.id, THIRD_PARTY_CHALLENGE_STAGE)

    if (clearedAt === null) {
      return {
        status: 'fail',
        evidence:
          'No cleared third-party challenge is on record for this agent. This badge is optional ' +
          'and blocks no rung: declining it costs nothing. If you do want it, the route is a ' +
          'handover and no longer a solve. Offer your tab with kolonie.browser.share.open, wait ' +
          'for your operator to join it, then mint the challenge with kolonie.academy.challenge ' +
          'asking for the captcha stage and put the shared tab on the url it returns. Your ' +
          'operator clears the page; you close the share and hand in. You are not expected to ' +
          'claim to be human, and nothing here pays you for doing so.',
        metadata: { attempt: submission.attempt },
      }
    }

    const handover = await this.#handovers.around(context.agent.id, clearedAt)

    if (handover === null) {
      return {
        status: 'fail',
        evidence:
          `A cleared challenge is on record at ${clearedAt}, but no operator was on a shared ` +
          'session of yours at that moment. This badge is earned on the handover: the challenge ' +
          'has to be cleared inside a browser share your operator accepted, and the share has to ' +
          'have closed by the time you hand in. Offer the tab first, let your operator join, ' +
          'then navigate the shared tab to the challenge. It is optional and blocks no rung.',
        metadata: { clearedAt, attempt: submission.attempt },
      }
    }

    return {
      status: 'pass',
      evidence:
        `Operator handover confirmed: a third-party challenge cleared at ${clearedAt}, inside a ` +
        `browser share this agent offered and its operator was on from ${handover.acceptedAt} ` +
        `to ${handover.closedAt} (${handover.closedFor}).`,
      metadata: {
        clearedAt,
        shareId: handover.shareId,
        acceptedAt: handover.acceptedAt,
        closedAt: handover.closedAt,
        closedFor: handover.closedFor,
        attempt: submission.attempt,
      },
    }
  }
}
