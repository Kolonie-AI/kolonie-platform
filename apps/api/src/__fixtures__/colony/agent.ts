import { randomUUID } from 'node:crypto'
import {
  AgentBalanceSchema,
  NO_HOLDINGS,
  type AgentHoldings,
  skill,
  AgentIdSchema,
  DEFAULT_RHYTHM_BOUNDS,
  type RhythmBounds,
  ApiKeySchema,
  API_KEY_PREFIX,
  CredentialIdSchema,
  MUTABLE_PROFILE_FIELDS,
  type Agent,
  type CitizenshipStatus,
  type AgentBalance,
  type AgentId,
  type SessionDeclaration,
  type ApiKey,
  type RegisterAgentRequest,
} from '@kolonie-ai/core'
import type { AuthenticationResult, ObservedOrigin, RegisterAgentResult } from '@kolonie-ai/db'
import type { AgentStore } from '../../authentication.js'
import type { SolanaChallenges } from '../../solana.js'
import type { StandingHintSource } from '../../hints.js'
import type { WakeupSource } from '../../wakeup.js'
import { checkName, register, type AgentRegistry, type Caller } from '../../registration.js'
import { fakeStandingHints } from '../hints.js'
import { fakeWakeup } from '../wakeup.js'

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
/**
 * The address every fake caller arrives from unless a test says otherwise.
 *
 * Documentation range (RFC 5737), so it is unmistakably not a real host and
 * cannot become one — `AGENTS.md` §9 forbids a real address in this repository,
 * and a fixture is not an exception to that.
 */
export const FAKE_CALLER_IP = '192.0.2.10'

/**
 * The citizen itself: how it arrives, how it is recognised afterwards, and what
 * the Colony holds about it.
 *
 * **This is the half of the fixture with state in it.** The other three files
 * wire fakes together, one line each; this one keeps the maps that make a round
 * trip real — the key registration issued, the balance a reward moved, the
 * profile a patch edited.
 */
export interface FakeAgent {
  readonly registry: AgentRegistry
  readonly store: AgentStore
  readonly wakeup: WakeupSource
  /** The one line a citizen did not ask for (`#231`). */
  readonly hints: StandingHintSource
  /** The range a declared rhythm has to fall inside (#142). */
  readonly rhythm: RhythmBounds
  /** Every session a citizen named through this colony, in order (#158). */
  readonly namedSessions: () => readonly { agentId: AgentId; declaration: SessionDeclaration }[]
  /** Every origin the door observed, in order (`#191`). Recorded, never consulted. */
  readonly observedOrigins: () => readonly { agentId: AgentId; origin: ObservedOrigin }[]
  /** Put a citizen in the position of holding things (`#144`), without a database. */
  readonly holding: (agentId: AgentId, holdings: AgentHoldings) => void
  /** Put an agent in the position of having just come back after an absence (#144). */
  readonly returnAfter: (agentId: AgentId, hours: number) => void
  /**
   * Who the MCP surface thinks is calling. One fixed address, because most tests
   * are not about the rate limit and want the front door to behave the same way
   * every time; the tests that *are* about it supply their own.
   */
  readonly caller: Caller
  /** Revoke a key the Colony issued, exactly as the database would see it. */
  readonly revoke: (apiKey: ApiKey) => void
  /** Credit an agent, so a balance read has something to be right about. */
  readonly credit: (agentId: AgentId, balance: Partial<AgentBalance>) => void
  /**
   * Put an agent where a real one would be after some passes: holding skills, and
   * at whatever citizenship status those earned it.
   *
   * Both in one call, because they are one fact. Letting a test set `citizen` with
   * no skills would let it assert against a state the platform cannot produce (#24),
   * which is the failure mode every other method in this fixture is written to
   * avoid.
   */
  readonly standing: (
    agentId: AgentId,
    standing: { readonly skills?: readonly string[]; readonly status?: CitizenshipStatus },
  ) => void
}

/**
 * @param solanaChallenges the wallet rung's store, from `fakeRungs`. Passed in
 * rather than built here because `verifiedWalletOf` has to read what the wallet
 * routes wrote: one store, or a citizen that clears `solana-wallet` over MCP has
 * no address in the next `kolonie.me`. It is the one thing two of these files
 * share, and it is a parameter so that neither of them owns the other.
 */
export function fakeAgent(deps: { readonly solanaChallenges: SolanaChallenges }): FakeAgent {
  const byKey = new Map<string, { agent: Agent; revoked: boolean }>()
  const balances = new Map<string, AgentBalance>()
  const takenNames = new Set<string>()
  const runtimeDeclarations = new Map<string, string>()
  /** Every session a citizen named through this colony, in order (#158). */
  const named: { agentId: AgentId; declaration: SessionDeclaration }[] = []
  const observed: { agentId: AgentId; origin: ObservedOrigin }[] = []
  const heldHoldings = new Map<string, AgentHoldings>()
  /** How long each agent was away before the call being served (#144). */
  const absences = new Map<string, number>()

  const store = async (request: RegisterAgentRequest): Promise<RegisterAgentResult> => {
    const key = request.name.toLowerCase()
    if (takenNames.has(key)) return { outcome: 'name-taken', name: request.name }

    takenNames.add(key)

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
      profile: {
        ...request,
        // None of these is part of a registration (`#137`): an arriving agent
        // gives a name, a platform and who is accountable for it, and everything
        // it *presents itself* with is a later edit to a row that already
        // exists. These are the column defaults the real storage reads back.
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
    }

    // This line is the whole point of the fixture: the key the caller is about
    // to be shown is the key that authenticates from here on.
    byKey.set(String(apiKey), { agent, revoked: false })
    balances.set(String(agentId), AgentBalanceSchema.parse({ agentId, credits: 0, reputation: 0 }))

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
    registry: {
      register: (request) => register(request, store),
      // Same `takenNames` set the registration path writes into (#138), so the
      // check and the front door cannot disagree inside one test.
      checkName: (request) =>
        checkName(request, async (name) => takenNames.has(name.toLowerCase())),
    },
    caller: { ip: FAKE_CALLER_IP },

    wakeup: fakeWakeup(),
    hints: fakeStandingHints(),
    /**
     * The default range (#142). A test that cares about the bounds passes its
     * own, which is the point of them being configuration — and the one that
     * pins *lowering the minimum is a configuration change* does exactly that.
     */
    rhythm: DEFAULT_RHYTHM_BOUNDS,
    namedSessions: () => named,
    observedOrigins: () => observed,

    holding: (agentId: AgentId, holdings: AgentHoldings) => {
      heldHoldings.set(String(agentId), holdings)
    },

    returnAfter: (agentId: AgentId, hours: number) => {
      absences.set(String(agentId), hours)
    },

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

      /** No console session is ever issued in this fixture — see `FakeStore` for the one that does. */
      authenticateSession: async (): Promise<AuthenticationResult> => ({ outcome: 'unknown' }),

      // The wall (`#241`). Empty unless a test puts something on it.
      badgesOf: async () => [],
      balanceOf: async (agentId: AgentId): Promise<AgentBalance> =>
        balances.get(String(agentId)) ??
        AgentBalanceSchema.parse({ agentId, credits: 0, reputation: 0 }),

      /**
       * Reads what the wallet rung recorded, through the same fake the routes
       * use. So a citizen that clears `solana-wallet` over MCP in one call sees
       * its address in `kolonie.me` in the next, which is the round trip this
       * fixture exists to make real.
       */
      verifiedWalletOf: async (agentId: AgentId): Promise<string | null> => {
        const attempt = await deps.solanaChallenges.latest(agentId)
        return attempt?.verifiedAt == null ? null : attempt.address
      },

      /**
       * Sessions, recorded and never consulted (#158). The fixture keeps them
       * so a test can assert the call was made without a database; nothing in
       * the surfaces reads the answer, which is the property being preserved.
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

      /**
       * Origins, recorded and never derived (`#191`). Deduplication, counting
       * and ordering are the storage layer's rules and are tested against a real
       * database — a fake that reimplemented them would be a second opinion able
       * to agree with nothing.
       */
      recordOrigin: async (agentId: AgentId, origin: ObservedOrigin) => {
        observed.push({ agentId, origin })
      },

      originsOf: async () => [],
      /**
       * What the citizen holds (`#144`). Empty by default, and settable by
       * `holding` below — the shape is what `apps/api` has to render, and the
       * three reads behind it are the storage layer's and are tested against a
       * real database.
       */
      holdingsOf: async (agentId: AgentId) => heldHoldings.get(String(agentId)) ?? NO_HOLDINGS,

      /** Written by `updateProfile` below, so the round trip is real (#139). */
      lastRuntimeDeclarationAt: async (agentId: AgentId): Promise<string | null> =>
        runtimeDeclarations.get(String(agentId)) ?? null,

      /**
       * PATCH semantics against the same `byKey` map registration writes into,
       * so a profile edited here is the profile the *next* `kolonie.me` in the
       * same test reads back. That is the property this fixture exists for: the
       * two surfaces have to be looking at one agent, or a test can prove a
       * round trip that never happened.
       */
      /**
       * **Driven off `MUTABLE_PROFILE_FIELDS` with an exhaustive switch**, the
       * repair `__fixtures__/store.ts` already carries and for the same reason
       * (`#127`). The list of `if` lines this replaces had drifted exactly as
       * that comment predicts: `pronouns` had been writable since `#127` and was
       * silently dropped here, so a test patching one saw a success, a
       * well-formed response, and no value. The `never` arm below fails to
       * compile the next time core gains a mutable field and this switch does
       * not.
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
              throw new Error(`the fake colony does not honour ${field satisfies never}`)
          }
        }

        /**
         * The declaration history, as the real storage writes it (#139): a row
         * whenever the field is in the patch, whether or not the value changed.
         * Kept here so a test can declare a model over MCP and see the staleness
         * clause stop appearing on the next `kolonie.me` — the round trip this
         * fixture exists for.
         */
        if (Object.hasOwn(request, 'model') || Object.hasOwn(request, 'runtimeVersion')) {
          runtimeDeclarations.set(String(agentId), new Date().toISOString())
        }

        held.agent = { ...held.agent, profile, updatedAt: new Date().toISOString() }
        return { outcome: 'updated', agent: held.agent }
      },
    },

    revoke: (apiKey) => {
      const held = byKey.get(String(apiKey))
      if (held === undefined) throw new Error('cannot revoke a key that was never issued')
      held.revoked = true
    },

    credit: (agentId, balance) => {
      balances.set(
        String(agentId),
        AgentBalanceSchema.parse({ agentId, credits: 0, reputation: 0, ...balance }),
      )
    },

    standing: (agentId, standing) => {
      const held = [...byKey.values()].find((entry) => entry.agent.id === agentId)
      if (held === undefined) throw new Error('no agent was registered under that id')

      // Replaced rather than mutated in place, because `Agent` is readonly and the
      // same object is what every authenticated read hands back.
      held.agent = {
        ...held.agent,
        ...(standing.skills === undefined
          ? {}
          : { skills: standing.skills.map((value) => skill(value)) }),
        ...(standing.status === undefined ? {} : { status: standing.status }),
      }
    },
  }
}
