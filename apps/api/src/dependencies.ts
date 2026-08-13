import type { CallRollup } from './call-rollup.js'
import type { AgentId, Log, RhythmBounds, SkillReleases } from '@kolonie-ai/core'
import type { OpenProspects } from '@kolonie-ai/db'
import type { AcademyDependencies } from './academy.js'
import type { AccountDependencies } from './accounts.js'
import type { ProviderRecipes } from './provider-recipes.js'
import type { SiteChromeSource } from './atlas/site-chrome.js'
import type { WalkStore } from './account-walks.js'
import type { AtlasRenames } from './atlas/renames.js'
import type { AtlasQuestReader } from './atlas/links.js'
import type { Attestations } from './attestations.js'
import type { AgentStore } from './authentication.js'
import type { ConsoleDependencies } from './console.js'
import type { AdoptionDesk } from './adoption.js'
import type { HumanDependencies } from './humans/humans.js'
import type { ContributionDependencies } from './contributions.js'
import type { StandingHintSource } from './hints.js'
import type { SkillNotes } from './skills.js'
import type { WakeupSource } from './wakeup.js'
import type { ArtefactDependencies } from './artefact.js'
import type { DomainDependencies } from './domain.js'
import type { EmailDependencies } from './email.js'
import type { SmsDependencies } from './sms.js'
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
import type { ReachabilityDependencies } from './reachability.js'
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
import type { PaymentDependencies } from './payments.js'
import type { EarningsDesk, PayoutDependencies } from './payouts.js'
import type { TreasurySweepDependencies } from './treasury.js'
import type { QuestDesk } from './quests.js'
import type { TaskCatalogue } from './tasks.js'
import type { HandoverStore } from './handovers.js'
import type { DropStore } from './operator-drops.js'
import type { TelegramDependencies } from './operator-telegram.js'
import type { VaultDependencies } from './vault.js'
import type { VisionDependencies } from './vision.js'
import type { WebServerDependencies } from './web-server.js'
import type { WishDependencies } from './account-wishes.js'
import type { WakeDependencies } from './wake.js'
import type { WebsiteDependencies } from './website.js'
import type { CitizenRecords } from './citizens.js'
import type { AvatarDesk } from './avatars.js'
import type { SettingsDesk } from './settings.js'
import type { ProviderEnquiryDesk } from './provider-enquiries.js'
import type { ShareDesk, ShareNotifier } from './browser-shares.js'
import type { ProfileTierDependencies } from './routes/profile-tier.js'

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
  /** The two phone rungs (`#411`). Its own block for the reason `email` is: a different channel. */
  readonly sms: SmsDependencies
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
   * The reachability check (`#394`). Optional, and defaulted where the app is
   * assembled: the only thing it strictly needs is a limiter, and a limiter with
   * no configuration is one this file can make.
   */
  readonly reachability?: ReachabilityDependencies
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
  /** The rung that publishes an artefact and addresses it (`#389`). */
  readonly artefact: ArtefactDependencies
  /** Where registrations go. See `registration.ts` for why this is not a `Database`. */
  readonly registry: AgentRegistry
  /** Where authenticated reads go. Same reasoning — see `authentication.ts`. */
  readonly store: AgentStore
  /** Where the task list is read from. Same reasoning — see `tasks.ts`. */
  readonly catalogue: TaskCatalogue
  /** The quest write path and the review (`#176`). */
  readonly quests: QuestDesk
  /**
   * The settings a maintainer may turn without a deploy (`#489`, D-104).
   *
   * Optional here and defaulted in `buildApp` to a desk with no overrides, for
   * the reason `noSettings` gives: most tests build an app and never touch a
   * setting. `server.ts` passes the real one.
   */
  readonly settings?: SettingsDesk | undefined
  /**
   * Providers writing in about the Atlas (`#544`).
   *
   * Optional for the reason `settings` is: the many tests that build an app and
   * never touch an enquiry should not each have to supply one. `server.ts`
   * passes the database-backed desk and is the only caller that matters.
   */
  readonly providerEnquiries?: ProviderEnquiryDesk | undefined
  /**
   * The way in after D-106: one Colony wallet, and a payment recognised by its
   * sender (`#503`).
   *
   * **Optional, and absent means the routes are not mounted.** A deployment
   * without a wallet cannot take money, which is a state worth having — every
   * test that builds an app, and every environment that is not production, is in
   * it. `server.ts` passes the real one, and refuses to start on a wallet whose
   * secret and address disagree.
   */
  readonly payments?: PaymentDependencies | undefined
  /**
   * Paying citizens what accepted reports owe them (`#505`).
   *
   * Optional for the reason `payments` is: a deployment with no wallet, no
   * endpoint or no ceilings cannot pay, and that is a state every test and every
   * non-production environment is in. The ceilings in particular are **required
   * where this is present** — `ceilingsRefusal` is what makes the process refuse
   * to start rather than pay without a limit.
   */
  readonly payouts?: PayoutDependencies | undefined
  /**
   * Moving the earned fee out of the hot wallet (`#507`).
   *
   * **Its own entry rather than a field on {@link payouts}**, and the reason is
   * the one-way guarantee: that one carries the wallet's secret because it pays
   * citizens, and folding the sweep into it would put the Treasury next to a
   * key in the same object. They share the wallet and nothing else, and a reader
   * checking that no Treasury key exists should have one type to read.
   */
  readonly treasury?: TreasurySweepDependencies | undefined
  /**
   * What a citizen has been paid and what it is still owed (`#535`).
   *
   * **Separate from `payouts`, and the asymmetry is the point**: whether this
   * deployment can send money decides nothing about whether a citizen may read
   * what it is owed. A report accepted on a Colony with no wallet is owed
   * exactly as much as one accepted on a Colony with one.
   *
   * Defaulted for the reason `settings` and `providerEnquiries` are: absent
   * means a Colony that has never owed anybody anything, which is true rather
   * than a stand-in.
   */
  readonly earnings?: EarningsDesk | undefined
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
  /**
   * The operator-to-agent secret channel (`#410`).
   *
   * Optional, and absent means the channel is not offered — `OPERATOR_DROP_SEALING_KEY`
   * has not been set. Every other surface here is either present or the process
   * refuses to start; this one is a convenience rather than money, so a Colony
   * that was never given the key starts and says so to the citizen that asks.
   */
  readonly drops?: DropStore | undefined
  /**
   * The agent → operator secret channel (`#592`).
   *
   * Absent on a deployment with no sealing key, following `drops` above exactly:
   * a Colony that was never given one starts normally and tells a citizen it
   * cannot carry a secret, rather than failing at the moment one is handed over.
   */
  readonly handovers?: HandoverStore | undefined
  /**
   * The operator's desk on Telegram (`#793`).
   *
   * Absent when the three `TELEGRAM_*` variables are unset, on the same trade
   * `drops` above makes — and here the fallback is not a refusal but the channel
   * that already worked: no bot means no deep link on any surface, no webhook
   * route, and an operator reached by mail exactly as before.
   */
  readonly telegram?: TelegramDependencies['telegram'] | undefined
  /** Where an operator's drop link points. Defaults to empty, as the other links do. */
  readonly dropBaseUrl?: string | undefined
  /** The account register (#150). */
  readonly accounts: AccountDependencies
  /**
   * The provider catalogue (`#521`), read-only — curation is `#549`'s.
   *
   * **Optional here and resolved in `app.ts`**, on the arrangement `citizens` and
   * `rhythm` already use: a route never sees `undefined`, and a test colony that
   * cares about something else does not have to say that its catalogue is empty. An
   * absent catalogue is an empty one, which is the true answer in a colony where
   * nobody has written an entry.
   */
  readonly recipes?: ProviderRecipes
  /**
   * Where a provider used to be, for the Atlas's redirects (`#546`).
   *
   * Optional and resolved in `app.ts` like `recipes`: a colony that has never
   * renamed anything has no redirects, which is the true answer in it.
   */
  readonly renames?: AtlasRenames
  /**
   * Who paid for an entry's figures (`#602`).
   *
   * Optional, like `renames` above it: a deployment without one renders the
   * entry page exactly as it did before quests could buy walks.
   */
  readonly atlasQuests?: AtlasQuestReader
  /**
   * The website's own base URL, which is the host the Atlas answers on (`#546`).
   *
   * **Empty means the Atlas does not serve**, and that is deliberate rather than
   * a degradation: the API answers on five hostnames, and a process that cannot
   * tell where the website lives would put a public, indexable page on all of
   * them.
   */
  readonly websiteUrl?: string | undefined
  /**
   * The site's own header and footer, for the Atlas pages to wear
   * (`kolonie-website#99`).
   *
   * **Absent means *fetch them from `websiteUrl`*, not *do without***. It is
   * here so a test can supply a fragment without standing up a website;
   * production builds one from `websiteUrl`, which is the same value every
   * Atlas page already writes into its canonical link, so this introduces no
   * new configuration.
   */
  readonly siteChrome?: SiteChromeSource | undefined
  /**
   * Walks, recorded as they happen (`#601`).
   *
   * Optional at every layer for the reason `account-walks.ts` gives: a
   * deployment with no walk recording behaves exactly as it did before the
   * record existed.
   */
  readonly walks?: WalkStore | undefined
  /**
   * What the Colony will confirm about one agent, to anybody (`#519`).
   *
   * Optional and resolved in `app.ts`, like `recipes`: a colony with no citizens
   * confirms nothing, which is the true answer in it.
   */
  readonly attestations?: Attestations
  /**
   * Where a finished call is counted, per route and per hour (`#835`).
   *
   * **Optional, and an absent one means the Colony records nothing** — which is
   * what every test that does not care about the rollup gets, and what a
   * deployment that switches it off gets, on D-013's terms. The consequence of
   * absence is a thinner diagnosis and never a changed answer to any caller: no
   * route reads these rows, and the surface that will (`#837`) treats an empty
   * window as a complete answer rather than an error.
   *
   * Handed to the MCP surface as well as to the response hook, because that door
   * hijacks its socket and has to count its own calls — see `mcp/guard.ts`.
   */
  readonly rollup?: CallRollup
  /** Browser sign-in: the mailer, the console's base URL and both limiters (`#172`). */
  readonly console: ConsoleDependencies
  /**
   * People with accounts (`#425`).
   *
   * The store is always there — a person's account is a table, not a
   * configuration — and the tenant is not: absent, the console offers the mail
   * link alone, which is what it offered before this existed.
   */
  readonly humans: HumanDependencies
  /**
   * Redeeming a hand-over code, for an agent that has no session and no key
   * (`#459`).
   *
   * Beside `humans` rather than inside it, because every other method there is
   * reached by a signed-in person and this one by an agent that is not one yet.
   * Optional: a deployment that wires no console has nobody to hand an identity
   * over, and the tool is then not registered at all.
   */
  readonly adoption?: AdoptionDesk
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
  /**
   * One citizen's public record, by the name a reader already has (`#441`).
   *
   * **Optional, and the default answers *no such citizen* rather than throwing.**
   * The same trade `limiter` and `log` above make, and here the default is the
   * safe direction twice over: a colony with nobody in it is exactly what a test
   * that is not about this route has, and *nobody holds that name* is the true
   * answer in it. `server.ts` passes the database read, which is the only
   * deployment path there is.
   *
   * **Appended rather than placed among its neighbours**, which is the house
   * rule: an insertion mid-interface is a conflict in whichever branch is
   * rebased second.
   */
  readonly citizens?: CitizenRecords
  /**
   * The Colony's own copy of a citizen's avatar (`#823`).
   *
   * Optional for the reason `citizens` above is: a colony with no citizens
   * answers *nobody holds that name*, which is true in it. `server.ts` passes
   * the database read, which is the only deployment path there is. Appended,
   * per the house rule on `citizens`.
   */
  readonly avatars?: AvatarDesk
  /**
   * The third operator channel (`#736`): a live browser tab, relayed.
   *
   * **Optional, and absent means the two sockets are never registered.** The
   * same trade `drops` makes above: a deployment that has not got this is a
   * deployment where the channel is not there, and it should still boot. A test
   * that is not about browser sharing passes nothing and gets an app with no
   * upgradeable path on it at all.
   */
  readonly shares?: ShareDesk
  /**
   * And how the person is told their agent is waiting (`#774`).
   *
   * Optional beside the desk, and the two absences mean different things —
   * `McpDependencies.shareNotifier` states both. Here, absent is the ordinary
   * shape of a test: nothing about browser sharing is broken by there being no
   * mail, and an offer made without one comes back saying `undeliverable`.
   */
  readonly shareNotifier?: ShareNotifier
  /**
   * The brake in front of the public profile tier (`#828`).
   *
   * Optional and defaulted in `app.ts`, on exactly the arrangement
   * `reachability` above uses: the only thing it needs is a limiter, and a
   * limiter with no configuration is one the assembly can make. A test that
   * wants to reach the ceiling in three requests, or move time instead of
   * waiting for it, passes its own. Appended, per the house rule on `citizens`.
   */
  readonly profileTier?: ProfileTierDependencies
}
