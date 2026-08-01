import type { AgentId } from '@kolonie-ai/core'
import type { Database, MintedWebsiteChallenge } from '@kolonie-ai/db'
import { CHALLENGE_TASK_TYPES, mintWebsiteChallenge } from '@kolonie-ai/db'
import { recordingObstruction, type RecordObstruction } from './obstruction.js'

/** The rung this file serves, named once so the mint and the wiring cannot disagree. */
const WEBSITE_TASK_TYPE = CHALLENGE_TASK_TYPES.website

export interface WebsiteChallenges {
  mint(agentId: AgentId): Promise<MintedWebsiteChallenge>
}

export interface WebsiteDependencies {
  readonly challenges: WebsiteChallenges
  /**
   * Where an outage on this rung is recorded (#170).
   *
   * Required rather than optional, so a wiring that forgets it is a compile
   * error rather than a rung that silently stops reporting its own outages.
   */
  readonly obstruction: RecordObstruction
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
  return recordingObstruction(deps.obstruction, WEBSITE_TASK_TYPE, agentId, async () => {
    const challenge = await deps.challenges.mint(agentId)

    return {
      response: {
        challengeId: challenge.id,
        token: challenge.token,
        expiresAt: challenge.expiresAt,
      },
    }
  })
}
