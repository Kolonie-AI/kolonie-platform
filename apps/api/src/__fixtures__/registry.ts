import { randomUUID } from 'node:crypto'
import {
  AgentIdSchema,
  ApiKeySchema,
  API_KEY_PREFIX,
  CredentialIdSchema,
  REGISTRATION_CONFIRMATION_TTL_SECONDS,
  type ConfirmationVerdict,
  type RegisterAgentFields,
} from '@kolonie-ai/core'
import type { RegisterAgentResult } from '@kolonie-ai/db'
import { checkName, register, type AgentRegistry, type RegistrationGate } from '../registration.js'

/**
 * The pause in front of the front door, in memory (`#875`).
 *
 * It reproduces the one thing `apps/api` is responsible for: which verdict a
 * presented token earns. Whether PostgreSQL spends a row exactly once under
 * concurrency is asserted in `packages/db`, against a real one.
 *
 * `confirm` is the affordance every other test in this app needs and no caller
 * has: it mints a token and hands it straight back, so a test about something
 * else can join in one line instead of rehearsing the two-step. Tests that are
 * *about* the two-step go through {@link RegistrationGate} like a citizen does.
 */
export function memoryGate(
  taken: (name: string) => Promise<boolean> = async () => false,
): RegistrationGate & { readonly confirm: (name: string) => Promise<string> } {
  const key = (name: string) => name.trim().toLowerCase()
  const tokens = new Map<string, { nameKey: string; expiresAt: number; consumed: boolean }>()
  let issued = 0

  const mint = async (name: string) => {
    const token = `confirm-${(issued += 1)}`
    const expiresAt = Date.now() + REGISTRATION_CONFIRMATION_TTL_SECONDS * 1000
    tokens.set(token, { nameKey: key(name), expiresAt, consumed: false })
    return { token, expiresAt: new Date(expiresAt).toISOString() }
  }

  return {
    taken,
    mint,
    async spend(name, token): Promise<ConfirmationVerdict> {
      const row = tokens.get(token)
      if (row === undefined) return 'unknown'
      if (row.nameKey !== key(name)) return 'other-name'
      if (row.consumed) return 'spent'
      row.consumed = true
      return row.expiresAt <= Date.now() ? 'expired' : 'confirmed'
    },
    confirm: async (name) => (await mint(name)).token,
  }
}

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
export function fakeRegistry(): AgentRegistry & {
  readonly names: () => string[]
  readonly confirm: (name: string) => Promise<string>
} {
  const takenNames = new Set<string>()

  const store = async (request: RegisterAgentFields): Promise<RegisterAgentResult> => {
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
          declaredRhythmMinutes: null,
          vocation: null,
          disposition: null,
          goal: null,
          availability: null,
          profession: null,
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

  const isTaken = async (name: string) => takenNames.has(name.toLowerCase())
  const gate = memoryGate(isTaken)

  return {
    register: (request) => register(request, store, gate),
    /**
     * Answers from the same `takenNames` set registration writes into (#138), so
     * a name this reports as taken is a name that fixture refuses. Two unrelated
     * sources would let a test prove an agreement the real code does not have.
     */
    checkName: (request) => checkName(request, isTaken),
    names: () => [...takenNames],
    confirm: gate.confirm,
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
export function brokenRegistry(): AgentRegistry & {
  readonly confirm: (name: string) => Promise<string>
} {
  const gate = memoryGate()

  return {
    confirm: gate.confirm,
    register: (request) =>
      register(
        request,
        () => {
          throw new Error(DRIVER_FAILURE_MESSAGE)
        },
        gate,
      ),
    checkName: (request) =>
      checkName(request, () => {
        throw new Error(DRIVER_FAILURE_MESSAGE)
      }),
  }
}
