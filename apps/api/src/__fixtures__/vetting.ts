import type { AgentId, Timestamp } from '@kolonie-ai/core'
import { drawVettingChallenge, vettingManifestFor } from '@kolonie-ai/core'
import type { VettingChallenges, VettingDependencies } from '../vetting.js'
import { noObstruction } from './obstruction.js'

/**
 * A fixed token, so a test asserting on the manifest is not asserting on a draw.
 * The manifest is rendered by the real function rather than written out here,
 * which is what keeps a test from passing while the two disagree.
 */
export const FAKE_VETTING_TOKEN = '0123abcd'

export function fakeVettingChallenges(): VettingChallenges {
  return {
    mint: async (_agentId: AgentId) => {
      const challenge = drawVettingChallenge(FAKE_VETTING_TOKEN)

      return {
        sample: challenge.sample,
        token: challenge.token,
        planted: challenge.planted,
        manifest: vettingManifestFor(challenge),
        expiresAt: new Date(Date.now() + 1000 * 60 * 60).toISOString() as Timestamp,
      }
    },
  }
}

export function fakeVetting(): VettingDependencies {
  return { challenges: fakeVettingChallenges(), obstruction: noObstruction }
}
