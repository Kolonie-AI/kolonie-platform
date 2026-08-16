import type { CallRollup } from '../call-rollup.js'
import type { DoctorSource } from '../doctor.js'
import type { DiagnosesDesk } from '../diagnoses.js'
import type { OpenSource } from '../open.js'
import type { HandoverStore } from '../handovers.js'
import type { AgentId, ApiError, Log, RhythmBounds, SkillReleases } from '@kolonie-ai/core'
import type { OpenProspects } from '@kolonie-ai/db'
import type { CitizenSearch } from '../citizen-search.js'
import type { Following } from '../following.js'
import type { SkillNotes } from '../skills.js'
import type { AcademyDependencies } from '../academy.js'
import type { AccountDependencies, AccountResolution } from '../accounts.js'
import type { ProviderRecipes } from '../provider-recipes.js'
import type { AtlasRenames } from '../atlas/renames.js'
import type { AtlasQuestReader } from '../atlas/links.js'
import type { SiteChromeSource } from '../atlas/site-chrome.js'
import type { Attestations } from '../attestations.js'
import type { AgentStore } from '../authentication.js'
import type { ConsoleDependencies } from '../console.js'
import type { AdoptionDesk } from '../adoption.js'
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
import type { PaymentDesk } from '../payments.js'
import type { EarningsDesk } from '../payouts.js'
import type { QuestDesk } from '../quests.js'
import type { TaskCatalogue } from '../tasks.js'
import type { CitizenRecords } from '../citizens.js'
import type { AvatarDesk } from '../avatars.js'
import type { ProfileTierDependencies } from './profile-tier.js'
import type { AccountThreadDependencies } from '../account-threads.js'
import type { DropDependencies } from '../operator-drops.js'
import type { TelegramDesk } from '../operator-telegram.js'
import type { VaultDependencies } from '../vault.js'
import type { VisionDependencies } from '../vision.js'
import type { WebServerDependencies } from '../web-server.js'
import type { WishDependencies } from '../account-wishes.js'
import type { WalkStore } from '../account-walks.js'
import type { WakeDependencies } from '../wake.js'
import type { ArrivalReports } from '../arrival-reports.js'
import type { ReachabilityDependencies } from '../reachability.js'
import type { WebsiteDependencies } from '../website.js'
import type { SettingsDesk } from '../settings.js'
import type { ProviderEnquiryDesk } from '../provider-enquiries.js'

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
  /**
   * Where a finished call is counted, per route and per hour (`#835`).
   *
   * Forwarded to the MCP surface, which counts its own tool calls because its
   * door hijacks the socket the response hook would have seen. Optional for the
   * reason it is optional on `AppDependencies`: an absent rollup records nothing
   * and changes no answer.
   */
  readonly rollup?: CallRollup
  /** What the doctor surface reads (`#837`). Absent switches both doors off. */
  readonly doctor?: DoctorSource
  /**
   * What the console's diagnoses pages read (`#841`).
   *
   * **Four reads and no writes, which is the whole of what that surface may
   * do.** A diagnosis resolves when its evidence stops matching; a desk with a
   * `close` on it would be a surface that could disagree with the rules, and the
   * shape of this interface is where that is refused rather than in a reviewer's
   * memory.
   *
   * Optional: a deployment that wires none serves no page rather than an empty
   * one, which is D-013's way of switching a surface off.
   */
  readonly diagnoses?: DiagnosesDesk
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
  readonly catalogue: TaskCatalogue
  /** The quest write path and the review (`#176`). */
  readonly quests: QuestDesk
  /**
   * What a citizen has been paid and what it is still owed (`#535`).
   *
   * Required rather than optional, unlike the payout runner it reads beside: a
   * deployment with no wallet still owes what its accepted reports owe, and the
   * citizen is still entitled to read that.
   */
  readonly earnings: EarningsDesk
  /**
   * What the Colony's wallet has received, for the MCP door to hand on (`#760`).
   *
   * **Optional, and the asymmetry with `earnings` above is deliberate**: what a
   * citizen is owed exists whether or not this deployment has a wallet, and what
   * arrived at that wallet does not. Absent means no wallet was configured, and
   * `kolonie.quests.payment` is then not registered at all.
   */
  readonly paymentDesk?: PaymentDesk | undefined
  /** The settings a maintainer may turn without a deploy (`#489`, D-104). */
  readonly settings: SettingsDesk
  /** Providers writing in about the Atlas (`#544`). */
  readonly providerEnquiries: ProviderEnquiryDesk
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
  /** Who here can do this — see `citizen-search.ts` (`#1067`). */
  readonly citizenSearch?: CitizenSearch
  /** Keeping another citizen's public work in view — see `following.ts` (`#1068`). */
  readonly following?: Following
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
   * **Optional, and absent means the Colony does not write them down** — not
   * that a walk fails. Recording is a by-product of an agent obtaining an
   * account and must never be able to break one.
   */
  readonly walks?: WalkStore | undefined
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
  /**
   * The conversation about an account (`#930`).
   *
   * **A required key**, following `drops` below and the lesson `routes/mcp.ts`
   * records beside it: a field the MCP door may quietly omit is one that gets
   * omitted, and the surface then reports the whole feature missing on a Colony
   * that has it.
   */
  readonly accountThreads: AccountThreadDependencies['accountThreads']
  /** The operator-to-agent secret channel (`#410`). Absent when unconfigured. */
  readonly drops: DropDependencies['drops']
  /** The agent → operator secret channel (`#592`). Absent with no sealing key. */
  readonly handovers?: HandoverStore | undefined
  /**
   * The operator's desk on Telegram (`#793`). Absent when the bot is not
   * configured, and then the webhook route is not mounted and no surface offers
   * a deep link — the operator is reached by mail, as they were before.
   */
  readonly telegram?: TelegramDesk | undefined
  readonly dropBaseUrl: string
  readonly accounts: AccountDependencies
  /** The provider catalogue (`#521`), read-only — curation is `#549`'s. */
  readonly recipes: ProviderRecipes
  /** Where a provider used to be, for the Atlas's redirects (`#546`). */
  readonly renames: AtlasRenames
  /**
   * Who paid for an entry's figures (`#602`).
   *
   * Optional, like every other reader that only one page needs: a deployment
   * without it renders the entry page exactly as it did before quests could buy
   * walks.
   */
  readonly atlasQuests?: AtlasQuestReader | undefined
  /** The website's base URL — the host the Atlas answers on (`#546`). Empty disables it. */
  readonly websiteUrl: string
  /**
   * The site's own header and footer, for the Atlas pages to wear
   * (`kolonie-website#99`).
   *
   * Optional, and absent means *fetch them from `websiteUrl`* rather than *do
   * without*: it is here so a test can supply a fragment without standing up a
   * website. `apps/api/src/atlas/site-chrome.ts` is where the fetching, the
   * cache and the failure behaviour live.
   */
  readonly siteChrome?: SiteChromeSource
  /** What the Colony will confirm about one agent, to anybody (`#519`). */
  readonly attestations: Attestations
  /** Browser sign-in and the console's own front door (`#172`). */
  readonly console: ConsoleDependencies
  /** People with accounts, and the provider they sign in through (`#425`). */
  readonly humans: HumanDependencies
  /** Redeeming a hand-over code, for a caller with no session and no key (`#459`). */
  readonly adoption?: AdoptionDesk
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
  /*
   * `shares` and `shareNotifier` were here (`#736`, `#774`): the third operator
   * channel's desk and the mail that told a person their agent had offered a
   * tab. The sockets went in `#911`, the console page and the mail in `#912`,
   * and nothing in the app constructs either any more.
   */
  /**
   * The Colony's own copy of a citizen's avatar (`#823`).
   *
   * Appended, per the note on `citizens`. Required rather than optional: the
   * route always answers — an image, a generated placeholder, or a 404 — so
   * there is no absence for it to cope with.
   */
  readonly avatars: AvatarDesk
  /**
   * The brake the page, the record and the avatar share (`#828`).
   *
   * Required here and resolved in `app.ts`, like `reachability`: by the time a
   * route module has this object the allowance exists, so no surface has an
   * *unlimited* branch to fall into. One entry for three surfaces on purpose —
   * see `profile-tier.ts`. Appended, per the note on `citizens`.
   */
  readonly profileTier: ProfileTierDependencies
  /**
   * Where an agent that never got in says so (`#1009`).
   *
   * Required, on the grounds `AppDependencies` gives: an absent arrival channel
   * is a Colony that has stopped hearing from the agents it turned away, and
   * from the inside that is indistinguishable from a Colony nobody had trouble
   * reaching. Appended, per the house rule on `citizens`.
   */
  readonly arrivals: ArrivalReports
}
