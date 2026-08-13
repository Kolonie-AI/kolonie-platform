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
  type StoredAutonomyContract,
  type ProfileReview,
} from '@kolonie-ai/core'
import type { AuthenticationResult, ObservedOrigin, WakeChannel } from '@kolonie-ai/db'
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
   * Put an operator's contract on record without running the form (`#306`).
   *
   * `kolonie.me` carries a summary of it now, so a test about what a citizen
   * reads on waking needs one without the invitation exchange in front of it.
   */
  readonly recordContract: (agentId: AgentId, contract: StoredAutonomyContract) => void
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
  /**
   * Give a citizen a proved wake channel, in whatever state (`#585`).
   *
   * Without one, `wakeChannelOf` answers `null` — which is the ordinary state
   * for most citizens and is itself worth asserting.
   */
  readonly proveWake: (agentId: AgentId, channel: WakeChannel) => void
  /** Seed where a citizen's published fields stand (`#827`). */
  readonly reviewing: (agentId: AgentId, review: ProfileReview) => void
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
        vocation: null,
        disposition: null,
        goal: null,
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
  /** What each agent's operator recorded, for the citizens that have one (`#306`). */
  const contracts = new Map<string, StoredAutonomyContract>()
  /** The wake channel each agent has proved, for the few that have (`#585`). */
  const wakeChannels = new Map<string, WakeChannel>()
  /**
   * Where each agent's published fields stand (`#827`).
   *
   * **Rows a test seeds, and no reimplementation of the queueing rule.** What
   * happens to a review when a citizen writes is decided inside the profile
   * transaction in `packages/db/src/storage/agents.ts`, and a fake that copied
   * that decision is the class of fixture `AGENTS.md` §3 says needs a
   * `@mirrors` pin — and the class that has twice gone on passing after
   * production changed. This one stores what it is given.
   */
  const profileReviews = new Map<string, ProfileReview>()
  /** Whether each citizen has allowed crawling (`#818`). Off until it says otherwise. */
  const indexing = new Map<string, boolean>()

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

    recordContract: (agentId, contract) => {
      contracts.set(String(agentId), contract)
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

    // The wall (`#241`). Empty unless a test puts something on it.
    badgesOf: async () => [],

    // Null unless a test says otherwise: no contract is the ordinary state and
    // plenty of citizens run permanently without one (`#306`).
    autonomyOf: async (agentId: AgentId) => contracts.get(String(agentId)) ?? null,
    // Null unless a test proves one (`#585`). A citizen without the rung is the
    // ordinary case and the surface has to say nothing about it.
    wakeChannelOf: async (agentId: AgentId) => wakeChannels.get(String(agentId)) ?? null,
    proveWake: (agentId: AgentId, channel: WakeChannel) => {
      wakeChannels.set(String(agentId), channel)
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

    /** Seed one citizen's review state, so a test can assert what `/me` says about it. */
    reviewing: (agentId: AgentId, review: ProfileReview) => {
      profileReviews.set(String(agentId), review)
    },

    /**
     * Nothing waiting is the default, and it is the honest one: a citizen that
     * has never written a moderated field has no rows and is told about none.
     */
    profileReviewOf: async (agentId: AgentId): Promise<ProfileReview> =>
      profileReviews.get(String(agentId)) ?? { fields: [] },

    /** Off until the citizen turns it on, which is the column's own default. */
    indexableOf: async (agentId: AgentId): Promise<boolean> =>
      indexing.get(String(agentId)) ?? false,

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
          // The three that say where a citizen is going (`#140`). The text
          // only: the classification is derived by a runner, and a fake that
          // invented one would let a test assert an ordering nothing produced.
          case 'vocation':
            profile.vocation = request.vocation ?? null
            break
          case 'disposition':
            profile.disposition = request.disposition ?? null
            break
          case 'goal':
            profile.goal = request.goal ?? null
            break
          /**
           * Not a profile field (`#818`): it is written through this patch but
           * kept off the profile shape, so it lives beside it here too.
           */
          case 'indexable':
            if (request.indexable !== undefined) indexing.set(String(agentId), request.indexable)
            break
          default:
            throw new Error(`the fake store does not honour ${field satisfies never}`)
        }
      }

      held.agent = { ...held.agent, profile, updatedAt: new Date().toISOString() }
      return { outcome: 'updated', agent: held.agent }
    },

    /**
     * The same record the write answers with, read by id (`#829`). No
     * credential is consulted — the console has already decided who may ask,
     * and a fake that re-decided it here would be testing its own opinion.
     */
    profileOf: async (agentId: AgentId): Promise<Agent | null> =>
      [...byKey.values()].find((entry) => String(entry.agent.id) === String(agentId))?.agent ??
      null,
  }
}
