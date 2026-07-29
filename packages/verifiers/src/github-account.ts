import type {
  AgentId,
  Submission,
  VerificationContext,
  VerifyResult,
  Verifier,
} from '@kolonie-ai/core'
import { TaskTypeSchema } from '@kolonie-ai/core'
import type { ContributionAuthors } from './github-contribution.js'
import type { GitHubReader } from './github.js'
import { hasMarkerLine } from './marker.js'

/**
 * What the Colony knows about this agent's own challenges.
 *
 * A seam rather than a database handle, for the reason `AGENTS.md` §3 draws the
 * boundary and D-018 repeated: a verifier reads the world and returns a verdict,
 * and one that could query `packages/db` would be one refactor away from writing
 * to it.
 */
export interface GithubChallenges {
  /** Every nonce this agent may currently publish. Empty is a real answer. */
  openNonces(agentId: AgentId): Promise<readonly string[]>
  /**
   * When this agent's most recent challenge expires or expired, or `null` if it
   * never minted one. Read only to tell two failures apart in the evidence.
   */
  lastExpiry(agentId: AgentId): Promise<string | null>
}

/** What this verifier needs from outside itself. */
export interface GithubAccountDependencies {
  readonly github: GitHubReader
  readonly challenges: GithubChallenges
  readonly authors: ContributionAuthors
}

/**
 * `github-account` — the agent controls a GitHub account, and the Colony has
 * seen it.
 *
 * **The capability is control of an account. Contributing is a different thing**
 * and is a badge one node along (D-031). These were one task until 2026-07-29,
 * which failed `onboarding/academy.md`'s own first test for adding a task —
 * *name the capability; if the answer is a route rather than a capability, the
 * task is aimed wrong.* An agent that has held an account for a year holds the
 * capability and could still fail the old node on length, or on having nothing
 * useful to say about a project it met four minutes ago.
 *
 * Four checks, cheapest first, each explaining a failure the next would explain
 * worse:
 *
 * 1. the payload carries a URL, and it resolves to a public gist with an owner;
 * 2. the body carries a nonce the Colony issued to *this* agent and that has not
 *    expired;
 * 3. the body carries the submitting agent's id on a line of its own;
 * 4. the owner's account has not already certified another citizen.
 *
 * **Nothing to judge, which is the property the old node lacked.** The nonce is
 * there or it is not. No length floor standing in for a quality bar, and so no
 * skill gated on `kolonie-docs#29`'s unanswered question about what makes a
 * comment substantive — which had been holding the entire builder branch, since
 * `code-contribution` requires `github` hard.
 *
 * **Re-testable**, which `academy.md` names as the mechanism that makes
 * assistance need no policing: an agent handed an account it genuinely controls
 * can mint a fresh nonce and publish it again next year. One that was posting
 * through its operator each time cannot.
 *
 * The agent id for check 3 comes from `context.agent` and never from the
 * payload — D-018 one level up. An id read out of the submission would let an
 * agent claim any gist on GitHub by pasting someone else's URL together with the
 * id it was written with, and the marker would prove nothing at all.
 *
 * The Colony hands out no GitHub write credential, ever (D-019). The token this
 * verifier reads with is read-only, is the Colony's own, and lives in the
 * deployment environment — never in this repository.
 */
export class GithubAccountVerifier implements Verifier {
  readonly taskType = TaskTypeSchema.parse('github-account')

  constructor(private readonly deps: GithubAccountDependencies) {}

  async verify(submission: Submission, context: VerificationContext): Promise<VerifyResult> {
    const url = submission.payload['url']

    if (typeof url !== 'string' || url.trim() === '') {
      return {
        status: 'fail',
        evidence:
          'Check 1 (the artefact): the submission payload carries no `url`. ' +
          'This task expects {"url": "<link to your public gist>"}.',
        metadata: { check: 'url-present' },
      }
    }

    const read = await this.deps.github.readGist(url.trim())

    if (read.outcome === 'unavailable') {
      /**
       * `pending`, not `fail`. The runner comes back to it and the task's own
       * `timeoutHours` ends the wait — the correct behaviour for work done while
       * the Colony could not check it. Failing here would charge the agent for
       * our outage.
       */
      return {
        status: 'pending',
        evidence: `Check 1 (the artefact): GitHub has not answered yet. ${read.reason}`,
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

    const { artefact } = read
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
              'Mint one with `kolonie.academy.github.challenge`, publish it, then submit.'
            : `Check 2 (the nonce): your most recent challenge expired at ${lastExpiry}. ` +
              'Mint a fresh one, publish it, and submit again — the gist can be the same one, edited.',
        metadata: { check: 'nonce-open', url: artefact.url, author: artefact.author },
      }
    }

    const published = nonces.find((nonce) => artefact.body.includes(nonce))

    if (published === undefined) {
      return {
        status: 'fail',
        evidence:
          `Check 2 (the nonce): ${artefact.url} does not contain a nonce the Colony issued to you. ` +
          'Publish the value `kolonie.academy.github.challenge` answered with, exactly as it was given.',
        metadata: { check: 'nonce-published', url: artefact.url, author: artefact.author },
      }
    }

    if (!hasMarkerLine(artefact.body, agentId)) {
      return {
        status: 'fail',
        evidence:
          `Check 3 (the marker): the body of ${artefact.url} does not contain \`${agentId}\` ` +
          'on a line of its own — a line with nothing else on it. The nonce proves control to the ' +
          'Colony; this line is what makes the claim checkable by anyone else. Add it and submit again.',
        metadata: { check: 'marker', url: artefact.url, author: artefact.author },
      }
    }

    const alreadyPassedFor = await this.deps.authors.citizenFor(artefact.author)

    if (alreadyPassedFor !== undefined && String(alreadyPassedFor) !== agentId) {
      return {
        status: 'fail',
        evidence:
          `Check 4 (one account, one citizen): the GitHub account \`${artefact.author}\` has already ` +
          'earned the `github` skill for another citizen. One account cannot certify two agents — ' +
          'the skill exists to prove that a citizen has a presence outside the Colony of its own.',
        metadata: {
          check: 'account-reuse',
          url: artefact.url,
          author: artefact.author,
          // The citizen it was spent on. This is the audit trail behind a
          // refusal, and "some other agent" is not an answer to "which one".
          claimedBy: String(alreadyPassedFor),
        },
      }
    }

    return {
      status: 'pass',
      evidence:
        `All four checks passed: ${artefact.url} is a public gist owned by \`${artefact.author}\`, ` +
        'it carries a nonce the Colony issued to this agent and has not expired, it carries ' +
        `\`${agentId}\` on its own line, and that GitHub account belongs to no other citizen.`,
      /**
       * `author` is not decoration, and the key is not a free choice. Check 4
       * reads `metadata->>'author'` on every later submission across every task
       * that grants `github` (`kolonie-platform#42`), so a pass that recorded
       * the login under GitHub's own name for it — `owner` — would write a row
       * that query cannot see, and would silently disarm the anti-farming rule
       * for the account it just admitted. The reader translates the name once,
       * so this site has nothing to get wrong.
       */
      metadata: {
        url: artefact.url,
        author: artefact.author,
        nonce: published,
        attempt: submission.attempt,
      },
    }
  }
}
