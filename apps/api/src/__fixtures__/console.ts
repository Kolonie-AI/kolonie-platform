import { randomUUID } from 'node:crypto'
import { AgentIdSchema, CredentialIdSchema, type AgentId } from '@kolonie-ai/core'
import type { ConsoleDependencies, ConsoleStore } from '../console.js'
import type { Mailer } from '../email.js'
import { signInAddressLimiter, signInClientLimiter } from '../rate-limit.js'

/**
 * A mailer that keeps what it was asked to send, so a test can read it.
 *
 * `from` is recorded as it arrived, including absent (`#398`): a fixture that
 * filled in a default would hide the difference between a surface that names its
 * sender and one that leaves it to the mailer, which is the thing under test.
 */
export interface FakeMailer extends Mailer {
  readonly sent: () => readonly {
    to: string
    subject: string
    text: string
    from?: string | undefined
  }[]
}

export function fakeMailer(): FakeMailer {
  const sent: { to: string; subject: string; text: string; from?: string | undefined }[] = []
  return {
    send: async (message) => {
      sent.push({ ...message })
      return { delivered: true }
    },
    sent: () => sent,
  }
}

export interface FakeConsoleStore extends ConsoleStore {
  /**
   * Put an address on record as belonging to an identity, without a challenge.
   *
   * How it *got* there — a proved reach address or an unproved sign-up claim —
   * is `packages/db`'s question, and answering it twice would give this fixture
   * a second opinion about D-047.
   */
  readonly hold: (address: string, agentId?: AgentId) => AgentId
  /** Every token this store has minted, newest last. */
  readonly tokens: () => readonly string[]
  /** Every key-mint confirmation token this store has minted, newest last (`#400`). */
  readonly keyMintTokens: () => readonly string[]
  /**
   * Age a live token past its expiry, without waiting fifteen minutes.
   *
   * The database decides expiry by comparing a stored timestamp; this fixture
   * models the *outcome* of that comparison, which is what the routes above it
   * can observe. Anything finer belongs in `packages/db`, against a real clock
   * and a real column.
   */
  readonly expire: (token: string) => void
}

export function fakeConsoleStore(): FakeConsoleStore {
  const byAddress = new Map<string, { agentId: AgentId; address: string }>()
  const live = new Map<string, { agentId: AgentId; expired: boolean }>()
  /** Tokens that were minted and are no longer live, and why (`#396`). */
  const finished = new Map<string, 'spent' | 'expired'>()
  const tokens: string[] = []
  const names = new Set<string>()
  /** The key-mint confirmations (`#400`), on their own map — see `requestKeyMint`. */
  const keyMints = new Map<string, { agentId: AgentId }>()
  const keyMintTokens: string[] = []

  const key = (address: string) => address.trim().toLowerCase()

  return {
    hold: (address, agentId) => {
      const held = agentId ?? AgentIdSchema.parse(randomUUID())
      byAddress.set(key(address), { agentId: held, address })
      return held
    },

    tokens: () => tokens,

    keyMintTokens: () => keyMintTokens,

    expire: (token) => {
      const held = live.get(token)
      if (held === undefined) return
      live.delete(token)
      finished.set(token, 'expired')
    },

    resolveAddress: async (address) => byAddress.get(key(address)),

    requestLink: async (identity) => {
      // One live link per identity, as the database has it: minting a second
      // drops the first. The dropped one is revoked rather than forgotten, so a
      // reader following the older mail is told it is finished (`#396`).
      for (const [token, held] of live) {
        if (held.agentId === identity.agentId) {
          live.delete(token)
          finished.set(token, 'spent')
        }
      }

      const token = randomUUID()
      live.set(token, { agentId: identity.agentId, expired: false })
      tokens.push(token)

      return {
        token,
        // The stored address, never the one a caller asked with. A fixture that
        // echoed the request would let the bug this whole flow is shaped around
        // pass every test in the suite.
        address: identity.address,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      }
    },

    redeem: async (token) => {
      const held = live.get(token)
      if (held === undefined || held.expired) {
        return { outcome: 'refused', reason: finished.get(token) ?? 'unknown' }
      }

      live.delete(token)
      finished.set(token, 'spent')

      return {
        outcome: 'signed-in',
        agentId: held.agentId,
        credentialId: CredentialIdSchema.parse(randomUUID()),
        session: randomUUID(),
        expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
      }
    },

    registerWeb: async ({ name, address }) => {
      if (byAddress.has(key(address))) return { outcome: 'address-taken' }

      /**
       * An absent name is the Colony's to invent, and it never collides
       * (`#266`) — the database retries until it does not, so a fixture that
       * could return `name-taken` for a name nobody chose would model a state
       * the real store does not reach.
       */
      const chosen = name ?? `sponsor-${randomUUID().slice(0, 8)}`
      if (name !== undefined && names.has(chosen.toLowerCase())) {
        return { outcome: 'name-taken', name: chosen }
      }

      names.add(chosen.toLowerCase())
      const agentId = AgentIdSchema.parse(randomUUID())
      byAddress.set(key(address), { agentId, address })

      return { outcome: 'registered', identity: { agentId, address } }
    },

    endSession: async () => {},

    /**
     * The key confirmation (`#400`), on its own token map.
     *
     * **Separate from the sign-in links deliberately**, because that separation
     * is the property being modelled: the two kinds do not revoke each other and
     * neither token is redeemable at the other's route. A fixture that shared
     * one map would let a test pass against exactly the confusion the second
     * credential kind exists to prevent.
     */
    requestKeyMint: async (agentId) => {
      const address = [...byAddress.values()].find((held) => held.agentId === agentId)?.address
      if (address === undefined) return undefined

      for (const [token, held] of keyMints) {
        if (held.agentId === agentId) keyMints.delete(token)
      }

      const token = randomUUID()
      keyMints.set(token, { agentId })
      keyMintTokens.push(token)

      return { token, address }
    },

    redeemKeyMint: async (token) => {
      const held = keyMints.get(token)
      if (held === undefined) return { outcome: 'refused' }

      // Single use: the token dies before the key it produced exists.
      keyMints.delete(token)

      return { outcome: 'minted', apiKey: `kol_${randomUUID().replaceAll('-', '')}test` }
    },
  }
}

/** Console dependencies with a mailer present, which is the configured case. */
export function fakeConsole(
  overrides: Partial<ConsoleDependencies> = {},
): ConsoleDependencies & { readonly store: FakeConsoleStore; readonly mailer: FakeMailer } {
  return {
    store: fakeConsoleStore(),
    mailer: fakeMailer(),
    consoleUrl: 'https://console.example.test',
    addressLimiter: signInAddressLimiter(),
    clientLimiter: signInClientLimiter(),
    ...overrides,
  } as ConsoleDependencies & { readonly store: FakeConsoleStore; readonly mailer: FakeMailer }
}
