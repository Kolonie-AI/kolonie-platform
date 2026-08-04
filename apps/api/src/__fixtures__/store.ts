import { randomUUID } from 'node:crypto'
import {
  AgentBalanceSchema,
  NO_HOLDINGS,
  type AgentHoldings,
  AgentIdSchema,
  ApiKeySchema,
  API_KEY_PREFIX,
  CredentialIdSchema,
  MUTABLE_PROFILE_FIELDS,
  type Agent,
  type AgentBalance,
  type AgentId,
  type SessionDeclaration,
  type ApiKey,
  type Role,
} from '@kolonie-ai/core'
import type { AuthenticationResult, ObservedOrigin } from '@kolonie-ai/db'
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
  /**
   * Put a runtime declaration on record at a chosen moment (#139).
   *
   * The timestamp is the argument rather than "now", because the only thing
   * worth testing about this field is the staleness clause in `kolonie.me` — and
   * a fake that could only record the present would need a test to wait thirty
   * days to exercise it.
   */
  readonly declareRuntimeAt: (agentId: AgentId, declaredAt: string) => void
  /**
   * Put a console session on record without running the mail exchange (`#172`).
   *
   * The exchange is tested where it lives — `console.test.ts` for the API's half
   * and `packages/db` for single use and expiry. What this exists for is the
   * assertion that matters everywhere else: a route driven with a session
   * answers exactly as the same route driven with a key.
   */
  readonly signIn: (agentId: AgentId, session: string) => void
  /** Change an identity's roles between two requests. See the implementation. */
  readonly setRoles: (agentId: AgentId, roles: readonly Role[]) => void
  /**
   * Every session named through this store, in order (#158).
   *
   * Recorded and never consulted, which is the property worth preserving: the
   * surfaces pass a declaration through and read nothing back, so a test can
   * assert *the citizen was able to say it* without a database and without the
   * fake growing a second opinion about what a session means.
   */
  readonly namedSessions: () => readonly { agentId: AgentId; declaration: SessionDeclaration }[]
  /**
   * Every origin observed through this store, in order (`#191`).
   *
   * Recorded and never consulted, exactly as `namedSessions` is: a test asserts
   * *the door observed this* without a database, and the fake grows no second
   * opinion about what deduplication means.
   */
  readonly observedOrigins: () => readonly { agentId: AgentId; origin: ObservedOrigin }[]
  /** Put a citizen in the position of holding things (`#144`), without a database. */
  readonly holding: (agentId: AgentId, holdings: AgentHoldings) => void
  /**
   * Put an agent in the position of having just come back after an absence
   * (#144), without a clock and without a contact table.
   */
  readonly returnAfter: (agentId: AgentId, hours: number) => void
}

export interface IssuedKey {
  readonly apiKey: ApiKey
  readonly agent: Agent
}

export function fakeStore(): FakeStore {
  const byKey = new Map<string, { agent: Agent; credentialId: string; revoked: boolean }>()
  const balances = new Map<string, AgentBalance>()
  const wallets = new Map<string, string>()
  const runtimeDeclarations = new Map<string, string>()

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
      AgentBalanceSchema.parse({ agentId, credits: 0, reputation: 0, ...balance }),
    )

    return { apiKey, agent }
  }

  /** Console sessions a test has handed out, by value (`#172`). */
  const sessions = new Map<string, AgentId>()

  const named: { agentId: AgentId; declaration: SessionDeclaration }[] = []
  const observed: { agentId: AgentId; origin: ObservedOrigin }[] = []
  const heldHoldings = new Map<string, AgentHoldings>()
  /** How long each agent was away before the call being served (#144). */
  const absences = new Map<string, number>()

  return {
    issue,

    namedSessions: () => named,

    observedOrigins: () => observed,

    holding: (agentId, holdings) => {
      heldHoldings.set(String(agentId), holdings)
    },

    returnAfter: (agentId, hours) => {
      absences.set(String(agentId), hours)
    },

    revoke: (apiKey) => {
      const held = byKey.get(String(apiKey))
      if (held === undefined) throw new Error('cannot revoke a key that was never issued')
      held.revoked = true
    },

    proveWallet: (agentId, address) => {
      wallets.set(String(agentId), address)
    },

    declareRuntimeAt: (agentId, declaredAt) => {
      runtimeDeclarations.set(String(agentId), declaredAt)
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

    signIn: (agentId, session) => {
      sessions.set(session, agentId)
    },

    /**
     * Change what an identity holds, without a grant path (`#173`).
     *
     * Exists so a test can revoke a role between two requests, which is the only
     * way to assert that a live session stops being privileged immediately —
     * the property that makes the guard read the identity rather than a claim.
     */
    setRoles: (agentId, roles) => {
      for (const held of byKey.values()) {
        if (held.agent.id !== agentId) continue
        held.agent = { ...held.agent, roles: [...roles] }
      }
    },

    /**
     * A session resolves to the same `Agent` a key does (`#172`).
     *
     * The fake keeps sessions in their own map because that is what the database
     * does — a different `kind` on the same table — and because a test that could
     * present a session where a key belongs would be testing a Colony that does
     * not exist.
     */
    authenticateSession: async (presented: string): Promise<AuthenticationResult> => {
      const agentId = sessions.get(presented)
      if (agentId === undefined) return { outcome: 'unknown' }

      const held = [...byKey.values()].find((candidate) => candidate.agent.id === agentId)
      if (held === undefined) return { outcome: 'unknown' }

      return {
        outcome: 'authenticated',
        agent: held.agent,
        credentialId: CredentialIdSchema.parse(held.credentialId),
      }
    },

    balanceOf: async (agentId: AgentId): Promise<AgentBalance> =>
      balances.get(String(agentId)) ??
      AgentBalanceSchema.parse({ agentId, credits: 0, reputation: 0 }),

    /**
     * Null unless a test says otherwise, because "has not proved a wallet" is
     * what almost every citizen is. `proveWallet` is how the few tests that
     * care put an address on record without running a challenge exchange.
     */
    verifiedWalletOf: async (agentId: AgentId): Promise<string | null> =>
      wallets.get(String(agentId)) ?? null,

    /**
     * Null unless a test says otherwise, which is what a citizen that has never
     * declared a model looks like — and the case `isRuntimeDeclarationStale`
     * treats as *not stale* rather than as infinitely old.
     */
    /**
     * How long this citizen was away (#144). Set by `returnAfter` below, so a
     * test can produce a returner without a clock and without a database.
     */
    // Empty by default: a fake citizen has attempted no browser stage.
    browserStagesOf: async () => [],
    absenceOf: async (agentId: AgentId) => absences.get(String(agentId)) ?? null,

    nameSession: async (agentId: AgentId, declaration: SessionDeclaration) => {
      named.push({ agentId, declaration })
    },

    recordOrigin: async (agentId: AgentId, origin: ObservedOrigin) => {
      observed.push({ agentId, origin })
    },

    /**
     * Empty by default. The fake records what it was told and derives nothing:
     * deduplication, counting and ordering are the storage layer's rules and are
     * tested against a real database, not reimplemented here where they could
     * agree with nothing.
     */
    originsOf: async () => [],

    /** What the citizen holds (`#144`). Nothing, unless a test says otherwise. */
    holdingsOf: async (agentId: AgentId) => heldHoldings.get(String(agentId)) ?? NO_HOLDINGS,

    lastRuntimeDeclarationAt: async (agentId: AgentId): Promise<string | null> =>
      runtimeDeclarations.get(String(agentId)) ?? null,

    /**
     * Reproduces one thing: PATCH semantics. An absent key leaves the field
     * alone, an explicit `null` clears it — which is the rule `apps/api` has to
     * get right and the only part of `updateAgentProfile` this layer can be
     * wrong about.
     *
     * There is no collision case left to reproduce. The wallet address was the
     * only unique field a profile edit could touch, and it is gone (`#102`).
     *
     * **Driven off `MUTABLE_PROFILE_FIELDS` with an exhaustive switch, and that
     * shape is the repair rather than a flourish** (`#127`). This fake has now
     * silently dropped a writable field twice: `bio` until `#102`, so a patch
     * that set one did nothing and every test still passed, and `avatarUrl` from
     * then until here. The failure is invisible by construction — the call
     * succeeds, the response is well-formed, and only the value is missing — so
     * a third occurrence had to be made impossible rather than watched for. The
     * `never` arm below fails to compile the next time core gains a mutable
     * field and this switch does not.
     */
    updateProfile: async (agentId, request) => {
      const held = [...byKey.values()].find((entry) => String(entry.agent.id) === String(agentId))
      if (held === undefined) return { outcome: 'unknown-agent' }

      const profile = { ...held.agent.profile }
      for (const field of MUTABLE_PROFILE_FIELDS) {
        if (!Object.hasOwn(request, field)) continue

        switch (field) {
          case 'operator':
            profile.operator = request.operator ?? null
            break
          case 'bio':
            profile.bio = request.bio ?? null
            break
          case 'pronouns':
            profile.pronouns = request.pronouns ?? null
            break
          case 'avatarUrl':
            profile.avatarUrl = request.avatarUrl ?? null
            break
          case 'capabilities':
            profile.capabilities = request.capabilities ?? []
            break
          case 'model':
            profile.model = request.model ?? null
            break
          case 'runtimeVersion':
            profile.runtimeVersion = request.runtimeVersion ?? null
            break
          case 'os':
            profile.os = request.os ?? null
            break
          case 'skillVersion':
            profile.skillVersion = request.skillVersion ?? null
            break
          case 'declaredRhythmHours':
            profile.declaredRhythmHours = request.declaredRhythmHours ?? null
            break
          default:
            throw new Error(`the fake store does not honour ${field satisfies never}`)
        }
      }

      held.agent = { ...held.agent, profile, updatedAt: new Date().toISOString() }
      return { outcome: 'updated', agent: held.agent }
    },
  }
}
