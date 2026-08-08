import type { AgentId, RhythmBounds, SkillReleases } from '@kolonie-ai/core'
import type { OpenProspects } from '@kolonie-ai/db'
import type { AcademyDependencies } from '../academy.js'
import type { AccountDependencies } from '../accounts.js'
import type { ProviderRecipes } from '../provider-recipes.js'
import type { AgentStore } from '../authentication.js'
import type { ContributionDependencies } from '../contributions.js'
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
import type { OperatorRequestDependencies } from '../operator-requests.js'
import type { OperatorNoteDependencies } from '../operator-notes.js'
import type { PermissionReportDependencies } from '../permission-reports.js'
import type { CredentialRotation } from '../rotation.js'
import type { TaskCatalogue } from '../tasks.js'
import type { AdoptionDesk } from '../adoption.js'
import type { DropStore } from '../operator-drops.js'
import type { VaultDependencies } from '../vault.js'
import type { VisionDependencies } from '../vision.js'
import type { WebServerDependencies } from '../web-server.js'
import type { WakeDependencies } from '../wake.js'
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
  readonly academy: AcademyDependencies
  readonly email: EmailDependencies
  /** The two phone rungs (`#411`). Its own block for the reason `email` is: a different channel. */
  readonly sms: SmsDependencies
  /** The account register (#150). */
  readonly accounts: AccountDependencies
  /** The provider catalogue (`#521`), read-only. */
  readonly recipes: ProviderRecipes
  readonly keys: KeyDependencies
  readonly solana: SolanaDependencies
  readonly pow: PowDependencies
  /** The memory rung (`#159`). */
  readonly memory: MemoryDependencies
  readonly vision: VisionDependencies
  readonly github: GithubDependencies
  /** A citizen's own open pull requests — see `contributions.ts`. */
  readonly contributions: ContributionDependencies
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
   * The one line a citizen did not ask for — see `hints.ts` (`#231`).
   *
   * Required, on the same grounds as `caller` above: a surface that silently
   * stopped hinting would look exactly like a colony with nothing to say, and
   * nothing would ever notice. A deployment that wants no hints says so by
   * handing over a source that answers null.
   */
  readonly hints: StandingHintSource
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
   * The operator channel (#236): a citizen asks its operator for something it
   * cannot do itself, and reads the answer.
   *
   * Its own dependencies rather than a method on `autonomy`, because it holds a
   * different thing: the contract is a form that is filled in once, and this is an
   * exchange that stays open. It does share the support desk's outbound allowance,
   * which is wired in `server.ts` and is the reason both are surfaces rather than
   * desks.
   */
  readonly operatorRequests: OperatorRequestDependencies
  /**
   * What the operator says unasked, and the ceilings on it (#239).
   *
   * Separate from `operatorRequests` although the two are one channel to a reader,
   * because they share no state and deliberately no ceiling: the exchange's allowance
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
   * The operator-to-agent secret channel (`#410`). Absent when unconfigured, and
   * the tools say so rather than failing.
   */
  readonly drops?: DropStore | undefined
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
