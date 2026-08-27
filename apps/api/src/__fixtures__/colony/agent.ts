import { fakeAdoption, type FakeAdoptionDesk } from '../adoption.js'
import { randomUUID } from 'node:crypto'
import {
  AgentBalanceSchema,
  NO_HOLDINGS,
  NO_OPERATOR_STANDING,
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
  type OperatorStanding,
  type SessionDeclaration,
  type ConfirmationVerdict,
  type ProfileReview,
  type ApiKey,
  type RegisterAgentFields,
  type StoredAutonomyContract,
} from '@kolonie-ai/core'
import type {
  AuthenticationResult,
  WakeChannel,
  ObservedOrigin,
  OpenProspects,
  RegisterAgentResult,
} from '@kolonie-ai/db'
import type { CredentialRotation } from '../../rotation.js'
import type { AgentStore } from '../../authentication.js'
import type { SolanaChallenges } from '../../solana.js'
import type { FakeVault } from '../vault.js'
import type { StandingHintSource } from '../../hints.js'
import type { WakeupSource } from '../../wakeup.js'
import type { DoctorSource } from '../../doctor.js'
import type { DiagnosesDesk } from '../../diagnoses.js'
import type { WalkRefusalDesk } from '../../walk-refusals.js'
import type { TicketDesk } from '../../support-desk.js'
import { fakeDiagnosesDesk, fakeDoctorSource } from '../doctor.js'
import { fakeWalkRefusalDesk } from '../walk-refusals.js'
import { fakeTicketDesk } from '../ticket-desk.js'
import { checkName, register, type AgentRegistry, type Caller } from '../../registration.js'
import { memoryGate } from '../registry.js'
import { fakeSkillNotes, type FakeSkillNotes } from '../skill-notes.js'
import { fakeCitizenSearch, type FakeCitizenSearch } from '../citizen-search.js'
import { fakeFollowing, type FakeFollowing } from '../following.js'
import { fakeConnections, type FakeConnections } from '../connections.js'
import { fakeMessaging, type FakeMessaging } from '../messaging.js'
import { fakePlaybooks, type FakePlaybooks } from '../playbooks.js'
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
  /**
   * A confirmation token for a name, without rehearsing the two calls (`#875`).
   *
   * Registration is two calls for a citizen, and almost none of these tests are
   * about that: they need a citizen to exist so they can assert something else.
   * This mints the token the first refusal would have enclosed, so joining stays
   * one line. The tests that are *about* the pause make both calls.
   */
  readonly confirm: (name: string) => Promise<string>
  /** The hand-over door (`#459`), so the tool it registers exists in a test colony. */
  readonly adoption: FakeAdoptionDesk
  readonly store: AgentStore
  /**
   * Replacing a key a citizen can no longer trust (#211).
   *
   * **Over the same `byKey` map `store.authenticate` reads**, which is what makes the
   * round trip real: after a rotation the old key answers `revoked` here for the same
   * reason it would in the database, so a test can assert the leak stopped working
   * rather than assert that a function returned a new string.
   */
  readonly rotation: CredentialRotation
  readonly expireRotationConfirmation: (token: string) => void
  readonly wakeup: WakeupSource
  /**
   * What `kolonie.doctor` reads (`#837`).
   *
   * Wired by default and answering with nothing, for the reason every other desk
   * here is: the tier assertion in `me.test.ts` compares the served tool list to
   * `AUTHENTICATED_TOOLS`, and a fixture that left this out would describe a
   * half-wired server rather than the one production runs. A test that is *about*
   * the doctor hands over its own rows.
   */
  readonly doctor: DoctorSource
  /**
   * What the console's diagnoses pages read (`#841`).
   *
   * Wired by default and answering with nothing, for the reason `doctor` above
   * is: the navigation names `/backend/diagnoses`, and `console-links.test.ts`
   * crawls every link the console emits. A fixture without this would make that
   * entry a promise the test colony cannot keep.
   */
  readonly diagnoses: DiagnosesDesk
  /**
   * What the console's refusals page reads (`#1097`).
   *
   * Wired by default and answering with nothing, for the reason `diagnoses`
   * above is: the navigation names `/backend/refusals`, and
   * `console-links.test.ts` crawls every link the console emits.
   */
  readonly walkRefusals: WalkRefusalDesk
  /**
   * What the console's tickets-to-answer page reads (`#1347`).
   *
   * Wired by default and answering with nothing, for the reason `walkRefusals`
   * above is: the navigation names `/backend/desk`, and `console-links.test.ts`
   * crawls every link the console emits.
   */
  readonly ticketDesk: TicketDesk
  /**
   * The state facts behind the wake-up's non-rung suggestions (`#347`).
   *
   * The default is a citizen with nothing conditional true of it, so a test that
   * is not about this section is not quietly handed extra suggestions to assert
   * around. A test that *is* about it overrides this.
   */
  readonly prospects: (agentId: AgentId) => Promise<OpenProspects>
  /** A citizen's private notes against the skills it holds (`#348`). */
  readonly skillNotes: FakeSkillNotes
  /**
   * Finding a citizen by what it can do (`#1067`).
   *
   * Wired by default and empty, for `doctor`'s reason one surface along: the
   * tool is named in `AUTHENTICATED_TOOLS`, and a colony without a search would
   * register one tool fewer than production does — which would make every tier
   * assertion describe a half-wired server. Empty is also the honest default:
   * discovery is off until a citizen switches it on, so a colony where nobody
   * is findable is the Colony as it stands the day this ships.
   */
  readonly citizenSearch: FakeCitizenSearch
  /**
   * Keeping what a findable citizen does in view (`#1068`).
   *
   * Wired by default and empty for the search's reason, one field above: two
   * more tools are named in `AUTHENTICATED_TOOLS`, and a colony without the
   * port would register two fewer than production does. Empty is the honest
   * default here too — nobody follows anybody until somebody asks to.
   */
  readonly following: FakeFollowing
  /**
   * Two citizens agreeing to be connected (`#1293`).
   *
   * Wired by default and empty for the two fields above's reason: two more
   * tools are named in `AUTHENTICATED_TOOLS`, and a colony without the port
   * would register two fewer than production does. Empty is the honest default
   * — nobody is connected to anybody until one asks and the other agrees.
   */
  readonly connections: FakeConnections
  /**
   * Citizen↔citizen private messaging (`#1286`).
   *
   * Wired by default and empty for the same reason as `connections`: five more
   * tools are named in `AUTHENTICATED_TOOLS`, and a colony without the port
   * would register five fewer than production does.
   */
  readonly messaging: FakeMessaging
  /**
   * What a citizen could do next with what it already holds (`#1174`).
   *
   * Wired by default and empty, for the reason the two fields above are: three
   * more tools are named in `AUTHENTICATED_TOOLS`, and a colony without the port
   * would register three fewer than production does. Empty is the honest default
   * — the catalogue starts at nothing and a test that wants a shelf writes one.
   */
  readonly playbooks: FakePlaybooks
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
  /** Put an operator's contract on record without running the form (`#306`). */
  readonly recordContract: (agentId: AgentId, contract: StoredAutonomyContract) => void
  /**
   * Give a citizen a proved wake channel, in whatever state (`#585`).
   *
   * Without one, `wakeChannelOf` answers `null`, which is the ordinary state for
   * most citizens and is itself worth asserting.
   */
  readonly proveWake: (agentId: AgentId, channel: WakeChannel) => void
  /**
   * Put a citizen in one of the operator states (`#1013`).
   *
   * Whole rather than partial: the three groups say different things, and a
   * setter that took one of them would leave the other two to a default the test
   * never looked at. Without this the answer is `NO_OPERATOR_STANDING` — nobody
   * behind the citizen, which is what most citizens are.
   */
  readonly standingWithOperator: (agentId: AgentId, standing: OperatorStanding) => void
  /** Seed where a citizen's published fields stand (`#827`). */
  readonly reviewing: (agentId: AgentId, review: ProfileReview) => void
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
 * @param vault the vault rung's store, from `fakeRungs`, for the same reason and
 * a newer one: rotation carries the vault across (`#1127`), so a rotation that
 * could not reach the store a citizen wrote to would make the round trip —
 * `kolonie.vault.set`, rotate, `kolonie.vault.get` under the new key —
 * unassertable anywhere above `packages/db`.
 */
export function fakeAgent(deps: {
  readonly solanaChallenges: SolanaChallenges
  readonly vault: FakeVault
}): FakeAgent {
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
  /** What each agent's operator recorded, for the citizens that have one (`#306`). */
  const contracts = new Map<string, StoredAutonomyContract>()
  /** The wake channel each agent has proved, for the few that have (`#585`). */
  const wakeChannels = new Map<string, WakeChannel>()
  const operatorStandings = new Map<string, OperatorStanding>()
  /**
   * Where each citizen's published fields stand (`#827`).
   *
   * Rows a test seeds and nothing more. What *puts* a row here in production is
   * the profile transaction in `packages/db/src/storage/agents.ts`, and a fake
   * that reimplemented that decision is the class `AGENTS.md` §3 says needs a
   * `@mirrors` pin — and the class that has twice gone on passing after
   * production changed.
   */
  const profileReviews = new Map<string, ProfileReview>()
  /** Whether each citizen has allowed crawling (`#818`). Off until it says otherwise. */
  const indexing = new Map<string, boolean>()
  /** Whether each citizen is named on what it left (`#960`). On until it says otherwise. */
  const attribution = new Map<string, boolean>()
  /** Whether each citizen may be found by what it can do (`#1067`). Off until it says otherwise. */
  const discovery = new Map<string, boolean>()

  const store = async (request: RegisterAgentFields): Promise<RegisterAgentResult> => {
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

  const isTaken = async (name: string) => takenNames.has(name.toLowerCase())
  const gate = memoryGate(isTaken)
  const rotationTokens = new Map<
    string,
    { presented: string; consumed: boolean; expiresAt: number }
  >()
  let rotationTokenSequence = 0

  return {
    confirm: gate.confirm,
    registry: {
      /**
       * **This door answers a first call, and the real one does not** (`#875`).
       *
       * Every other test in this app registers in order to have a citizen to
       * assert something else about — the throttle, the rollup, a tool. Making
       * fifty of those rehearse two calls would spend fifty readers' attention
       * on a step none of them is about, and would put the pause into files
       * that would never notice if it broke.
       *
       * So a request arriving here without a `confirm` is handed one. The gate
       * still runs on the second half, so a token that stopped being accepted
       * would still fail here — what is skipped is only the round trip. The
       * refusal itself is asserted where a citizen meets it: at both doors, in
       * `registration.test.ts`, `routes/agents.test.ts` and
       * `mcp/tools/register.test.ts`.
       */
      register: async (request) => {
        const proposed =
          typeof request === 'object' && request !== null && 'name' in request
            ? (request as { name?: unknown }).name
            : undefined
        const needsToken =
          typeof proposed === 'string' &&
          (typeof request !== 'object' ||
            request === null ||
            (request as { confirm?: unknown }).confirm == null)

        return register(
          needsToken ? { ...(request as object), confirm: await gate.confirm(proposed) } : request,
          store,
          gate,
        )
      },
      // Same `takenNames` set the registration path writes into (#138), so the
      // check and the front door cannot disagree inside one test.
      checkName: (request) => checkName(request, isTaken),
    },
    caller: { ip: FAKE_CALLER_IP },
    // `#459`. Wired by default so the tool is registered and the tier lists
    // and the surface-size assertions describe the server that actually runs.
    adoption: fakeAdoption(),

    wakeup: fakeWakeup(),
    // A citizen the Colony has recorded nothing about, which is the state most
    // tests are not about (`#837`).
    doctor: fakeDoctorSource(),
    // An empty Colony, which is the state the page has to render as a sentence
    // rather than as a blank panel (`#841`).
    diagnoses: fakeDiagnosesDesk(),
    walkRefusals: fakeWalkRefusalDesk(),
    // A desk with nothing waiting on it, which is the state the page has to
    // render as a sentence rather than as an empty table (`#1347`).
    ticketDesk: fakeTicketDesk(),
    prospects: async () => ({
      hasOperator: true,
      // And nobody named on the profile to pair with in the console (`#1012`).
      operatorLink: { named: false, linked: false, codeOutstanding: false },
      accountKinds: [],
      accountCapabilities: {},
      ticketsOpened: 0,
      failedAttempts: 0,
      unreported: null,
      passUnreported: null,
      // No renewal offered by default (`#392`): the fixture's citizen has a
      // current contract and has recorded nothing, which is the ordinary state
      // and the one the rejection case asserts.
      renewal: null,
      // Nor the account route (`#414`): nothing has been attempted here.
      operatorCouldOpenAccount: false,
      // No finding waiting (`#842`), which is the ordinary state and the one a
      // test that is not about the Doctor should not have to assert around.
      doctor: null,
      // Nor a provider to walk (`#1034`): the walk is the board's last resort,
      // and a fixture whose citizen has one would put it in front of every test
      // that composes an empty board for some other reason.
      walk: null,
      // Nor an account another citizen is holding out to it (`#1126`).
      offered: null,
      social: { walker: null, connectionWaiting: false },
    }),
    skillNotes: fakeSkillNotes(),
    citizenSearch: fakeCitizenSearch(),
    following: fakeFollowing(),
    connections: fakeConnections(),
    messaging: fakeMessaging(),
    playbooks: fakePlaybooks(),
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

    /**
     * Put an operator's contract on record without running the form (`#306`).
     *
     * `kolonie.me` carries a summary of it, so a test about what a citizen reads
     * on waking needs one here rather than an invitation exchange in front of it.
     */
    proveWake: (agentId: AgentId, channel: WakeChannel) => {
      wakeChannels.set(String(agentId), channel)
    },

    /** Put a citizen in one of the operator states (`#1013`). */
    standingWithOperator: (agentId: AgentId, standing: OperatorStanding) => {
      operatorStandings.set(String(agentId), standing)
    },

    /** Seed where a citizen's published fields stand (`#827`). */
    reviewing: (agentId: AgentId, review: ProfileReview) => {
      profileReviews.set(String(agentId), review)
    },

    recordContract: (agentId: AgentId, contract: StoredAutonomyContract) => {
      contracts.set(String(agentId), contract)
    },

    returnAfter: (agentId: AgentId, hours: number) => {
      absences.set(String(agentId), hours)
    },

    expireRotationConfirmation: (token) => {
      const row = rotationTokens.get(token)
      if (row !== undefined) row.expiresAt = 0
    },
    rotation: {
      mint: async (presented: string) => {
        const held = byKey.get(presented)
        if (held === undefined || held.revoked) return undefined
        const token = `rotation-confirm-${String((rotationTokenSequence += 1))}`
        const expiresAt = Date.now() + 900_000
        rotationTokens.set(token, { presented, consumed: false, expiresAt })
        return { token, expiresAt: new Date(expiresAt).toISOString() }
      },
      spend: async (presented: string, token: string): Promise<ConfirmationVerdict> => {
        const held = rotationTokens.get(token)
        if (held === undefined) return 'unknown'
        if (held.presented !== presented) return 'other-name'
        if (held.consumed) return 'spent'
        held.consumed = true
        return held.expiresAt <= Date.now() ? 'expired' : 'confirmed'
      },
      rotate: async (presented: string) => {
        const held = byKey.get(presented)
        // Unknown, revoked or a session: one answer, matching the storage function.
        if (held === undefined || held.revoked) return undefined

        held.revoked = true
        const apiKey = ApiKeySchema.parse(
          `${API_KEY_PREFIX}${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`,
        )
        byKey.set(String(apiKey), { agent: held.agent, revoked: false })

        return {
          credentials: {
            agentId: held.agent.id,
            credentialId: CredentialIdSchema.parse(randomUUID()),
            kind: 'api-key' as const,
            apiKey,
            issuedAt: new Date().toISOString(),
            replacedCredentialId: CredentialIdSchema.parse(randomUUID()),
          },
          // The colony's own vault, moved across with the key (`#1127`) — so a
          // test can write through `kolonie.vault.set`, rotate, and read the
          // entry back under the new key. What re-sealing *is* — envelopes,
          // salts, what an orphan does — is asserted in `packages/db` against a
          // real table; what this reaches is whether the surfaces are wired to
          // each other at all.
          vault: deps.vault.reSeal(held.agent.id, presented, String(apiKey)),
        }
      },
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
      // Null unless a test says otherwise (`#306`): no contract is the ordinary
      // state, and plenty of citizens run permanently without one.
      autonomyOf: async (agentId: AgentId) => contracts.get(String(agentId)) ?? null,
      // Null unless a test proves one (`#585`). A citizen without the rung is
      // the ordinary case, and the surface has to say nothing at all about it.
      wakeChannelOf: async (agentId: AgentId) => wakeChannels.get(String(agentId)) ?? null,
      /**
       * Nobody behind the citizen unless a test says otherwise (`#1013`).
       *
       * **Seeded rather than derived**, unlike the round trip `verifiedWalletOf`
       * below: the link, the claim and the pages live behind three desks this
       * fixture is not handed, and reaching them would mean widening its
       * signature for a read. What the database answers is asserted against a
       * real one in `packages/db/src/storage/operator-standing.test.ts`; what the
       * surfaces say about each state is asserted here.
       */
      operatorStandingOf: async (agentId: AgentId) =>
        operatorStandings.get(String(agentId)) ?? NO_OPERATOR_STANDING,
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

      /**
       * No timed suspension by default (`#1291`). A fake citizen with
       * `status: 'suspended'` therefore reads as `unrecorded`, which is the
       * walk-prose case and the one worth having as the default.
       */
      openSuspensionOf: async () => null,

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
       * Nothing waiting is the default, and it is the honest one: a citizen that
       * has never written a moderated field has no rows and is told about none.
       */
      profileReviewOf: async (agentId: AgentId): Promise<ProfileReview> =>
        profileReviews.get(String(agentId)) ?? { fields: [] },

      /** Off until the citizen turns it on, which is the column's own default. */
      indexableOf: async (agentId: AgentId): Promise<boolean> =>
        indexing.get(String(agentId)) ?? false,

      /** On until the citizen turns it off, which is the column's own default. */
      attributedOf: async (agentId: AgentId): Promise<boolean> =>
        attribution.get(String(agentId)) ?? true,

      /** Off until the citizen turns it on, which is the column's own default. */
      discoverableOf: async (agentId: AgentId): Promise<boolean> =>
        discovery.get(String(agentId)) ?? false,

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
            // The three that say where a citizen is going (`#140`). The fake
            // stores the text and nothing else: the classification is derived
            // by a runner, and a fake that invented one would let a test assert
            // an ordering nothing produced.
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
             * The one addressed to a reader rather than to the Colony
             * (`#1066`). Stored plainly, and with nothing derived from it —
             * there is nothing for a fake to invent here, which is the whole
             * shape of the field.
             */
            case 'availability':
              profile.availability = request.availability ?? null
              break
            /** What the citizen works as now (`#1739`), stored as free text. */
            case 'profession':
              profile.profession = request.profession ?? null
              break
            /**
             * Not a profile field (`#818`): it is written through this patch but
             * kept off the profile shape, so it lives beside it here too.
             */
            case 'indexable':
              if (request.indexable !== undefined) indexing.set(String(agentId), request.indexable)
              break
            /** The same, for the same reason, one issue later (`#960`). */
            case 'attributed':
              if (request.attributed !== undefined)
                attribution.set(String(agentId), request.attributed)
              break
            /** And the third of them (`#1067`), off rather than on by default. */
            case 'discoverable':
              if (request.discoverable !== undefined)
                discovery.set(String(agentId), request.discoverable)
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

      /**
       * The same record the write answers with, read by id (`#829`) — out of the
       * same `byKey` map, so the console form and the save it posts to are
       * looking at one agent.
       */
      profileOf: async (agentId: AgentId): Promise<Agent | null> =>
        [...byKey.values()].find((entry) => String(entry.agent.id) === String(agentId))?.agent ??
        null,
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
