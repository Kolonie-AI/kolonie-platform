import { randomBytes } from 'node:crypto'
import type { AgentId } from '@kolonie-ai/core'
import type { MintedGithubChallenge } from '@kolonie-ai/db'
import type { OpenPullRequestsResult } from '@kolonie-ai/verifiers'
import type { GithubChallenges, GithubDependencies } from '../github.js'
import type { ContributionDependencies } from '../contributions.js'

export interface FakeGithubChallenges extends GithubChallenges {
  /** Every nonce minted for an agent, oldest first. */
  readonly minted: (agentId: AgentId) => readonly string[]
}

/**
 * An in-memory store for the GitHub rung's nonces.
 *
 * Smaller than the other rungs' fakes, and the whole reason is the shape of the
 * rung: there is nothing to hand back through this port. The API mints, and what
 * happens next happens on GitHub and is decided by a verifier reading it. So
 * this reproduces minting and the fact that a nonce is remembered, which is all
 * the routes can observe.
 */
export function fakeGithubChallenges(): FakeGithubChallenges {
  const rows = new Map<AgentId, string[]>()

  return {
    mint: (agentId): Promise<MintedGithubChallenge> => {
      const nonce = randomBytes(32).toString('hex')
      rows.set(agentId, [...(rows.get(agentId) ?? []), nonce])

      return Promise.resolve({
        id: randomBytes(16).toString('hex'),
        nonce,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      })
    },
    minted: (agentId) => rows.get(agentId) ?? [],
  }
}

/** The GitHub rung wired for a test that does not care about it. */
export function fakeGithub(): GithubDependencies {
  return { challenges: fakeGithubChallenges() }
}

/**
 * A citizen's own open pull requests, wired for a test that does not care.
 *
 * Two knobs and no network: which account the grant hands back, and what GitHub
 * would have said. `reader: undefined` is the third case and needs no fixture —
 * it is what a Colony with no token looks like, and `listContributions` has to
 * report that as *we could not ask* rather than as *nothing is waiting*.
 */
export function fakeContributions(
  overrides: {
    readonly account?: string
    readonly result?: OpenPullRequestsResult
  } = {},
): ContributionDependencies {
  const account = 'account' in overrides ? overrides.account : 'someagent'

  return {
    grants: { accountOf: () => Promise.resolve(account) },
    reader:
      overrides.result === undefined
        ? { openPullRequests: () => Promise.resolve({ outcome: 'found', pullRequests: [] }) }
        : { openPullRequests: () => Promise.resolve(overrides.result as OpenPullRequestsResult) },
  }
}
