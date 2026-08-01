import { randomUUID } from 'node:crypto'
import {
  AgentIdSchema,
  ApiKeySchema,
  API_KEY_PREFIX,
  CredentialIdSchema,
  type RegisterAgentRequest,
} from '@kolonie-ai/core'
import type { RegisterAgentResult } from '@kolonie-ai/db'
import { register, type AgentRegistry } from '../registration.js'

/**
 * An in-memory stand-in for the storage layer.
 *
 * It reproduces one behaviour of the real one and nothing else: which
 * registrations the *database* would refuse, and with which verdict. That is the
 * seam `apps/api` is responsible for translating, and it is all these tests are
 * about. Whether Postgres actually enforces case-insensitive uniqueness is
 * asserted in `packages/db`, against a real Postgres — asserting it here too
 * would only prove that this fake agrees with itself.
 */
export function fakeRegistry(): AgentRegistry & { readonly names: () => string[] } {
  const takenNames = new Set<string>()

  const store = async (request: RegisterAgentRequest): Promise<RegisterAgentResult> => {
    const key = request.name.toLowerCase()
    if (takenNames.has(key)) return { outcome: 'name-taken', name: request.name }

    takenNames.add(key)

    const issuedAt = new Date().toISOString()
    // Parsed rather than cast: ids and keys are branded, and parsing is how a
    // plain string becomes one. A cast would also let this fixture hand back a
    // key shape core would reject, which is precisely what the route tests
    // believe they are checking.
    const agentId = AgentIdSchema.parse(randomUUID())
    return {
      outcome: 'registered',
      agent: {
        id: agentId,
        profile: { ...request, pronouns: null },
        status: 'candidate',
        accountType: 'citizen',
        roles: [],
        skills: [],
        createdAt: issuedAt,
        updatedAt: issuedAt,
      },
      credentials: {
        agentId,
        credentialId: CredentialIdSchema.parse(randomUUID()),
        kind: 'api-key',
        apiKey: ApiKeySchema.parse(`${API_KEY_PREFIX}${'x'.repeat(43)}`),
        issuedAt,
      },
    }
  }

  return {
    register: (request) => register(request, store),
    names: () => [...takenNames],
  }
}

/** The message the broken registry throws, so a test can assert it never escapes. */
export const DRIVER_FAILURE_MESSAGE = 'connection to the database server failed'

/**
 * A registry whose storage throws. Used to check that a genuine fault becomes a
 * 500 with a stable code, rather than leaking a driver message to an agent.
 *
 * The message here is deliberately bland. A real driver error quotes the host it
 * failed to reach, and AGENTS.md §3 forbids a host name or an address anywhere
 * in this repository — including in a fixture that only pretends to be one.
 */
export function brokenRegistry(): AgentRegistry {
  return {
    register: (request) =>
      register(request, () => {
        throw new Error(DRIVER_FAILURE_MESSAGE)
      }),
  }
}
