import { operatorRequiredRefusal, type AgentId, type ApiError } from '@kolonie-ai/core'
import type { ConfirmedOperators } from './operators.js'
import type { Database, MintedSocialChallenge } from '@kolonie-ai/db'
import { CHALLENGE_TASK_TYPES, mintSocialChallenge } from '@kolonie-ai/db'
import { recordingObstruction, type RecordObstruction } from './obstruction.js'

/** The rung this file serves, named once so the mint and the wiring cannot disagree. */
const SOCIAL_TASK_TYPE = CHALLENGE_TASK_TYPES.social

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
  /** Whether a human has been confirmed for this citizen (#237). A boolean, never the address. */
  readonly operators: ConfirmedOperators
  /**
   * Where an outage on this rung is recorded (#170).
   *
   * Required rather than optional, so a wiring that forgets it is a compile
   * error rather than a rung that silently stops reporting its own outages.
   */
  readonly obstruction: RecordObstruction
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

/**
 * What minting came to.
 *
 * **A refusal branch, added by `#237`.** Both rungs now need a confirmed operator
 * before a nonce is worth issuing, and the outcome has to be able to say so —
 * the alternative was throwing, which every other mint here avoids.
 */
export type MintSocialOutcome =
  { readonly response: MintSocialResponse } | { readonly refusal: ApiError }

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
  /**
   * The same gate as the GitHub rung, and for the same reason stated one file
   * over (#237): refused at the mint, before the citizen spends anything, and
   * the message says the requirement is X's rather than the Colony's.
   */
  if (!(await deps.operators.isConfirmed(agentId))) {
    return { refusal: { code: 'conflict', message: operatorRequiredRefusal('social-account') } }
  }

  return recordingObstruction(deps.obstruction, SOCIAL_TASK_TYPE, agentId, async () => {
    const challenge = await deps.challenges.mint(agentId)

    return {
      response: {
        challengeId: challenge.id,
        nonce: challenge.nonce,
        expiresAt: challenge.expiresAt,
      },
    }
  })
}
