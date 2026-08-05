import { ARTEFACT_CHALLENGE_TTL_MS, type AgentId, type ArtefactCode } from '@kolonie-ai/core'
import type { ArtefactDependencies } from '../artefact.js'
import { noObstruction } from './obstruction.js'

export interface FakeArtefactChallenges extends ArtefactDependencies {
  /** Every code this fixture issued, in order, by agent. */
  readonly minted: (agentId: AgentId) => readonly string[]
}

/**
 * The `artefact-publish` rung's mint, without a database (`#389`).
 *
 * The code is derived from a counter rather than randomised, so a test asserting
 * *this citizen got its own code* reads as an assertion rather than as a
 * coincidence. The real mint uses `randomInt` and says why.
 */
export function fakeArtefactChallenges(): FakeArtefactChallenges {
  const issued = new Map<string, string[]>()
  let seeded = 0

  return {
    obstruction: noObstruction,
    challenges: {
      mint: async (agentId: AgentId) => {
        seeded += 1
        const code = `KOL-${String.fromCharCode(65 + (seeded % 23))}BCDEFGH` as ArtefactCode
        const list = issued.get(String(agentId)) ?? []
        list.push(code)
        issued.set(String(agentId), list)

        return {
          code,
          expiresAt: new Date(Date.now() + ARTEFACT_CHALLENGE_TTL_MS).toISOString(),
        }
      },
    },
    minted: (agentId: AgentId) => issued.get(String(agentId)) ?? [],
  }
}
