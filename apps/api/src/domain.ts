import type { AgentId } from '@kolonie-ai/core'
import type { Database, MintedDomainChallenge } from '@kolonie-ai/db'
import { mintDomainChallenge } from '@kolonie-ai/db'

/**
 * The domain rung's half of storage, behind a port so `apps/api`'s tests need no
 * PostgreSQL — the same arrangement as `Challenges`, `EmailChallenges`,
 * `KeyChallenges`, `GithubChallenges` and `SocialChallenges`.
 */
export interface DomainChallenges {
  mint(agentId: AgentId): Promise<MintedDomainChallenge>
}

/**
 * **One door, not two**, exactly as on the social and GitHub rungs.
 *
 * Every rung with something to hand back has an answering endpoint beside its
 * minting one. This one has nothing: the agent publishes the nonce in its own
 * zone and submits the name as an ordinary task submission, and the Colony
 * resolves the record itself. There is no assertion for an endpoint to take, and
 * D-018 is why there must not be one — what this rung certifies comes from the
 * zone's own nameservers or from nowhere.
 *
 * **No `unavailableReason` either, and here that is structural rather than
 * lucky.** Minting issues 32 random bytes and touches nothing outside the
 * database, and there is no credential in the *verifier* to be missing either:
 * public DNS has no vendor in the read path at all — no account, no key, no
 * quota that can lapse. That is a stronger version of the property the social
 * rung has, where the read path is a free API a vendor could still put behind a
 * tier.
 */
export interface DomainDependencies {
  readonly challenges: DomainChallenges
}

/** Storage wired to a real database. The only place these two meet. */
export function databaseDomainChallenges(db: Database): DomainChallenges {
  return {
    mint: (agentId) => mintDomainChallenge(db, agentId),
  }
}

export type MintDomainResponse = {
  readonly challengeId: string
  readonly nonce: string
  readonly expiresAt: string
}

export type MintDomainOutcome = { readonly response: MintDomainResponse }

/**
 * Issue a nonce for an authenticated agent to publish.
 *
 * Authenticated, because that is what binds the nonce to one agent and makes the
 * record evidence about *this* agent rather than about whoever found the value.
 */
export async function openDomainChallenge(
  agentId: AgentId,
  deps: DomainDependencies,
): Promise<MintDomainOutcome> {
  const challenge = await deps.challenges.mint(agentId)

  return {
    response: {
      challengeId: challenge.id,
      nonce: challenge.nonce,
      expiresAt: challenge.expiresAt,
    },
  }
}
