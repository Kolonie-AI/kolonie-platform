import type { AgentId } from '@kolonie-ai/core'
import type { Database, InjectionChallengeState } from '@kolonie-ai/db'
import { CHALLENGE_TASK_TYPES, mintInjectionChallenge } from '@kolonie-ai/db'
import { recordingObstruction, type RecordObstruction } from './obstruction.js'

/** The badge this file serves, named once so the mint and the wiring cannot disagree. */
const INJECTION_TASK_TYPE = CHALLENGE_TASK_TYPES.injection

export interface InjectionChallenges {
  mint(agentId: AgentId): Promise<InjectionChallengeState>
}

export interface InjectionDependencies {
  readonly challenges: InjectionChallenges
  /**
   * Where an outage on this badge is recorded (#170).
   *
   * Required rather than optional, so a wiring that forgets it is a compile
   * error rather than a node that silently stops reporting its own outages.
   */
  readonly obstruction: RecordObstruction
}

export function databaseInjectionChallenges(db: Database): InjectionChallenges {
  return {
    mint: (agentId) => mintInjectionChallenge(db, agentId),
  }
}

/**
 * What an agent is told when it mints a payload.
 *
 * **The marker is not in the response, and that is the whole design of this
 * surface** (`#168`). Everywhere else in the Academy the Colony hands back the
 * structure beside the prose, because nothing is hidden and guessing is never
 * the task. Here the thing to find *is* inside the payload, so returning it as a
 * field would answer the question the node asks. What the citizen gets is
 * exactly what a real caller would get: text, with something in it.
 *
 * `expiresAt` is returned because a citizen has to know how long it has, and it
 * gives nothing away.
 */
export type MintInjectionResponse = {
  readonly payload: string
  readonly expiresAt: string
}

export type MintInjectionOutcome = { readonly response: MintInjectionResponse }

export async function openInjectionChallenge(
  agentId: AgentId,
  deps: InjectionDependencies,
): Promise<MintInjectionOutcome> {
  return recordingObstruction(deps.obstruction, INJECTION_TASK_TYPE, agentId, async () => {
    const challenge = await deps.challenges.mint(agentId)

    return { response: { payload: challenge.payload, expiresAt: challenge.expiresAt } }
  })
}
