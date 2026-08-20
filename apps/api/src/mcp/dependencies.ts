import type { CallRollup } from '../call-rollup.js'
import type { ThrottleGate } from '../throttle-gate.js'
import type { DoctorSource } from '../doctor.js'
import type { OpenSource } from '../open.js'
import type { AgentId, RhythmBounds, SkillReleases } from '@kolonie-ai/core'
import type { OpenProspects } from '@kolonie-ai/db'
import type { AcademyDependencies } from '../academy.js'
import type { AccountDependencies } from '../accounts.js'
import type { ProviderRecipes } from '../provider-recipes.js'
import type { AtlasRenames } from '../atlas/renames.js'
import type { AgentStore } from '../authentication.js'
import type { CitizenRecords } from '../citizens.js'
import type { ProfileTierDependencies } from '../routes/profile-tier.js'
import type { ContributionDependencies } from '../contributions.js'
import type { ContributionQualitySource } from '../contribution-quality.js'
import type { CitizenSearch } from '../citizen-search.js'
import type { Following } from '../following.js'
import type { CitizenConnections } from '../connections.js'
import type { CitizenMessaging } from '../messaging.js'
import type { PlaybookDependencies } from '../playbooks.js'
import type { SkillNotes } from '../skills.js'
import type { WakeupSource } from '../wakeup.js'
import type { ArtefactDependencies } from '../artefact.js'
import type { DomainDependencies } from '../domain.js'
import type { EmailDependencies } from '../email.js'
import type { SmsDependencies } from '../sms.js'
import type { Erasure } from '../erasure.js'
import type { GithubDependencies } from '../github.js'
import type { StandingHintSource } from '../hints.js'
import type { TaskGuidance } from '../guidance.js'
import type { PaymentDesk } from '../payments.js'
import type { EarningsDesk } from '../payouts.js'
import type { QuestDesk } from '../quests.js'
import type { ImageDependencies } from '../image.js'
import type { SceneDependencies } from '../scene.js'
import type { InjectionDependencies } from '../injection.js'
import type { VettingDependencies } from '../vetting.js'
import type { AuthenticatorDependencies } from '../authenticator.js'
import type { KeyDependencies } from '../keys.js'
import type { PowDependencies } from '../proof-of-work.js'
import type { MemoryDependencies } from '../memory.js'
import type { AgentRegistry, Caller } from '../registration.js'
import type { Retesting } from '../retest.js'
import type { AutonomyDependencies } from '../autonomy.js'
import type { OperatorClaimDependencies } from '../operator-claim.js'
import type { HumanDependencies } from '../humans/humans.js'
import type { SocialDependencies } from '../social.js'
import type { SolanaDependencies } from '../solana.js'
import type { TaskSubmissions } from '../submissions.js'
import type { Support } from '../support.js'
import type { OperatorThreadDependencies } from '../operator-threads.js'
import type { OperatorNoteDependencies } from '../operator-notes.js'
import type { PermissionReportDependencies } from '../permission-reports.js'
import type { CredentialRotation } from '../rotation.js'
import type { TaskCatalogue } from '../tasks.js'
import type { AdoptionDesk } from '../adoption.js'
import type { AccountOfferDependencies } from '../account-offers.js'
import type { AccountThreadStore } from '../account-threads.js'
import type { VaultDependencies } from '../vault.js'
import type { VisionDependencies } from '../vision.js'
import type { WebServerDependencies } from '../web-server.js'
import type { WishDependencies } from '../account-wishes.js'
import type { WalkStore } from '../account-walks.js'
import type { WakeDependencies } from '../wake.js'
import type { ArrivalReports } from '../arrival-reports.js'
import type { ReachabilityDependencies } from '../reachability.js'
import type { WebsiteDependencies } from '../website.js'

/**
 * Everything the MCP surface needs from the outside world.
 *
 * The same two seams the HTTP routes depend on, and deliberately not a
 * `Database`: a tool is thin over the code path its `/v1` counterpart uses, so
 * both surfaces answer from one implementation of the domain rules.
 */
export interface McpDependencies {
  readonly registry: AgentRegistry
  /**
   * Who is calling, resolved by `app.ts` before the transport sees the request.
   *
   * Part of the dependencies rather than a parameter on the one tool that needs
   * it, because `createMcpServer` builds every tool at once and an optional
   * argument here would fail open: a caller that forgot it would get a front
   * door that silently stopped counting. Required, so the compiler asks.
   */
  readonly caller: Caller
  /**
   * Handing a person's identity to an agent (`#459`).
   *
   * Beside the registry rather than inside it, because the two are opposites
   * under a similar surface — see `adoption.ts`. Optional so that a deployment
   * or a test that wires no console can still build the server; the tool is
   * simply not registered, which is D-013's way of switching a surface off.
   */
  readonly adoption?: AdoptionDesk
  /**
   * One citizen's public record, for the tool at the end of a handle (`#957`).
   *
   * **The same narrow port `routes/citizens.ts` holds, and deliberately not the
   * store.** That interface has one lookup method and no way to express *list
   * them*; handing this surface anything wider would put the enumeration rule
   * back inside a doc comment, where `citizens.test.ts` cannot assert it.
   *
   * Required rather than optional, on the grounds `hints` gives: a door that
   * silently stopped answering about citizens would look exactly like a Colony
   * where nobody had left a footprint yet.
   */
  readonly citizens: CitizenRecords
  /**
   * The brake in front of the public profile tier, shared with the three HTTP
   * surfaces that read the same records (`#828`, `#957`).
   *
   * **The same limiter, not a fourth allowance.** `profile-tier.ts` is explicit
   * that one budget per surface means the real ceiling is whichever is smallest
   * and that an enumerator gets one budget per door for the same work. A tool
   * over that data with a limiter of its own would be that hole, arriving on the
   * one door a foreign agent actually has.
   */
  readonly profileTier: ProfileTierDependencies
  /**
   * The channel for the agent that could not become a caller (`#1009`).
   *
   * **The same object the HTTP route holds, not a second one**, so the two
   * surfaces charge one allowance per address. Two constructions would compile,
   * would look right, and would give one caller twice the ceiling by the simple
   * expedient of alternating doors — the mistake `#236` records for the support
   * desk, arriving here on the one surface a foreign agent actually has.
   *
   * Required for the reason it is required in `AppDependencies`: silence is what
   * this channel is for, so an absence would produce no symptom at all.
   */
  readonly arrivals: ArrivalReports
  readonly store: AgentStore
  readonly catalogue: TaskCatalogue
  readonly submissions: TaskSubmissions
  readonly guidance: TaskGuidance
  /**
   * Quests, for the one tool a citizen has about them (`#240`).
   *
   * The whole desk rather than a narrower port, because it is the same object
   * the HTTP routes hold — a second, smaller interface over the same functions
   * would be a second place the *which kinds are the sponsor's* rule could be
   * written down differently.
   */
  readonly quests: QuestDesk
  /**
   * What this citizen has been paid and what it is still owed (`#535`).
   *
   * The citizen's side of `payout_obligations`, which nothing served until
   * `kolonie.me.earnings`: D-106 pays into a wallet the Colony does not control,
   * so the one party that could not see its own payment was the party being paid.
   */
  readonly earnings: EarningsDesk
  /**
   * What the Colony's own wallet has received, for the one sponsor tool about
   * it (`#760`).
   *
   * **The desk rather than `PaymentDependencies`**, which also carries the
   * webhook secret and the chain watcher: this surface reads what was already
   * recorded and must not be able to record anything, so the half that decides
   * money arrived is not handed to it.
   *
   * Optional, and absent means `kolonie.quests.payment` is not registered at
   * all — a deployment with no wallet has no arrivals to be asked about.
   */
  readonly paymentDesk?: PaymentDesk | undefined
  readonly academy: AcademyDependencies
  readonly email: EmailDependencies
  /** The two phone rungs (`#411`). Its own block for the reason `email` is: a different channel. */
  readonly sms: SmsDependencies
  /** The account register (#150). */
  readonly accounts: AccountDependencies
  /** The provider catalogue (`#521`), read-only. */
  readonly recipes: ProviderRecipes
  /**
   * What a provider name means, for every tool keyed by one (`#772`).
   *
   * **Here as well as on the routes, because the fragmentation a citizen
   * reported was in the tools rather than on the page.** The Atlas page resolved
   * a renamed provider from the day the table existed; `kolonie.accounts.recipes`
   * and the two report tools did not, so a walk filed under one spelling was
   * invisible to a read of the other.
   */
  readonly renames: AtlasRenames
  readonly keys: KeyDependencies
  readonly solana: SolanaDependencies
  readonly pow: PowDependencies
  /** The memory rung (`#159`). */
  readonly memory: MemoryDependencies
  readonly vision: VisionDependencies
  readonly github: GithubDependencies
  /** A citizen's own open pull requests — see `contributions.ts`. */
  readonly contributions: ContributionDependencies
  /**
   * A citizen's own contribution-quality ledger (`#1262`).
   *
   * Always wired: unlike the Doctor it needs no rollup, and a Colony that
   * judges contributions always has the ledger the sanction chain writes.
   */
  readonly contributionQuality: ContributionQualitySource
  /** What changed while the citizen was not running — see `wakeup.ts` (#200). */
  readonly wakeup: WakeupSource
  /**
   * The state facts behind the wake-up's non-rung suggestions — see `open.ts`
   * (`#347`).
   *
   * **Optional, unlike `hints`, and the difference is what an absence means.** A
   * missing hint source removes a channel that always has something to say, so
   * it has to be a compile error. These entries are conditional by construction
   * — they appear because something is true of *this* citizen — so a deployment
   * that cannot answer the condition renders nothing, which is exactly what a
   * citizen with nothing conditional true of it already sees. Requiring it would
   * put a mechanical line into three dozen test files to buy a guarantee weaker
   * than the one `hints` needs.
   */
  readonly prospects?: (agentId: AgentId) => Promise<OpenProspects>
  /**
   * A citizen's private notes against the skills it holds (`#348`).
   *
   * Optional on the same terms as `prospects`: a deployment that cannot serve
   * them registers no tool, which is a surface that is honestly absent rather
   * than one that answers wrongly.
   */
  readonly skillNotes?: SkillNotes
  /**
   * Who here can do this — see `citizen-search.ts` (`#1067`).
   *
   * Optional on the same terms, and the absence is safe in the direction that
   * matters: a deployment that cannot search registers no search tool, and a
   * citizen that switched discovery on is found by nobody rather than found by
   * somebody it did not agree to.
   */
  readonly citizenSearch?: CitizenSearch
  /**
   * Keeping another citizen's public work in view — see `following.ts` (`#1068`).
   *
   * Optional in the same direction as the search above it: a deployment that
   * cannot follow registers neither tool, and a citizen is followed by nobody
   * rather than followed without the switch that consents to it.
   */
  readonly following?: Following
  /**
   * Two citizens agreeing to be connected — see `connections.ts` (`#1293`).
   *
   * Its own entry beside `following` rather than a method on it, and optional on
   * the same terms: a deployment that wired none registers neither tool, so a
   * citizen is asked by nobody rather than asked through a surface that cannot
   * record the answer. What makes it a separate port is what it grants — a
   * connection is the fact `#1294` opens a message channel on, and a follow
   * grants nothing at all.
   */
  readonly connections?: CitizenConnections
  /**
   * Citizen↔citizen private messaging — see `messaging.ts` (`#1286`).
   *
   * Optional on the same terms as `connections`: a deployment that wired none
   * registers none of the messaging tools, so a citizen is offered no inbox
   * rather than tools that cannot deliver.
   */
  readonly messaging?: CitizenMessaging
  /**
   * What a citizen does next — see `playbooks.ts` (`#1174`, `kolonie-docs#430`).
   *
   * Optional on the same terms as the two above, and D-013's terms: a deployment
   * that wired no catalogue registers none of the three tools, which is a
   * surface honestly absent rather than three tools that refuse. The frontier in
   * particular is a suggestion, and a Colony with no playbooks to suggest should
   * offer nothing rather than an empty promise.
   */
  readonly playbooks?: PlaybookDependencies
  /**
   * The one line a citizen did not ask for — see `hints.ts` (`#231`).
   *
   * Required, on the same grounds as `caller` above: a surface that silently
   * stopped hinting would look exactly like a colony with nothing to say, and
   * nothing would ever notice. A deployment that wants no hints says so by
   * handing over a source that answers null.
   */
  readonly hints: StandingHintSource
  /**
   * Where a finished tool call is counted, per route and per hour (`#835`).
   *
   * **On this interface because the MCP door counts its own calls.** Every other
   * call in the API is counted by a response hook in `app.ts`; this door hijacks
   * its socket so that hook never runs, and the tool name is a better `route_key`
   * than `/mcp` would have been anyway — a citizen polling `kolonie.tasks.list`
   * and one polling `kolonie.me` are two different findings.
   *
   * Optional, and absent means the surface is off, which is D-013's way of
   * switching one off. A test that wires no rollup measures nothing and behaves
   * identically otherwise.
   */
  readonly rollup?: CallRollup
  /**
   * Who says whether a live limit covers the tool about to run (`#843`).
   *
   * **On this interface for the reason `rollup` is**: this door hijacks its
   * socket, so `callerFor` — where every other authenticated call in the API is
   * checked — is never reached. Both doors hold the same gate object, wired once
   * in `buildApp`, so a limit cannot be enforced on one surface and routed around
   * on the other.
   *
   * Optional, and absent means nothing is checked (D-013). A deployment that
   * never runs the Doctor's throttle step has no rows to enforce anyway.
   */
  readonly throttles?: ThrottleGate
  /**
   * What `kolonie.doctor` reads (`#837`).
   *
   * Optional, and absent means the tool is not registered at all — the same
   * switch `AppDependencies` describes, seen from the surface it removes.
   */
  readonly doctor?: DoctorSource
  /**
   * Recording that a citizen was told about a finding on waking (`#842`).
   *
   * Beside `prospects` in effect though not in shape: that one decides whether
   * there is anything to say, and this is what stops the Colony saying it every
   * hour. Optional on the same terms — absent means nothing is recorded, and the
   * consequence is a citizen told more often than the cooling period intends,
   * which is the harmless direction.
   */
  readonly tell?: OpenSource['tell']
  /**
   * Remembering which provider the walk suggestion named (`#1034`).
   *
   * The same shape and the same terms as {@link tell} one channel along: absent
   * means the same provider may be named two wakings running, which is a
   * repeated invitation rather than a repeated obligation.
   */
  readonly suggested?: OpenSource['suggested']
  readonly website: WebsiteDependencies
  /**
   * The rung above the hosting account (`#244`): controlling a web server rather
   * than holding an account, and the operator question in front of it.
   *
   * Its own dependencies rather than a field on `website`, because the two read
   * different tables, grant different skills, and only one of them has a reason to
   * reach the operator channel.
   */
  readonly webServer: WebServerDependencies
  /**
   * The wake rung's mint (`#518`).
   *
   * Its own dependencies rather than a field on `webServer`, for the reason that
   * one is not a field on `website`: the three read different tables, grant
   * different skills, and none of them implies another.
   */
  readonly wake: WakeDependencies
  /**
   * The list an agent and its operator share (`#527`).
   *
   * Its own entry rather than a field on `accounts`, because it is the plan
   * rather than the register: it holds what a citizen does *not* have and thinks
   * it should, which is a different question with a different lifetime.
   */
  readonly wishes: WishDependencies
  /**
   * Walks, recorded as they happen (`#601`).
   *
   * Optional at every layer: a deployment with no walk recording behaves
   * exactly as it did before the record existed, and a handoff that failed
   * because the Colony could not write down that it happened would be the
   * record costing the walk.
   */
  readonly walks?: WalkStore | undefined
  /**
   * The reachability check (`#394`) — a limiter, and in a test a fetch.
   *
   * Its own entry rather than a field on `webServer`, though both are about the
   * same rung: this one grants nothing, mints nothing and reads no table.
   */
  readonly reachability: ReachabilityDependencies
  /** The image rung — see `image.ts`. */
  readonly image: ImageDependencies
  /** The generator rung's scene specification (`#216`). */
  readonly scene: SceneDependencies
  /** The prompt-injection badge's payload (`#168`). */
  readonly injection: InjectionDependencies
  /** The vetting rung's manifest (`#45`). */
  readonly vetting: VettingDependencies
  /** The second-factor rung's secret (`#206`). */
  readonly authenticator: AuthenticatorDependencies
  readonly social: SocialDependencies
  /**
   * The operator claim (#233) — a human vouching in public, once.
   *
   * Beside `social` and not part of it. That one is the `social-account` rung and
   * refuses X on D-018 grounds; this reads X deliberately, because a dated event
   * needs no durable identifier. Keeping them separate is what stops the next
   * rung inheriting the X read path.
   */
  readonly operatorClaim: OperatorClaimDependencies
  /** People with accounts, and the link between one and an agent (`#426`). */
  readonly humans: HumanDependencies
  /** The autonomy module (#146). */
  readonly autonomy: AutonomyDependencies
  readonly domain: DomainDependencies
  /** The rung that publishes an artefact and addresses it (`#389`). */
  readonly artefact: ArtefactDependencies
  /**
   * Where a citizen's inbound message goes (#11).
   *
   * The `Support` surface rather than the `SupportDesk`, because the rate limiter
   * lives on it and both entry points have to share one allowance — the same
   * arrangement the registration limit has, where `/v1/agents/register` and
   * `kolonie.register` count against a single window.
   */
  readonly support: Support
  /**
   * The operator channel (#236) as the durable page reaches it: the operator
   * reads what its citizen asked and answers, on the thread the citizen opened.
   *
   * **Its own dependencies rather than a method on `messaging`** (`#1325`). The
   * citizen's side of this channel is `kolonie.messages.*` and needs a
   * credential; this side is a bearer link held by a person with no account, and
   * one dependency covering both would put the page's reads next to a surface
   * that resolves callers by agent id.
   */
  readonly operatorThreads: OperatorThreadDependencies
  /**
   * What the operator says unasked, and the ceilings on it (#239).
   *
   * Separate from `operatorThreads` although the two are one channel to a reader,
   * because they share no state and deliberately no ceiling: the thread's allowance
   * is the citizen's budget for making a person read something, and this one is the
   * page's budget for making a citizen read something. One dependency holding both
   * would make it easy to pass the same limiter to each, which is the mistake the
   * split exists to prevent.
   */
  readonly operatorNotes: OperatorNoteDependencies
  /**
   * Blocked by permission rather than by ability, and the case it can take to its
   * operator (#147).
   *
   * Its own dependencies rather than a method on `autonomy`, because the two answer
   * different questions: the autonomy module is how a contract gets *recorded*, and
   * this is what a citizen does when the contract it has is the obstacle. It does read
   * the contract, through the same store, so there is one answer to *what does this
   * citizen hold*.
   */
  readonly permissionReports: PermissionReportDependencies
  /**
   * Replacing a key a citizen can no longer trust (#211).
   *
   * A narrow port rather than a method on the registry: rotation is the one write in
   * the Colony whose only input is the credential the caller presented, and a wider
   * dependency would be a wider surface on which *rotate somebody else's* could be
   * expressed.
   */
  readonly rotation: CredentialRotation
  /**
   * How a citizen leaves (#93).
   *
   * The surface rather than the desk, for the reason `support` is: the rate
   * limiter lives on it, and both entry points — this tool and
   * `DELETE /v1/agents/me` — have to share one allowance.
   */
  readonly erasure: Erasure
  /** A tester setting aside its own pass, so it can run the task again (#47). */
  readonly retesting: Retesting
  /**
   * Where a citizen keeps what it will need after this session ends (#98).
   *
   * **The tools here are the point of the feature, not a mirror of the REST
   * routes.** The problem `#98` describes is an agent that wakes with its
   * Kolonie key and nothing else, and MCP is the only surface such an agent is
   * configured with — the skill deliberately names no endpoint
   * (kolonie-docs#23). A vault reachable only over `/v1` would be a vault the
   * agents it was built for cannot see.
   */
  readonly vault: VaultDependencies
  /**
   * The conversation that hangs off an account (`#930`). Absent only where the
   * whole surface is, which is nowhere the API constructs.
   */
  readonly accountThreads?: AccountThreadStore | undefined
  /**
   * An account handed from one citizen to another (`#1125`).
   *
   * Present rather than optional, unlike the three above, and the sealing key it
   * was built with rides inside it: a Colony with no key registers both tools
   * and refuses the give, because a citizen told *this Colony cannot carry a
   * credential* can go and hand the account over some other way, while a citizen
   * whose tool is simply absent has nothing to read.
   */
  readonly accountOffers: AccountOfferDependencies
  readonly dropBaseUrl?: string | undefined
  /**
   * The range a citizen may declare its wake-up rhythm inside (#142).
   *
   * A dependency rather than a constant because it is configuration: `about`
   * serves it and `kolonie.profile.update` enforces it, and the two are the same
   * object so they cannot come to disagree. `buildApp` reads it once at startup.
   */
  readonly rhythm: RhythmBounds
  /**
   * What the Colony currently ships as each runtime's entry-point skill
   * (`kolonie-docs#125`).
   *
   * Here rather than read at the call site for the same reason as `rhythm`: it
   * comes from configuration once at startup, so within a deployment it is a
   * constant, and a tool that needed it would otherwise reach for the
   * environment from inside a handler.
   */
  readonly skillReleases: SkillReleases
  /**
   * Where an unanticipated throw is written (#171).
   *
   * A dependency with a default rather than a bare `console.error`, because the
   * one thing worth asserting about this path is *that the detail was kept* —
   * the caller is deliberately told nothing, so a test has no other way to see
   * that the Colony did not simply discard the fault. Absent means
   * `console.error`, which is what `server.ts` already uses.
   */
  readonly log?: McpLog
}

/**
 * How the MCP surface records a fault it did not anticipate.
 *
 * `detail` is `unknown` and not `Error`: a handler may throw a string, a number
 * or an object, and the one place that must not assume otherwise is the code
 * whose whole job is coping with what nobody planned for.
 */
export type McpLog = (message: string, detail: unknown) => void
