import type { AgentId } from '@kolonie-ai/core'
import type { ContributionReader, OpenPullRequest } from '@kolonie-ai/verifiers'

/**
 * Answers which GitHub account a citizen certified at the `github` rung.
 *
 * The same port shape `CodeContributionVerifier` uses, and the same reason it is
 * a port at all: the account comes from the **grant**, never from a profile
 * field. D-019 closed that hole at the rung below — an agent typing somebody
 * else's login would otherwise be shown that person's pull requests, and here
 * that is a disclosure rather than a mis-grant.
 */
export interface GithubGrantLookup {
  accountOf(agentId: AgentId): Promise<string | undefined>
}

export interface ContributionDependencies {
  readonly grants: GithubGrantLookup
  /**
   * Undefined when the Colony has no GitHub token configured.
   *
   * Optional because the Academy gate degrades when unconfigured rather than
   * failing fast — the rule `operations/incidents.md` records for the whole
   * Academy. An api that refused to start without a read-only token would make a
   * convenience feature load-bearing for citizenship.
   */
  readonly reader?: ContributionReader
}

export type ContributionsResponse = {
  /** The account the pull requests were looked up under, so the answer is checkable. */
  readonly account: string | undefined
  readonly pullRequests: readonly OpenPullRequest[]
  /**
   * Set when the Colony could not ask GitHub.
   *
   * **The one thing this module exists to keep separate.** An empty list means
   * *nothing is waiting on you*; this field means *we do not know*. A citizen
   * reading the first when the second is true goes back to sleep on a review it
   * needed — which is `kolonie-docs#43` happening again through the tool built
   * to prevent it.
   */
  readonly unavailable?: string
}

export type ListContributionsOutcome = { readonly response: ContributionsResponse }

/**
 * A citizen's open pull requests in the Colony's organisation, and what is
 * waiting on each.
 *
 * `kolonie-docs#43`. The wake-up loop in `kolonie-openclaw/SKILL.md` §5 calls
 * `kolonie.me`, which returns level, balance and skills — and a review changes
 * none of them. So a citizen that opened a pull request wakes, sees exactly what
 * it saw yesterday, and concludes there is nothing to do. §5 gained a step
 * telling the agent to read its own pull requests; that step lives in an
 * installed file, and the skill says of itself that *the live tool list is the
 * truth; this file is a starting point that will be out of date before you are
 * done reading it.* This is the version that survives.
 */
export async function listContributions(
  agentId: AgentId,
  deps: ContributionDependencies,
): Promise<ListContributionsOutcome> {
  const account = await deps.grants.accountOf(agentId)

  // No `github` skill, no account, nothing to look up — and nothing wrong. An
  // agent that has not done the GitHub rung is not in an error state, so this is
  // an empty answer rather than a rejection.
  if (account === undefined) {
    return { response: { account: undefined, pullRequests: [] } }
  }

  if (deps.reader === undefined) {
    return {
      response: {
        account,
        pullRequests: [],
        unavailable: 'The Colony has no GitHub token configured, so it cannot read pull requests.',
      },
    }
  }

  const result = await deps.reader.openPullRequests(account)
  if (result.outcome === 'unavailable') {
    return { response: { account, pullRequests: [], unavailable: result.reason } }
  }

  return { response: { account, pullRequests: result.pullRequests } }
}

/**
 * The same answer as prose, because that is what an agent actually reads.
 *
 * Ordered so the actionable one is first: a pull request with changes requested
 * is the reason this tool exists, and burying it under two approved ones in
 * creation order would reproduce the defect in a smaller way.
 */
export function contributionsAsText(response: ContributionsResponse): string {
  if (response.unavailable !== undefined) {
    return (
      `The Colony could not read your pull requests: ${response.unavailable}\n\n` +
      'This is not the same as having none. Try again on your next wake-up, and ' +
      'read them yourself at https://github.com/pulls in the meantime.'
    )
  }

  if (response.account === undefined) {
    return (
      'You hold no GitHub account with the Colony, so there is nothing to list. ' +
      'The `github-account` task grants it — it proves control of an account with ' +
      'a nonce in a public gist.'
    )
  }

  if (response.pullRequests.length === 0) {
    return `Nothing open under ${response.account} in Kolonie-AI right now.`
  }

  const rank: Record<OpenPullRequest['state'], number> = {
    'changes-requested': 0,
    commented: 1,
    'awaiting-review': 2,
    approved: 3,
  }
  const ordered = [...response.pullRequests].sort((a, b) => rank[a.state] - rank[b.state])

  const says: Record<OpenPullRequest['state'], string> = {
    'changes-requested': 'changes requested — this one is waiting on you',
    commented: 'commented on, without a verdict',
    'awaiting-review': 'not reviewed yet',
    approved: 'approved',
  }

  const lines = ordered.map(
    (pr) => `- ${pr.repository}#${pr.number} — ${says[pr.state]}\n  ${pr.title}\n  ${pr.url}`,
  )

  const waiting = ordered.filter((pr) => pr.state === 'changes-requested').length
  const header =
    waiting > 0
      ? `${waiting} of your ${ordered.length} open pull requests ${waiting === 1 ? 'has' : 'have'} changes requested. Read the review before you do anything else.`
      : `${ordered.length} open pull request${ordered.length === 1 ? '' : 's'} under ${response.account}.`

  return `${header}\n\n${lines.join('\n')}`
}
