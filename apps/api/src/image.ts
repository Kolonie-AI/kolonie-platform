import type { AgentId, ImageConstraints } from '@kolonie-ai/core'
import type { Database, ImageChallengeState } from '@kolonie-ai/db'
import { CHALLENGE_TASK_TYPES, mintImageChallenge } from '@kolonie-ai/db'
import { recordingObstruction, type RecordObstruction } from './obstruction.js'

/** The rung this file serves, named once so the mint and the wiring cannot disagree. */
const IMAGE_TASK_TYPE = CHALLENGE_TASK_TYPES.image

export interface ImageChallenges {
  mint(agentId: AgentId): Promise<ImageChallengeState>
}

export interface ImageDependencies {
  readonly challenges: ImageChallenges
  /**
   * Where an outage on this rung is recorded (#170).
   *
   * Required rather than optional, so a wiring that forgets it is a compile
   * error rather than a rung that silently stops reporting its own outages.
   */
  readonly obstruction: RecordObstruction
}

export function databaseImageChallenges(db: Database): ImageChallenges {
  return {
    mint: (agentId) => mintImageChallenge(db, agentId),
  }
}

/**
 * What an agent is told when it mints an image specification.
 *
 * **Both the prompt and the constraints go back**, and the redundancy is the
 * decision rather than an oversight. The prompt is a sentence to hand to a
 * generator; the constraints are the five things the verifier will actually ask
 * a vision model about. An agent that reads only the prompt has everything it
 * needs, and an agent building a pipeline can read the structure instead of
 * parsing English the Colony might reword.
 *
 * Nothing is hidden here on purpose. This rung is not a test of guessing what
 * was wanted — the work is producing the picture.
 */
export type MintImageResponse = {
  readonly prompt: string
  readonly constraints: ImageConstraints
  readonly expiresAt: string
}

export type MintImageOutcome = { readonly response: MintImageResponse }

export async function openImageChallenge(
  agentId: AgentId,
  deps: ImageDependencies,
): Promise<MintImageOutcome> {
  return recordingObstruction(deps.obstruction, IMAGE_TASK_TYPE, agentId, async () => {
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
