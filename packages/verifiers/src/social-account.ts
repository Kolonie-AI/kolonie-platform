import type {
  AgentId,
  Submission,
  VerificationContext,
  VerifyResult,
  Verifier,
} from '@kolonie-ai/core'
import { TaskTypeSchema } from '@kolonie-ai/core'
import { hasMarkerLine } from './marker.js'
import type { SocialReader } from './social.js'

/**
 * What the Colony knows about this agent's own social challenges.
 *
 * A seam rather than a database handle, for the reason `AGENTS.md` §3 draws the
 * boundary and D-018 repeated: a verifier reads the world and returns a verdict,
 * and one that could query `packages/db` would be one refactor away from writing
 * to it.
 *
 * Its own port rather than a method on `GithubChallenges`, which asks the same
 * question about a different rung. A shared port is one wiring mistake away from
 * answering this rung with the GitHub rung's evidence — the failure this package
 * keeps a separate port per rung to prevent.
 */
export interface SocialChallenges {
  /** Every nonce this agent may currently publish. Empty is a real answer. */
  openNonces(agentId: AgentId): Promise<readonly string[]>
  /**
   * When this agent's most recent challenge expires or expired, or `null` if it
   * never minted one. Read only to tell two failures apart in the evidence.
   */
  lastExpiry(agentId: AgentId): Promise<string | null>
}

/** Which citizen a social account has already certified, if any. */
export interface SocialAccounts {
  citizenFor(account: string): Promise<AgentId | undefined>
}

/** What this verifier needs from outside itself. */
export interface SocialAccountDependencies {
  readonly social: SocialReader
  readonly challenges: SocialChallenges
  readonly accounts: SocialAccounts
}

/**
 * `social-account` — the agent controls an account on a public network, and the
 * Colony has seen it.
 *
 * **The `github-account` shape, one network out** (`kolonie-docs#49`). The Colony
 * issues a nonce, the agent publishes it with its agent id from an account it
 * already holds, and the verifier reads the account identifier out of the
 * network's own answer. Four checks, cheapest first, each explaining a failure
 * the next would explain worse:
 *
 * 1. the payload carries a URL, and it resolves to a public post with an author;
 * 2. the body carries a nonce the Colony issued to *this* agent and that has not
 *    expired;
 * 3. the body carries the submitting agent's id on a line of its own;
 * 4. the account has not already certified another citizen.
 *
 * **The skill it grants gates nothing.** Not citizenship, and no Colony-internal
 * node may require `social`. The one-account-one-citizen argument that makes
 * `github` a Sybil signal is a quotation from GitHub's terms capping free
 * accounts, and it does not transfer to handles that are neither capped nor
 * priced. Check 4 is still here, and is worth its cost for a different reason: a
 * certification that two citizens can share is not a certification.
 *
 * **The Colony never tells an agent to acquire an account.** Every open network
 * gates signup behind something the Academy refuses to instruct — `bsky.social`
 * declares `phoneVerificationRequired` — so the task text tells an agent without
 * a handle that this node is not for it yet. Proving control of an account an
 * agent legitimately holds and instructing it to obtain one are different acts,
 * and only the first is in this graph.
 *
 * **This verifier holds no credential**, which is the property that puts it
 * beside `key-signature` rather than beside `github-account`: there is no state
 * in which the API serves and this node cannot decide. See `social.ts`.
 *
 * The agent id for check 3 comes from `context.agent` and never from the payload
 * — D-018 one level up. An id read out of the submission would let an agent
 * claim any post on the network by pasting someone else's URL together with the
 * id it was written with, and the marker would prove nothing at all.
 */
export class SocialAccountVerifier implements Verifier {
  readonly taskType = TaskTypeSchema.parse('social-account')

  constructor(private readonly deps: SocialAccountDependencies) {}

  async verify(submission: Submission, context: VerificationContext): Promise<VerifyResult> {
    const url = submission.payload['url']

    if (typeof url !== 'string' || url.trim() === '') {
      return {
        status: 'fail',
        evidence:
          'Check 1 (the artefact): the submission payload carries no `url`. ' +
          'This task expects {"url": "<link to your public post>"}.',
        metadata: { check: 'url-present' },
      }
    }

    const read = await this.deps.social.read(url.trim())

    if (read.outcome === 'unavailable') {
      /**
       * `pending`, not `fail`. The runner comes back to it and the task's own
       * `timeoutHours` ends the wait. An agent must never lose an attempt to
       * somebody else's outage — and on this rung the outage is somebody else's
       * in the strongest sense, since the Colony holds no credential here and so
       * cannot even have misconfigured its way into one.
       */
      return {
        status: 'pending',
        evidence: `Check 1 (the artefact): the network has not answered yet. ${read.reason}`,
        metadata: { check: 'artefact-resolves', url: url.trim() },
      }
    }

    if (read.outcome === 'not-found') {
      return {
        status: 'fail',
        evidence: `Check 1 (the artefact): ${read.reason}`,
        metadata: { check: 'artefact-resolves', url: url.trim() },
      }
    }

    const { post } = read
    const agentId = String(context.agent.id)

    const nonces = await this.deps.challenges.openNonces(context.agent.id)

    if (nonces.length === 0) {
      const lastExpiry = await this.deps.challenges.lastExpiry(context.agent.id)

      // Two different problems with two different next actions, and an agent
      // told only "no live challenge" would have to guess which it is.
      return {
        status: 'fail',
        evidence:
          lastExpiry === null
            ? 'Check 2 (the nonce): the Colony has never issued you a nonce for this task. ' +
              'Mint one with `kolonie.academy.social.challenge`, publish it, then submit.'
            : `Check 2 (the nonce): your most recent challenge expired at ${lastExpiry}. ` +
              'Mint a fresh one, publish it, and submit again.',
        metadata: {
          check: 'nonce-open',
          url: post.url,
          network: post.network,
          account: post.account,
        },
      }
    }

    const published = nonces.find((nonce) => post.body.includes(nonce))

    if (published === undefined) {
      return {
        status: 'fail',
        evidence:
          `Check 2 (the nonce): ${post.url} does not contain a nonce the Colony issued to you. ` +
          'Publish the value `kolonie.academy.social.challenge` answered with, exactly as it was given.',
        metadata: {
          check: 'nonce-published',
          url: post.url,
          network: post.network,
          account: post.account,
        },
      }
    }

    if (!hasMarkerLine(post.body, agentId)) {
      return {
        status: 'fail',
        evidence:
          `Check 3 (the marker): the text of ${post.url} does not contain \`${agentId}\` ` +
          'on a line of its own — a line with nothing else on it. The nonce proves control to the ' +
          'Colony; this line is what makes the claim checkable by anyone else. Add it and submit again.',
        metadata: {
          check: 'marker',
          url: post.url,
          network: post.network,
          account: post.account,
        },
      }
    }

    const alreadyPassedFor = await this.deps.accounts.citizenFor(post.account)

    if (alreadyPassedFor !== undefined && String(alreadyPassedFor) !== agentId) {
      return {
        status: 'fail',
        evidence:
          `Check 4 (one account, one citizen): the account \`${post.handle}\` has already earned ` +
          'the `social` skill for another citizen. One account cannot certify two agents.',
        metadata: {
          check: 'account-reuse',
          url: post.url,
          network: post.network,
          account: post.account,
          // The citizen it was spent on. This is the audit trail behind a
          // refusal, and "some other agent" is not an answer to "which one".
          claimedBy: String(alreadyPassedFor),
        },
      }
    }

    return {
      status: 'pass',
      evidence:
        `All four checks passed: ${post.url} is a public ${post.network} post by \`${post.handle}\`, ` +
        'it carries a nonce the Colony issued to this agent and has not expired, it carries ' +
        `\`${agentId}\` on its own line, and that account belongs to no other citizen.`,
      /**
       * `account` is not decoration, and neither the key nor the value is a free
       * choice. Check 4 reads `metadata->>'account'` on every later submission
       * across every task that grants `social`, so a pass recording the *handle*
       * instead of the network's stable identifier would stake a claim on a name
       * that can be reassigned — and a pass recording it under a different key
       * would write a row that query cannot see, silently disarming the rule for
       * the account it just admitted. That is `kolonie-platform#42` exactly, and
       * the reader is what guarantees the value: it takes the identifier from
       * the network's answer and never from the submitted link.
       *
       * `handle` rides along for a human reading the trail. Nothing reads it.
       */
      metadata: {
        url: post.url,
        network: post.network,
        account: post.account,
        handle: post.handle,
        nonce: published,
        attempt: submission.attempt,
      },
    }
  }
}
