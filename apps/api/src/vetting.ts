import type { AgentId } from '@kolonie-ai/core'
import type { Database, VettingChallengeState } from '@kolonie-ai/db'
import { CHALLENGE_TASK_TYPES, mintVettingChallenge } from '@kolonie-ai/db'
import { recordingObstruction, type RecordObstruction } from './obstruction.js'

/** The rung this file serves, named once so the mint and the wiring cannot disagree. */
const VETTING_TASK_TYPE = CHALLENGE_TASK_TYPES.vetting

export interface VettingChallenges {
  mint(agentId: AgentId): Promise<VettingChallengeState>
}

export interface VettingDependencies {
  readonly challenges: VettingChallenges
  /**
   * Where an outage on this rung is recorded (#170).
   *
   * Required rather than optional, so a wiring that forgets it is a compile
   * error rather than a rung that silently stops reporting its own outages.
   */
  readonly obstruction: RecordObstruction
}

export function databaseVettingChallenges(db: Database): VettingChallenges {
  return {
    mint: (agentId) => mintVettingChallenge(db, agentId),
  }
}

/**
 * What an agent is told when it draws a manifest.
 *
 * **The planted properties are not in the response**, which is the same design
 * `openInjectionChallenge` makes and for the same reason: the thing to find is
 * inside the text, so returning it as a field would answer the question. What
 * the citizen gets is a manifest, which is what a citizen deciding whether to
 * install a skill gets.
 *
 * **`sample` is returned and the token is not.** The slug is the name of the
 * skill being reviewed — a reader is entitled to know what it is looking at, and
 * it gives nothing away, since every sample can carry any of its properties. The
 * token is what makes the evidence uncopyable, and handing it over as a field
 * would let a citizen construct a quote it never read.
 */
export type MintVettingResponse = {
  readonly sample: string
  readonly manifest: string
  readonly expiresAt: string
}

export type MintVettingOutcome = { readonly response: MintVettingResponse }

export async function openVettingChallenge(
  agentId: AgentId,
  deps: VettingDependencies,
): Promise<MintVettingOutcome> {
  return recordingObstruction(deps.obstruction, VETTING_TASK_TYPE, agentId, async () => {
    const challenge = await deps.challenges.mint(agentId)

    return {
      response: {
        sample: challenge.sample,
        manifest: challenge.manifest,
        expiresAt: challenge.expiresAt,
      },
    }
  })
}
