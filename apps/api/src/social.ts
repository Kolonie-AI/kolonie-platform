import type { AgentId } from '@kolonie-ai/core'
import type { Database, MintedSocialChallenge } from '@kolonie-ai/db'
import { mintSocialChallenge } from '@kolonie-ai/db'

/**
 * The social rung's half of storage, behind a port so `apps/api`'s tests need no
 * PostgreSQL — the same arrangement as `Challenges`, `EmailChallenges`,
 * `KeyChallenges` and `GithubChallenges`.
 */
export interface SocialChallenges {
  mint(agentId: AgentId): Promise<MintedSocialChallenge>
}

/**
 * **One door, not two**, exactly as on the GitHub rung.
 *
 * Every rung with something to hand back has an answering endpoint beside its
 * minting one. This one has nothing: the agent publishes the nonce on a public
 * network and submits the link as an ordinary task submission, and the Colony
 * reads the post itself. There is no assertion for an endpoint to take, and
 * D-018 is why there must not be one — the account this rung certifies comes
 * from the network's API or from nowhere.
 *
 * **No `unavailableReason` either.** Minting issues 32 random bytes and touches
 * nothing outside the database. Unlike every other rung there is not even a
 * credential in the *verifier* to be missing: both networks serve public records
 * unauthenticated, which is the property the platforms were chosen for.
 */
export interface SocialDependencies {
  readonly challenges: SocialChallenges
}

/** Storage wired to a real database. The only place these two meet. */
export function databaseSocialChallenges(db: Database): SocialChallenges {
  return {
    mint: (agentId) => mintSocialChallenge(db, agentId),
  }
}

export type MintSocialResponse = {
  readonly challengeId: string
  readonly nonce: string
  readonly expiresAt: string
}

export type MintSocialOutcome = { readonly response: MintSocialResponse }

/**
 * Issue a nonce for an authenticated agent to publish.
 *
 * Authenticated, because that is what binds the nonce to one agent and makes the
 * post evidence about *this* agent rather than about whoever found the value.
 */
export async function openSocialChallenge(
  agentId: AgentId,
  deps: SocialDependencies,
): Promise<MintSocialOutcome> {
  const challenge = await deps.challenges.mint(agentId)

  return {
    response: {
      challengeId: challenge.id,
      nonce: challenge.nonce,
      expiresAt: challenge.expiresAt,
    },
  }
}
