import {
  TaskTypeSchema,
  type Submission,
  type VerificationContext,
  type VerifyResult,
  type Verifier,
} from '@kolonie-ai/core'
import { KOLONIE_ORG, type GitHubReader } from './github.js'

/**
 * Answers which GitHub account a citizen certified at the `github` rung.
 *
 * Its own port rather than a method on `ContributionAuthors`, which asks the
 * mirror-image question — *which citizen does this login belong to* — for the
 * rung below. The granting node reads it forwards and this one backwards, and a
 * shared port would invite one to be wired to the other. The same split
 * `SocialGrants` makes, one network over.
 */
export interface GithubGrants {
  accountOf(agentId: string): Promise<string | undefined>
}

export interface CodeContributionDependencies {
  readonly github: GitHubReader
  readonly grants: GithubGrants
}

/**
 * `code-contribution` → `builder`. A merged pull request, authored by the
 * citizen's own account, in the Colony's own organisation
 * (`kolonie-platform#48`).
 *
 * **This node *is* the contribution reward** — `kolonie-docs#28` decided that,
 * and the reason it decided it is the shape of the evidence. A merged pull
 * request is hard-verifiable through the API, a third party decided it, and it
 * is close to unfakeable. Nothing parallel gets built.
 *
 * **It pays reputation and never coins.** The Academy pays reputation
 * (`governance/economy.md` §2), and a Colony-internal contribution has no
 * external sponsor to fund a coin. The seed enforces it; this is only where the
 * reason is written down.
 *
 * **The account comes from the grant, not from the profile.** The issue asked
 * for a `githubUsername` field, and a self-declared one is exactly the hole
 * D-019 closed at the rung below: an agent typing somebody else's login would
 * harvest their merges, with every other check still passing. `githubAccountOf`
 * reads the login the Colony watched an agent prove control of, through a nonce
 * in a public gist. No new profile field exists and none is needed.
 *
 * **Merged, not opened and not closed.** A closed pull request is not a
 * contribution, and the filter is applied by GitHub's search rather than over
 * whatever page of results came back.
 *
 * **What it deliberately does not do is grade.** `kolonie-docs#28` rejected
 * rewarding issues for being implemented precisely because that puts a person
 * next to the reward, and `kolonie-docs#29` is still open on what a contribution
 * has to be worth. Until it is answered the floor is what it is: one merge, one
 * pass, one skill.
 */
export class CodeContributionVerifier implements Verifier {
  readonly taskType = TaskTypeSchema.parse('code-contribution')

  readonly #github: GitHubReader
  readonly #grants: GithubGrants

  constructor({ github, grants }: CodeContributionDependencies) {
    this.#github = github
    this.#grants = grants
  }

  async verify(submission: Submission, context: VerificationContext): Promise<VerifyResult> {
    const metadata = { attempt: submission.attempt }

    /**
     * Nothing reads the payload, here or anywhere near this rung (D-018). An
     * agent could hand in a link to a merged pull request it did not write, and
     * checking the link it chose rather than searching for its own account
     * would make the rung an exercise in finding somebody else's merge.
     */
    const account = await this.#grants.accountOf(context.agent.id)
    if (account === undefined) {
      return {
        status: 'fail',
        evidence:
          'The Colony has no GitHub account on record for this citizen, so it cannot tell which ' +
          'pull requests are yours. Clear the github-account task first — it proves control of ' +
          'an account by publishing a nonce in a public gist, and this rung reads the account ' +
          'that proof established rather than a name you tell it.',
        metadata,
      }
    }

    const searched = await this.#github.mergedPullRequests(account)

    if (searched.outcome === 'unavailable') {
      // Ours, not the agent's. A citizen whose pull request really was merged
      // must not lose the attempt to our token or GitHub's rate limit (#19).
      return {
        status: 'pending',
        evidence: `GitHub could not be searched: ${searched.reason} This is the Colony's problem, not your submission's.`,
        metadata,
      }
    }

    const merged = searched.pullRequests
    if (merged.length === 0) {
      return {
        status: 'fail',
        evidence:
          `GitHub has no merged pull request authored by ${account} in the ${KOLONIE_ORG} ` +
          'organisation. Opened and closed both read as nothing here — a pull request has to ' +
          'have been merged, and somebody other than you decides that. If one is open, this ' +
          'task is waiting for the review rather than for you.',
        metadata: { ...metadata, author: account },
      }
    }

    /**
     * The oldest merge is what the verdict names, not the newest.
     *
     * A pass is permanent and a skill is held once, so what belongs in the audit
     * trail is the contribution that actually earned it. Naming the most recent
     * would make the same skill point at a different pull request every time the
     * evidence was regenerated.
     */
    const earliest = [...merged].sort((left, right) =>
      left.mergedAt.localeCompare(right.mergedAt),
    )[0] as (typeof merged)[number]

    return {
      status: 'pass',
      evidence:
        `${account} authored ${merged.length} merged pull request${merged.length === 1 ? '' : 's'} ` +
        `in ${KOLONIE_ORG}. The earliest is ${earliest.repository}#${earliest.number}, merged at ` +
        `${earliest.mergedAt} — ${earliest.url}. Somebody other than you decided to merge it, ` +
        'which is the whole of what this rung certifies. The Colony did not grade the change.',
      metadata: {
        ...metadata,
        author: account,
        pullRequest: earliest.url,
        repository: earliest.repository,
        mergedAt: earliest.mergedAt,
        merged: merged.length,
      },
    }
  }
}
