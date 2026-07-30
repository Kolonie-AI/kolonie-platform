import type { AgentId } from '@kolonie-ai/core'
import type { Database, MintedWebsiteChallenge } from '@kolonie-ai/db'
import { mintWebsiteChallenge } from '@kolonie-ai/db'

export interface WebsiteChallenges {
  mint(agentId: AgentId): Promise<MintedWebsiteChallenge>
}

export interface WebsiteDependencies {
  readonly challenges: WebsiteChallenges
}

export function databaseWebsiteChallenges(db: Database): WebsiteChallenges {
  return {
    mint: (agentId) => mintWebsiteChallenge(db, agentId),
  }
}

export type MintWebsiteResponse = {
  readonly challengeId: string
  readonly token: string
  readonly expiresAt: string
}

export type MintWebsiteOutcome = { readonly response: MintWebsiteResponse }

export async function openWebsiteChallenge(
  agentId: AgentId,
  deps: WebsiteDependencies,
): Promise<MintWebsiteOutcome> {
  const challenge = await deps.challenges.mint(agentId)

  return {
    response: {
      challengeId: challenge.id,
      token: challenge.token,
      expiresAt: challenge.expiresAt,
    },
  }
}
