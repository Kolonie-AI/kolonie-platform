import { randomUUID } from 'node:crypto'
import {
  AgentIdSchema,
  ApiKeySchema,
  API_KEY_PREFIX,
  CredentialIdSchema,
  type RegisterAgentRequest,
} from '@kolonie-ai/core'
import type { RegisterAgentResult } from '@kolonie-ai/db'
import { checkName, register, type AgentRegistry } from '../registration.js'

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
        /**
         * The request settles three fields; the rest are the column defaults the
         * real storage layer reads back (`#137`). They are written here rather
         * than spread from the request because registration stopped accepting
         * them — a citizen arrives with an empty profile and writes it at Level 0.
         */
        profile: {
          ...request,
          pronouns: null,
          model: null,
          runtimeVersion: null,
          os: null,
          skillVersion: null,
          bio: null,
          capabilities: [],
          avatarUrl: null,
          declaredRhythmHours: null,
        },
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
    /**
     * Answers from the same `takenNames` set registration writes into (#138), so
     * a name this reports as taken is a name that fixture refuses. Two unrelated
     * sources would let a test prove an agreement the real code does not have.
     */
    checkName: (request) => checkName(request, async (name) => takenNames.has(name.toLowerCase())),
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
    checkName: (request) =>
      checkName(request, () => {
        throw new Error(DRIVER_FAILURE_MESSAGE)
      }),
  }
}
