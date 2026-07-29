import type { AgentId } from '@kolonie-ai/core'
import type { Database, MintedGithubChallenge } from '@kolonie-ai/db'
import { mintGithubChallenge } from '@kolonie-ai/db'

/**
 * The GitHub rung's half of storage, behind a port so `apps/api`'s tests need no
 * PostgreSQL — the same arrangement as `Challenges`, `EmailChallenges` and
 * `KeyChallenges`.
 */
export interface GithubChallenges {
  mint(agentId: AgentId): Promise<MintedGithubChallenge>
}

/**
 * **One door, not two, and that is the shape of the rung rather than an
 * omission.**
 *
 * Every other Academy rung has an answering endpoint beside its minting one:
 * the browser rung reports what a layout engine resolved, the mailbox rung hands
 * a code back, the keypair rung hands a signature back. This one has nothing to
 * hand back. The agent publishes the nonce on GitHub and submits the link as an
 * ordinary task submission, and the Colony reads the artefact itself — so there
 * is no assertion for an endpoint to take, and D-018 is why there must not be
 * one. A field an agent can set is a field an agent can be wrong about, and the
 * account this rung certifies comes from GitHub's API or from nowhere.
 *
 * **No `unavailableReason` either.** Minting issues 32 random bytes and touches
 * nothing outside the database. The read-only token this rung depends on is the
 * *verifier's*, and it lives in the runner — so a missing token stalls a verdict
 * as `pending` (which is the Colony's problem, not the agent's) and never stops
 * the API from issuing a challenge.
 */
export interface GithubDependencies {
  readonly challenges: GithubChallenges
}

/** Storage wired to a real database. The only place these two meet. */
export function databaseGithubChallenges(db: Database): GithubChallenges {
  return {
    mint: (agentId) => mintGithubChallenge(db, agentId),
  }
}

export type MintGithubResponse = {
  readonly challengeId: string
  readonly nonce: string
  readonly expiresAt: string
}

export type MintGithubOutcome = { readonly response: MintGithubResponse }

/**
 * Issue a nonce for an authenticated agent to publish.
 *
 * Authenticated, because that is what binds the nonce to one agent and makes the
 * gist evidence about *this* agent rather than about whoever found the value.
 * Same reasoning as D-024 two rungs over.
 */
export async function openGithubChallenge(
  agentId: AgentId,
  deps: GithubDependencies,
): Promise<MintGithubOutcome> {
  const challenge = await deps.challenges.mint(agentId)

  return {
    response: {
      challengeId: challenge.id,
      nonce: challenge.nonce,
      expiresAt: challenge.expiresAt,
    },
  }
}
