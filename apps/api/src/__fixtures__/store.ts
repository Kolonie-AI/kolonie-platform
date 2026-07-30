import { randomUUID } from 'node:crypto'
import {
  AgentBalanceSchema,
  AgentIdSchema,
  ApiKeySchema,
  API_KEY_PREFIX,
  CredentialIdSchema,
  type Agent,
  type AgentBalance,
  type AgentId,
  type ApiKey,
} from '@kolonie-ai/core'
import type { AuthenticationResult } from '@kolonie-ai/db'
import type { AgentStore } from '../authentication.js'

/**
 * An in-memory stand-in for the storage layer's read side.
 *
 * Like `fakeRegistry`, it reproduces one thing and nothing else: which verdict
 * the *database* returns for a presented key, and what it says a balance is.
 * Whether Postgres actually finds a credential through the unique index on its
 * hash is asserted in `packages/db`, against a real Postgres. Asserting it here
 * too would only prove this fake agrees with itself.
 */
export interface FakeStore extends AgentStore {
  /** Add an agent holding a live key. Returns the key, as registration would. */
  readonly issue: (agent?: Partial<Agent>, balance?: Partial<AgentBalance>) => IssuedKey
  /** Revoke a key that was issued, exactly as the database would see it. */
  readonly revoke: (apiKey: ApiKey) => void
  /**
   * Put a proved wallet address on record, without running the challenge
   * exchange. The exchange itself is tested where it lives — `routes/solana.test.ts`
   * for the API's half, `packages/db` for the partial unique index.
   */
  readonly proveWallet: (agentId: AgentId, address: string) => void
}

export interface IssuedKey {
  readonly apiKey: ApiKey
  readonly agent: Agent
}

export function fakeStore(): FakeStore {
  const byKey = new Map<string, { agent: Agent; credentialId: string; revoked: boolean }>()
  const balances = new Map<string, AgentBalance>()
  const wallets = new Map<string, string>()

  const issue = (overrides: Partial<Agent> = {}, balance: Partial<AgentBalance> = {}) => {
    const agentId = overrides.id ?? AgentIdSchema.parse(randomUUID())
    const issuedAt = new Date().toISOString()
    // Parsed rather than cast: a fixture that can hand back a key shape core
    // would reject makes the route tests believe they checked something they did
    // not. Two uuids, so it clears the 40-character minimum core requires.
    const apiKey = ApiKeySchema.parse(
      `${API_KEY_PREFIX}${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`,
    )

    const agent: Agent = {
      profile: {
        name: 'canary',
        platform: 'openclaw',
        operator: null,
        bio: null,
        capabilities: [],
        avatarUrl: null,
      },
      status: 'candidate',
      accountType: 'citizen',
      roles: [],
      skills: [],
      createdAt: issuedAt,
      updatedAt: issuedAt,
      ...overrides,
      id: agentId,
    }

    byKey.set(String(apiKey), {
      agent,
      credentialId: CredentialIdSchema.parse(randomUUID()),
      revoked: false,
    })
    balances.set(
      String(agentId),
      AgentBalanceSchema.parse({ agentId, coins: 0, reputation: 0, ...balance }),
    )

    return { apiKey, agent }
  }

  return {
    issue,

    revoke: (apiKey) => {
      const held = byKey.get(String(apiKey))
      if (held === undefined) throw new Error('cannot revoke a key that was never issued')
      held.revoked = true
    },

    proveWallet: (agentId, address) => {
      wallets.set(String(agentId), address)
    },

    authenticate: async (presented: string): Promise<AuthenticationResult> => {
      const held = byKey.get(presented)
      if (held === undefined) return { outcome: 'unknown' }
      if (held.revoked) return { outcome: 'revoked' }
      return {
        outcome: 'authenticated',
        agent: held.agent,
        credentialId: CredentialIdSchema.parse(held.credentialId),
      }
    },

    balanceOf: async (agentId: AgentId): Promise<AgentBalance> =>
      balances.get(String(agentId)) ??
      AgentBalanceSchema.parse({ agentId, coins: 0, reputation: 0 }),

    /**
     * Null unless a test says otherwise, because "has not proved a wallet" is
     * what almost every citizen is. `proveWallet` is how the few tests that
     * care put an address on record without running a challenge exchange.
     */
    verifiedWalletOf: async (agentId: AgentId): Promise<string | null> =>
      wallets.get(String(agentId)) ?? null,

    /**
     * Reproduces one thing: PATCH semantics. An absent key leaves the field
     * alone, an explicit `null` clears it — which is the rule `apps/api` has to
     * get right and the only part of `updateAgentProfile` this layer can be
     * wrong about.
     *
     * There is no collision case left to reproduce. The wallet address was the
     * only unique field a profile edit could touch, and it is gone (`#102`).
     */
    updateProfile: async (agentId, request) => {
      const held = [...byKey.values()].find((entry) => String(entry.agent.id) === String(agentId))
      if (held === undefined) return { outcome: 'unknown-agent' }

      const profile = { ...held.agent.profile }
      if (Object.hasOwn(request, 'operator')) profile.operator = request.operator ?? null
      // `bio` was missing here until `#102`, so a patch that set one silently
      // did nothing and no test noticed. The real store has always honoured it.
      if (Object.hasOwn(request, 'bio')) profile.bio = request.bio ?? null
      if (Object.hasOwn(request, 'capabilities')) profile.capabilities = request.capabilities ?? []

      held.agent = { ...held.agent, profile, updatedAt: new Date().toISOString() }
      return { outcome: 'updated', agent: held.agent }
    },
  }
}
