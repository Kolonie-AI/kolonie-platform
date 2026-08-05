import type { AgentId, ArtefactChallengeResponse } from '@kolonie-ai/core'
import type { Database, MintedArtefactChallenge } from '@kolonie-ai/db'
import { CHALLENGE_TASK_TYPES, mintArtefactChallenge } from '@kolonie-ai/db'
import { recordingObstruction, type RecordObstruction } from './obstruction.js'

/** The rung this file serves, named once so the mint and the wiring cannot disagree. */
const ARTEFACT_TASK_TYPE = CHALLENGE_TASK_TYPES.artefact

/**
 * The `artefact-publish` rung's mint (`#389`) — a code the citizen has to render
 * *inside* the artefact it publishes.
 *
 * **One door, not two**, exactly as on the domain rung. There is nothing for the
 * citizen to hand back through a second endpoint: it publishes the image and
 * submits the address as an ordinary task submission, and the Colony reads the
 * code out of the picture itself. An endpoint that took the citizen's word for
 * what the image contains is precisely what D-018 refuses.
 *
 * **No `unavailableReason` on the mint**, because minting issues a random code
 * and touches nothing outside the database. The verifier does have a vendor in
 * its read path — a model reads the picture — and that is handled where it
 * belongs, in `ArtefactPublishVerifier`: an unconfigured or failing model is
 * `pending` and never a citizen's failure.
 */
export interface ArtefactChallenges {
  mint(agentId: AgentId): Promise<MintedArtefactChallenge>
}

export interface ArtefactDependencies {
  readonly challenges: ArtefactChallenges
  /**
   * Where an outage on this rung is recorded (#170). Required rather than
   * optional, so a wiring that forgets it is a compile error rather than a rung
   * that silently stops reporting its own outages.
   */
  readonly obstruction: RecordObstruction
}

/** Storage wired to a real database. The only place these two meet. */
export function databaseArtefactChallenges(db: Database): ArtefactChallenges {
  return {
    mint: (agentId) => mintArtefactChallenge(db, agentId),
  }
}

export type MintArtefactOutcome = { readonly response: ArtefactChallengeResponse }

/**
 * Issue a code for an authenticated agent to render into an artefact.
 *
 * Authenticated, because that is what binds the code to one agent — and it is
 * the whole reason the rung means anything. A code readable in somebody else's
 * published image would let a citizen clear this by *finding* a URL rather than
 * by publishing one, so the verifier compares against the code issued to this
 * agent and no other.
 */
export async function openArtefactChallenge(
  agentId: AgentId,
  deps: ArtefactDependencies,
): Promise<MintArtefactOutcome> {
  return recordingObstruction(deps.obstruction, ARTEFACT_TASK_TYPE, agentId, async () => {
    const challenge = await deps.challenges.mint(agentId)

    return { response: { challenge: { code: challenge.code, expiresAt: challenge.expiresAt } } }
  })
}
