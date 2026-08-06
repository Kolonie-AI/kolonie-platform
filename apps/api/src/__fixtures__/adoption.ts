import { AgentIdSchema, type Agent } from '@kolonie-ai/core'
import { randomUUID } from 'node:crypto'
import type { AdoptionDesk } from '../adoption.js'
import { anAgent } from './humans.js'

/**
 * The redemption side of the hand-over, in memory (`#459`).
 *
 * **It reproduces the rules the API is allowed to rely on** rather than
 * answering yes to everything: a code works once, a revoked one never works,
 * and an identity that has been handed over cannot be handed over again.
 * Whether Postgres enforces them is asserted in `packages/db` against a real
 * one; what the API does with the answers is asserted here — and the thing this
 * fixture exists to make testable is the *collapse*, that four different
 * refusals reach a caller as one sentence.
 */
export interface FakeAdoptionDesk extends AdoptionDesk {
  /** Put a live code on record, as a console would. */
  readonly issue: (code: string, agent?: Agent) => void
  /** Take one back, as the console's button does. */
  readonly revoke: (code: string) => void
  /** Age one out without waiting an hour. */
  readonly expire: (code: string) => void
}

export function fakeAdoption(): FakeAdoptionDesk {
  const codes = new Map<
    string,
    { agent: Agent; used: boolean; revoked: boolean; expired: boolean }
  >()

  return {
    issue: (code, agent) => {
      codes.set(code, {
        agent:
          agent ??
          anAgent({ id: AgentIdSchema.parse(randomUUID()), name: `handed-over-${codes.size + 1}` }),
        used: false,
        revoked: false,
        expired: false,
      })
    },

    revoke: (code) => {
      const held = codes.get(code)
      if (held !== undefined) held.revoked = true
    },

    expire: (code) => {
      const held = codes.get(code)
      if (held !== undefined) held.expired = true
    },

    redeem: async ({ code, platform, operator }) => {
      const held = codes.get(code)
      if (held === undefined) return { outcome: 'refused', reason: 'unknown' }
      if (held.used) return { outcome: 'refused', reason: 'spent' }
      if (held.revoked) return { outcome: 'refused', reason: 'revoked' }
      if (held.expired) return { outcome: 'refused', reason: 'expired' }

      held.used = true

      return {
        outcome: 'adopted',
        // The identity keeps its id and its name and takes the runtime the
        // adopting agent declared — the whole of what the real one changes.
        agent: {
          ...held.agent,
          profile: {
            ...held.agent.profile,
            platform,
            ...(operator === undefined ? {} : { operator }),
          },
        },
        apiKey: `kol_adopted_${code}`,
        credentialId: randomUUID(),
      }
    },
  }
}
