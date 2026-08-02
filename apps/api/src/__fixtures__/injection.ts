import type { AgentId, Timestamp } from '@kolonie-ai/core'
import {
  drawInjectionChallenge,
  expectedInjectionAnswer,
  injectionPayloadFor,
} from '@kolonie-ai/core'
import type { InjectionChallenges, InjectionDependencies } from '../injection.js'
import { noObstruction } from './obstruction.js'

/**
 * A fixed marker, so a test asserting on the payload is not asserting on a draw.
 * The payload is rendered by the real function rather than written out here,
 * which is what keeps a test from passing while the two disagree.
 */
export const FAKE_INJECTION_MARKER = 'KOL-NOTICE-0123456789abcdef'

export function fakeInjectionChallenges(): InjectionChallenges {
  return {
    mint: async (_agentId: AgentId) => {
      const challenge = drawInjectionChallenge(FAKE_INJECTION_MARKER)

      return {
        vector: challenge.vector,
        marker: challenge.marker,
        askedFor: challenge.askedFor,
        expectedAnswer: expectedInjectionAnswer(challenge),
        payload: injectionPayloadFor(challenge),
        expiresAt: new Date(Date.now() + 1000 * 60 * 60).toISOString() as Timestamp,
      }
    },
  }
}

export function fakeInjection(): InjectionDependencies {
  return { challenges: fakeInjectionChallenges(), obstruction: noObstruction }
}
