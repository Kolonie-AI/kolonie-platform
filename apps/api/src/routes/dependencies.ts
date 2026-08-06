import type { AgentId, ApiError, Log, RhythmBounds, SkillReleases } from '@kolonie-ai/core'
import type { OpenProspects } from '@kolonie-ai/db'
import type { SkillNotes } from '../skills.js'
import type { AcademyDependencies } from '../academy.js'
import type { AccountDependencies, AccountResolution } from '../accounts.js'
import type { AgentStore } from '../authentication.js'
import type { ConsoleDependencies } from '../console.js'
import type { HumanDependencies } from '../humans/humans.js'
import type { ContributionDependencies } from '../contributions.js'
import type { StandingHintSource } from '../hints.js'
import type { WakeupSource } from '../wakeup.js'
import type { ArtefactDependencies } from '../artefact.js'
import type { DomainDependencies } from '../domain.js'
import type { EmailDependencies } from '../email.js'
import type { SmsDependencies } from '../sms.js'
import type { Erasure } from '../erasure.js'
import type { GithubDependencies } from '../github.js'
import type { TaskGuidance } from '../guidance.js'
import type { ImageDependencies } from '../image.js'
import type { SceneDependencies } from '../scene.js'
import type { InjectionDependencies } from '../injection.js'
import type { VettingDependencies } from '../vetting.js'
import type { AuthenticatorDependencies } from '../authenticator.js'
import type { KeyDependencies } from '../keys.js'
import type { PowDependencies } from '../proof-of-work.js'
import type { MemoryDependencies } from '../memory.js'
import type { AgentRegistry } from '../registration.js'
import type { Retesting } from '../retest.js'
import type { AutonomyDependencies } from '../autonomy.js'
import type { OperatorClaimDependencies } from '../operator-claim.js'
import type { SocialDependencies } from '../social.js'
import type { SolanaDependencies } from '../solana.js'
import type { TaskSubmissions } from '../submissions.js'
import type { Support } from '../support.js'
import type { OperatorRequestDependencies } from '../operator-requests.js'
import type { OperatorNoteDependencies } from '../operator-notes.js'
import type { PermissionReportDependencies } from '../permission-reports.js'
import type { CredentialRotation } from '../rotation.js'
import type { DepositDependencies } from '../deposits.js'
import type { QuestDesk } from '../quests.js'
import type { TaskCatalogue } from '../tasks.js'
import type { CitizenRecords } from '../citizens.js'
import type { DropDependencies } from '../operator-drops.js'
import type { VaultDependencies } from '../vault.js'
import type { VisionDependencies } from '../vision.js'
import type { WebServerDependencies } from '../web-server.js'
import type { ReachabilityDependencies } from '../reachability.js'
import type { WebsiteDependencies } from '../website.js'

/**
 * Everything a route module needs, as one argument.
 *
 * **This is `AppDependencies` after `buildApp` has resolved it, not a copy of
 * it.** The two differ in exactly the places where resolving happened, and each
 * difference is the point of the type:
 *
 * - `registry` here is the rate-limited one. `buildApp` wraps the raw registry
 *   once and the unwrapped one is not in scope again, so no route can reach past
 *   the limit — the property holds by construction rather than by every call
 *   site remembering.
 * - `rhythm` is required here and optional there. The default is applied once, at
 *   the seam a deployment configures; a route that had to cope with `undefined`
 *   would be coping with a case that cannot reach it.
 * - `limiter` is absent. It exists to build `registry` and has no other reader.
 *
 * **The gates are fields rather than something a route recomputes.** Before this
 * they were consts in `buildApp`'s scope and every handler closed over them,
 * which is what made the handlers impossible to move. Passing them explicitly is
 * what this interface is for — see #195.
 */
export interface RouteDependencies {
  /** The rate-limited registry. See the note above: never the raw one. */
  readonly registry: AgentRegistry
  readonly store: AgentStore
  readonly catalogue: TaskCatalogue
  /** The quest write path and the review (`#176`). */
  readonly quests: QuestDesk
  /** The way in (`#219`). */
  readonly deposits: DepositDependencies
  readonly submissions: TaskSubmissions
  readonly guidance: TaskGuidance
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
  readonly erasure: Erasure
  readonly retesting: Retesting
  readonly academy: AcademyDependencies
  readonly email: EmailDependencies
  /** The two phone rungs (`#411`). Its own block for the reason `email` is: a different channel. */
  readonly sms: SmsDependencies
  readonly keys: KeyDependencies
  readonly solana: SolanaDependencies
  readonly pow: PowDependencies
  /** The memory rung (`#159`). */
  readonly memory: MemoryDependencies
  readonly github: GithubDependencies
  readonly contributions: ContributionDependencies
  /** What changed while a citizen was not running — see `wakeup.ts` (#200). */
  readonly wakeup: WakeupSource
  /** The state facts behind the wake-up's non-rung suggestions (`#347`). */
  readonly prospects?: (agentId: AgentId) => Promise<OpenProspects>
  /** A citizen's private notes against the skills it holds (`#348`). */
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
  /**
   * The reachability check (`#394`) — the limiter and, in a test, the fetch.
   *
   * Its own entry rather than a field on `webServer`, though the two are about
   * the same rung. This one grants nothing, mints nothing, reads no table and
   * touches no challenge: folding it in would put a diagnostic that writes
   * nothing behind a dependency built to write.
   */
  readonly reachability: ReachabilityDependencies
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
  /** The operator claim (#233) — a human vouching in public. Not a rung. */
  readonly operatorClaim: OperatorClaimDependencies
  /** The autonomy module (#146) — the contract, its form, and the mail that carries it. */
  readonly autonomy: AutonomyDependencies
  readonly domain: DomainDependencies
  /** The rung that publishes an artefact and addresses it (`#389`). */
  readonly artefact: ArtefactDependencies
  readonly vision: VisionDependencies
  readonly vault: VaultDependencies
  /** The operator-to-agent secret channel (`#410`). Absent when unconfigured. */
  readonly drops: DropDependencies['drops']
  readonly dropBaseUrl: string
  readonly accounts: AccountDependencies
  /** Browser sign-in and the console's own front door (`#172`). */
  readonly console: ConsoleDependencies
  /** People with accounts, and the provider they sign in through (`#425`). */
  readonly humans: HumanDependencies
  /** Resolved from `AppDependencies.rhythm`, so a route never sees `undefined`. */
  readonly rhythm: RhythmBounds
  /** Resolved from `AppDependencies.skillReleases`, so a route never sees `undefined`. */
  readonly skillReleases: SkillReleases

  /**
   * The Browser Capability Gate's answer when it is not configured.
   *
   * A 503 rather than a 404: the endpoint exists and is temporarily unable to
   * serve, which is what an agent needs in order to retry rather than conclude
   * the Colony has no such rung.
   */
  readonly unavailable: ApiError | undefined
  /**
   * The capability rung's own answer, and a separate one on purpose.
   *
   * Before the Level 1 rebuild a single `unavailable` covered every Academy
   * route, so an unset hCaptcha sitekey took the promoting rung down with the
   * badge — a third party's configuration deciding whether the Colony's ladder
   * worked.
   */
  readonly capabilityDown: ApiError | undefined
  /**
   * The four browser stages, each evaluated **per request** rather than once.
   *
   * Functions and not values, so a test may hand the routes a
   * differently-configured academy without rebuilding the app.
   */
  readonly perceptionDown: () => ApiError | undefined
  readonly interactionDown: () => ApiError | undefined
  readonly interstitialDown: () => ApiError | undefined
  readonly persistenceDown: () => ApiError | undefined
  /** The mailbox rung's own answer, separate for the same reason as the others. */
  readonly emailDown: ApiError | undefined
  /** The register read the task listing makes (#151). Never a write path. */
  readonly resolution: AccountResolution
  /**
   * Whether the inbound mail route is mounted at all.
   *
   * **Absent secret means absent route**, not an open one. Everything else here
   * degrades to a 503 when unconfigured, which is right for a rung an agent is
   * climbing and wrong for this: the endpoint turns *a mail arrived* into a fact
   * the Colony pays a reward for, and a version that answered without checking a
   * secret would let anyone on the internet pass the mailbox rung for any agent,
   * by asserting a delivery that never happened. So it fails closed — and
   * `server.ts` says so at startup rather than leaving it to be discovered.
   */
  readonly inboundSecret: string | undefined
  /**
   * Where the process says what it did (`#230`).
   *
   * Carried this far for one caller: the MCP surface reports an unanticipated
   * throw through it, and before `#230` that report was a bare `console.error`
   * whose line nothing could group or count.
   */
  readonly log: Log
  /**
   * One citizen's public record, by the name a reader already has (`#441`).
   *
   * Required here although it is optional on `AppDependencies`: `buildApp`
   * resolves the default, so a route never has to cope with an absence that
   * cannot reach it — which is the rule the note at the top of this interface
   * already states for `catalogue` and its neighbours.
   *
   * **Appended rather than placed among its neighbours**, which is the house
   * rule: an insertion mid-interface is a conflict in whichever branch is
   * rebased second, and this field has no ordering relationship to anything
   * above it.
   */
  readonly citizens: CitizenRecords
}
