import type { AgentId, Log, RhythmBounds, SkillReleases } from '@kolonie-ai/core'
import type { OpenProspects } from '@kolonie-ai/db'
import type { AcademyDependencies } from './academy.js'
import type { AccountDependencies } from './accounts.js'
import type { AgentStore } from './authentication.js'
import type { ConsoleDependencies } from './console.js'
import type { ContributionDependencies } from './contributions.js'
import type { StandingHintSource } from './hints.js'
import type { SkillNotes } from './skills.js'
import type { WakeupSource } from './wakeup.js'
import type { DomainDependencies } from './domain.js'
import type { EmailDependencies } from './email.js'
import type { Erasure } from './erasure.js'
import type { GithubDependencies } from './github.js'
import type { TaskGuidance } from './guidance.js'
import type { ImageDependencies } from './image.js'
import type { SceneDependencies } from './scene.js'
import type { InjectionDependencies } from './injection.js'
import type { VettingDependencies } from './vetting.js'
import type { AuthenticatorDependencies } from './authenticator.js'
import type { KeyDependencies } from './keys.js'
import type { PowDependencies } from './proof-of-work.js'
import type { MemoryDependencies } from './memory.js'
import type { RateLimiter } from './rate-limit.js'
import type { AgentRegistry } from './registration.js'
import type { Retesting } from './retest.js'
import type { AutonomyDependencies } from './autonomy.js'
import type { OperatorClaimDependencies } from './operator-claim.js'
import type { SocialDependencies } from './social.js'
import type { SolanaDependencies } from './solana.js'
import type { TaskSubmissions } from './submissions.js'
import type { Support } from './support.js'
import type { OperatorNoteDependencies } from './operator-notes.js'
import type { OperatorRequestDependencies } from './operator-requests.js'
import type { PermissionReportDependencies } from './permission-reports.js'
import type { CredentialRotation } from './rotation.js'
import type { DepositDependencies } from './deposits.js'
import type { QuestDesk } from './quests.js'
import type { TaskCatalogue } from './tasks.js'
import type { VaultDependencies } from './vault.js'
import type { VisionDependencies } from './vision.js'
import type { WebServerDependencies } from './web-server.js'
import type { WebsiteDependencies } from './website.js'

/**
 * What a deployment hands `buildApp`.
 *
 * **The seam between the process and the Colony**, and the only place either
 * knows about the other: `server.ts` reads the environment and builds these,
 * `buildApp` turns them into a server, and nothing in between names a database,
 * a vendor or a host. See `routes/dependencies.ts` for the resolved form the
 * route modules receive, and how the two differ.
 */
export interface AppDependencies {
  /** The Browser Capability Gate — see `academy.ts` and D-024. */
  readonly academy: AcademyDependencies
  /** The mailbox rung — see `email.ts`. */
  readonly email: EmailDependencies
  /**
   * The keypair rung — see `keys.ts`.
   *
   * No `unavailableReason` counterpart, and no 503 branch below. It reads
   * through nothing, so there is no configuration whose absence could take it
   * down while the rest of the API serves.
   */
  readonly keys: KeyDependencies
  /**
   * The wallet rung — see `solana.ts`.
   *
   * No `unavailableReason` counterpart and no 503 branch, for the same reason as
   * `keys`: a Solana address is an Ed25519 public key, so this rung checks a
   * signature rather than reading a chain. It holds no RPC endpoint and no API
   * key, which is what makes the on-chain half of the Academy start from
   * something nobody outside the Colony can switch off.
   */
  readonly solana: SolanaDependencies
  /** The compute rung — see `proof-of-work.ts`. */
  readonly pow: PowDependencies
  /** The memory rung (`#159`). */
  readonly memory: MemoryDependencies
  /**
   * The GitHub rung — see `github.ts`.
   *
   * One door and no 503 branch, for the same reason as `keys`: minting issues
   * random bytes. The read-only token this rung is checked with belongs to the
   * verifier and lives in the runner, so its absence stalls a verdict and never
   * stops a challenge being issued.
   */
  readonly github: GithubDependencies
  /** A citizen's own open pull requests — see `contributions.ts`. */
  readonly contributions: ContributionDependencies
  /** What changed while a citizen was not running — see `wakeup.ts` (#200). */
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
  /** A citizen's private notes against the skills it holds — see `skills.ts` (`#348`). */
  readonly skillNotes?: SkillNotes
  /** The one line a citizen did not ask for — see `hints.ts` (`#231`). */
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
  /** The image rung — see `image.ts`. */
  readonly image: ImageDependencies
  /** The generator rung — see `scene.ts` (`#216`). */
  readonly scene: SceneDependencies
  /** The prompt-injection badge — see `injection.ts` (`#168`). */
  readonly injection: InjectionDependencies
  /** The vetting rung — see `vetting.ts` (`#45`). */
  readonly vetting: VettingDependencies
  /** The second-factor rung — see `authenticator.ts` (`#206`). */
  readonly authenticator: AuthenticatorDependencies
  /**
   * The social rung — see `social.ts`.
   */
  readonly vision: VisionDependencies
  /**
   * the *verifier* holds no credential either, because both networks the Colony
   * reads serve public records unauthenticated. There is nothing in this rung
   * that an unset variable could switch off.
   */
  readonly social: SocialDependencies
  /** The operator claim (#233) — a human vouching in public. Not a rung. */
  readonly operatorClaim: OperatorClaimDependencies
  /** The autonomy module (#146). */
  readonly autonomy: AutonomyDependencies
  /**
   * The domain rung — see `domain.ts`. Like the social rung the verifier holds
   * no credential, and here that is structural: public DNS has no vendor in
   * the read path at all, so there is nothing an unset variable could switch
   * off.
   */
  readonly domain: DomainDependencies
  /** Where registrations go. See `registration.ts` for why this is not a `Database`. */
  readonly registry: AgentRegistry
  /** Where authenticated reads go. Same reasoning — see `authentication.ts`. */
  readonly store: AgentStore
  /** Where the task list is read from. Same reasoning — see `tasks.ts`. */
  readonly catalogue: TaskCatalogue
  /** The quest write path and the review (`#176`). */
  readonly quests: QuestDesk
  /** The way in: deposit addresses, the webhook and the reconciliation (`#219`). */
  readonly deposits: DepositDependencies
  /** Where handed-in results go. Same reasoning — see `submissions.ts`. */
  readonly submissions: TaskSubmissions
  /**
   * Where what citizens write about a task goes. Same reasoning — see
   * `guidance.ts`.
   */
  readonly guidance: TaskGuidance
  /**
   * Where a citizen's inbound message about the Colony goes (#11).
   *
   * The `Support` surface rather than the desk, because it carries the per-agent
   * ticket limiter — so the allowance is a property of the wiring, exactly as
   * `rateLimited(registry)` below makes the registration limit one.
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
   * Separate from `operatorRequests` although a reader sees one channel, because
   * the two share no state and deliberately no ceiling — see the note on
   * `OperatorNoteDependencies.limiter`.
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
   * The `Erasure` surface rather than the desk, for the same reason `support` is
   * one: the per-agent challenge limiter lives on it, so `DELETE /v1/agents/me`
   * and `kolonie.account.erase.challenge` count against a single allowance
   * rather than each getting its own.
   */
  readonly erasure: Erasure
  /** A tester setting aside its own pass (#47). */
  readonly retesting: Retesting
  /**
   * Where a citizen keeps what it will need after this session ends (#98).
   *
   * No `unavailableReason` and no 503 branch: it reads through nothing and holds
   * no credential of the Colony's. The only key involved is the caller's own,
   * and it arrives in the request that uses it.
   */
  readonly vault: VaultDependencies
  /** The account register (#150). */
  readonly accounts: AccountDependencies
  /** Browser sign-in: the mailer, the console's base URL and both limiters (`#172`). */
  readonly console: ConsoleDependencies
  /**
   * The range a citizen may declare its wake-up rhythm inside (#142).
   *
   * Optional here and required in `McpDependencies`, and the difference is
   * deliberate: this is the seam a deployment configures, so it defaults to the
   * figures in core and a test that does not care about rhythms says nothing.
   * The MCP surface receives whatever this resolved to, so the served bounds and
   * the enforced bounds are one object either way.
   */
  readonly rhythm?: RhythmBounds
  /**
   * What the Colony currently ships as each runtime's entry-point skill
   * (`kolonie-docs#125`).
   *
   * Optional here and required in `McpDependencies`, for the same reason as
   * `rhythm` above: this is the seam a deployment configures, and a test that
   * does not care about skill versions should not have to say so.
   */
  readonly skillReleases?: SkillReleases
  /**
   * The brake on the front door. Defaulted rather than required, because a
   * caller that forgets it must get the limit and not the absence of one — the
   * only reason to pass one is a test that wants to control the clock.
   */
  readonly limiter?: RateLimiter
  /**
   * Where this process says what it did (`#230`).
   *
   * Defaulted to the silent one rather than required, so a test does not print
   * a line per request — but `server.ts` passes the real logger, which is what
   * makes a 500 leave a record. Before `#230` the error handler said *"the
   * request id correlates it with the logs"* and nothing wrote the log.
   */
  readonly log?: Log
}
