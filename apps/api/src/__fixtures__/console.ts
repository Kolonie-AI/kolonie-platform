import { randomUUID } from 'node:crypto'
import { AgentIdSchema, CredentialIdSchema, type AgentId } from '@kolonie-ai/core'
import type { ConsoleDependencies, ConsoleStore } from '../console.js'
import type { Mailer } from '../email.js'
import { signInAddressLimiter, signInClientLimiter } from '../rate-limit.js'

/** A mailer that keeps what it was asked to send, so a test can read it. */
export interface FakeMailer extends Mailer {
  readonly sent: () => readonly { to: string; subject: string; text: string }[]
}

export function fakeMailer(): FakeMailer {
  const sent: { to: string; subject: string; text: string }[] = []
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
}

export function fakeConsoleStore(): FakeConsoleStore {
  const byAddress = new Map<string, { agentId: AgentId; address: string }>()
  const live = new Map<string, { agentId: AgentId; expired: boolean }>()
  const tokens: string[] = []
  const names = new Set<string>()

  const key = (address: string) => address.trim().toLowerCase()

  return {
    hold: (address, agentId) => {
      const held = agentId ?? AgentIdSchema.parse(randomUUID())
      byAddress.set(key(address), { agentId: held, address })
      return held
    },

    tokens: () => tokens,

    resolveAddress: async (address) => byAddress.get(key(address)),

    requestLink: async (identity) => {
      // One live link per identity, as the database has it: minting a second
      // drops the first.
      for (const [token, held] of live) {
        if (held.agentId === identity.agentId) live.delete(token)
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
      if (held === undefined || held.expired) return { outcome: 'refused' }

      live.delete(token)

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
      if (names.has(name.toLowerCase())) return { outcome: 'name-taken', name }

      names.add(name.toLowerCase())
      const agentId = AgentIdSchema.parse(randomUUID())
      byAddress.set(key(address), { agentId, address })

      return { outcome: 'registered', identity: { agentId, address } }
    },

    endSession: async () => {},
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
