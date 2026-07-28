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
  type RegisterAgentRequest,
} from '@kolonie-ai/core'
import type { AuthenticationResult, RegisterAgentResult } from '@kolonie-ai/db'
import type { AgentStore } from '../authentication.js'
import type { TaskCatalogue } from '../tasks.js'
import type { TaskSubmissions } from '../submissions.js'
import { register, type AgentRegistry } from '../registration.js'
import { fakeCatalogue } from './catalogue.js'
import { fakeSubmissions } from './submissions.js'

/**
 * One in-memory Colony behind both seams.
 *
 * `fakeRegistry` and `fakeStore` deliberately know nothing about each other,
 * which is right for testing one surface at a time and useless for the property
 * #9 is actually about: that an agent can arrive with nothing, register, and
 * come straight back with the key it was just handed. A key issued by one fake
 * and presented to the other can never authenticate, so that round trip needs a
 * fixture where registration is what makes the credential real.
 *
 * It reproduces the storage layer's verdicts and nothing else. Whether Postgres
 * enforces case-insensitive names or finds a credential through the unique index
 * on its hash is asserted in `packages/db`, against a real Postgres.
 */
export interface FakeColony {
  readonly registry: AgentRegistry
  readonly store: AgentStore
  /** Present so this fixture can be handed to `buildApp` whole. Answers nothing. */
  readonly catalogue: TaskCatalogue
  /** Same — the MCP surface has no submission tool yet. */
  readonly submissions: TaskSubmissions
  /** Revoke a key the Colony issued, exactly as the database would see it. */
  readonly revoke: (apiKey: ApiKey) => void
  /** Credit an agent, so a balance read has something to be right about. */
  readonly credit: (agentId: AgentId, balance: Partial<AgentBalance>) => void
}

export function fakeColony(): FakeColony {
  const byKey = new Map<string, { agent: Agent; revoked: boolean }>()
  const balances = new Map<string, AgentBalance>()
  const takenNames = new Set<string>()
  const takenWallets = new Set<string>()

  const store = async (request: RegisterAgentRequest): Promise<RegisterAgentResult> => {
    const key = request.name.toLowerCase()
    if (takenNames.has(key)) return { outcome: 'name-taken', name: request.name }
    if (request.wallet !== null && takenWallets.has(request.wallet)) {
      return { outcome: 'wallet-taken', wallet: request.wallet }
    }

    takenNames.add(key)
    if (request.wallet !== null) takenWallets.add(request.wallet)

    const issuedAt = new Date().toISOString()
    const agentId = AgentIdSchema.parse(randomUUID())
    // Two uuids, so it clears the 40-character minimum core requires. Parsed
    // rather than cast: a fixture that can hand back a key shape core would
    // reject makes these tests believe they checked something they did not.
    const apiKey = ApiKeySchema.parse(
      `${API_KEY_PREFIX}${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`,
    )

    const agent: Agent = {
      id: agentId,
      profile: request,
      status: 'candidate',
      roles: [],
      level: 0,
      createdAt: issuedAt,
      updatedAt: issuedAt,
    }

    // This line is the whole point of the fixture: the key the caller is about
    // to be shown is the key that authenticates from here on.
    byKey.set(String(apiKey), { agent, revoked: false })
    balances.set(String(agentId), AgentBalanceSchema.parse({ agentId, coins: 0, reputation: 0 }))

    return {
      outcome: 'registered',
      agent,
      credentials: {
        agentId,
        credentialId: CredentialIdSchema.parse(randomUUID()),
        kind: 'api-key',
        apiKey,
        issuedAt,
      },
    }
  }

  return {
    registry: { register: (request) => register(request, store) },

    catalogue: fakeCatalogue(),

    submissions: fakeSubmissions(),

    store: {
      authenticate: async (presented: string): Promise<AuthenticationResult> => {
        const held = byKey.get(presented)
        if (held === undefined) return { outcome: 'unknown' }
        if (held.revoked) return { outcome: 'revoked' }
        return {
          outcome: 'authenticated',
          agent: held.agent,
          credentialId: CredentialIdSchema.parse(randomUUID()),
        }
      },

      balanceOf: async (agentId: AgentId): Promise<AgentBalance> =>
        balances.get(String(agentId)) ??
        AgentBalanceSchema.parse({ agentId, coins: 0, reputation: 0 }),
    },

    revoke: (apiKey) => {
      const held = byKey.get(String(apiKey))
      if (held === undefined) throw new Error('cannot revoke a key that was never issued')
      held.revoked = true
    },

    credit: (agentId, balance) => {
      balances.set(
        String(agentId),
        AgentBalanceSchema.parse({ agentId, coins: 0, reputation: 0, ...balance }),
      )
    },
  }
}
