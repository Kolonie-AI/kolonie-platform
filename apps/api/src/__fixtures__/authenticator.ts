import { mintTotpSecret, totpCodeAt, totpCounterAt, type AgentId } from '@kolonie-ai/core'
import type { AuthenticatorDependencies, TotpChallenges } from '../authenticator.js'
import { noObstruction } from './obstruction.js'

/**
 * The second-factor rung in memory (`#206`).
 *
 * **It reproduces the two rules the routes rely on**: one live secret per
 * citizen, and the two stages in order. A fake that let stage two pass without
 * stage one would let an API test go green while the rung certified retained
 * possession of something never shown to be understood.
 *
 * The clock is injectable, because the whole rung is about a gap and a test that
 * had to wait six hours would not be a test.
 */
export function fakeTotpChallenges(): TotpChallenges & {
  /** The live secret, so a test can compute a correct code. Nothing serves this. */
  readonly secretFor: (agentId: string) => string | undefined
  /** Move the fake's clock, in hours, to reach the second stage. */
  readonly advance: (hours: number) => void
} {
  const held = new Map<
    string,
    { secret: string; issuedAt: string; provedAt: string | null; heldAt: string | null }
  >()
  let offsetMs = 0
  const now = () => new Date(Date.now() + offsetMs)

  return {
    secretFor: (agentId) => held.get(agentId)?.secret,
    advance: (hours) => {
      offsetMs += hours * 3_600_000
    },

    // @mirrors packages/db/src/storage/totp.ts mintTotpSecretFor 12305a84
    mint: async (agentId: AgentId, replace: boolean) => {
      const live = held.get(agentId)
      if (live !== undefined && !replace) {
        return {
          outcome: 'live' as const,
          issuedAt: live.issuedAt as never,
          proved: live.provedAt !== null,
        }
      }

      const secret = mintTotpSecret()
      const issuedAt = now().toISOString()
      held.set(agentId, { secret, issuedAt, provedAt: null, heldAt: null })

      return { outcome: 'minted' as const, secret, issuedAt: issuedAt as never }
    },

    check: async (agentId: AgentId, code: string) => {
      const live = held.get(agentId)
      if (live === undefined) return { outcome: 'no_secret' as const }

      const at = Math.floor(now().getTime() / 1000)
      if (code !== totpCodeAt(live.secret, totpCounterAt(at))) {
        return { outcome: 'wrong' as const, wrongAttempts: 1, proved: live.provedAt !== null }
      }

      if (live.provedAt === null) {
        live.provedAt = now().toISOString()
        return { outcome: 'proved' as const, requiredHours: 6 }
      }

      const elapsedHours = (now().getTime() - Date.parse(live.provedAt)) / 3_600_000
      if (elapsedHours < 6) {
        return {
          outcome: 'too-soon' as const,
          remainingHours: Math.ceil((6 - elapsedHours) * 10) / 10,
          requiredHours: 6,
        }
      }

      live.heldAt ??= now().toISOString()
      return { outcome: 'held' as const, carriedForHours: Math.round(elapsedHours * 10) / 10 }
    },
  }
}

export function fakeAuthenticator(): AuthenticatorDependencies {
  return { challenges: fakeTotpChallenges(), obstruction: noObstruction }
}
