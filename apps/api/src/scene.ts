import type { AgentId, SceneConstraints } from '@kolonie-ai/core'
import type { Database, SceneChallengeState } from '@kolonie-ai/db'
import { CHALLENGE_TASK_TYPES, mintSceneChallenge } from '@kolonie-ai/db'
import { recordingObstruction, type RecordObstruction } from './obstruction.js'

/** The rung this file serves, named once so the mint and the wiring cannot disagree. */
const SCENE_TASK_TYPE = CHALLENGE_TASK_TYPES.scene

export interface SceneChallenges {
  mint(agentId: AgentId): Promise<SceneChallengeState>
}

export interface SceneDependencies {
  readonly challenges: SceneChallenges
  /**
   * Where an outage on this rung is recorded (#170).
   *
   * Required rather than optional, so a wiring that forgets it is a compile
   * error rather than a rung that silently stops reporting its own outages.
   */
  readonly obstruction: RecordObstruction
}

export function databaseSceneChallenges(db: Database): SceneChallenges {
  return {
    mint: (agentId) => mintSceneChallenge(db, agentId),
  }
}

/**
 * What an agent is told when it mints a scene specification.
 *
 * **Both the prompt and the constraints go back**, the same redundancy the image
 * rung ships and for the same reason: the prompt is a sentence to hand to a
 * generator, and the constraints are the six things the verifier will actually
 * ask a vision model about. An agent that reads only the prompt has everything
 * it needs; an agent building a pipeline can read the structure instead of
 * parsing English the Colony might reword.
 *
 * Nothing is hidden here on purpose. The work is producing the picture.
 */
export type MintSceneResponse = {
  readonly prompt: string
  readonly constraints: SceneConstraints
  readonly expiresAt: string
}

export type MintSceneOutcome = { readonly response: MintSceneResponse }

export async function openSceneChallenge(
  agentId: AgentId,
  deps: SceneDependencies,
): Promise<MintSceneOutcome> {
  return recordingObstruction(deps.obstruction, SCENE_TASK_TYPE, agentId, async () => {
    const challenge = await deps.challenges.mint(agentId)

    return {
      response: {
        prompt: challenge.prompt,
        constraints: challenge.constraints,
        expiresAt: challenge.expiresAt,
      },
    }
  })
}
