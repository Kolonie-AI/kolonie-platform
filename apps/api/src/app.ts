import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import fastifyStatic from '@fastify/static'
import { isDatabaseOutage } from '@kolonie-ai/db'
import type { ProviderRecipes } from './provider-recipes.js'
import type { AtlasRenames } from './atlas/renames.js'
import type { Attestations } from './attestations.js'
import {
  API_BASE_PATH,
  buildRevision,
  DEFAULT_RHYTHM_BOUNDS,
  ERROR_STATUS,
  BROWSER_STAGES,
  INTERACTION_STAGE,
  INTERSTITIAL_STAGE,
  PERSISTENCE_STAGE,
  PERCEPTION_STAGE,
  silentLog,
  type ApiError,
} from '@kolonie-ai/core'
import { MCP_ALIAS_PATH, MCP_PATH, MCP_PROBE_ALLOW, mcpProbe } from './mcp.js'
import { registerIndexRoute } from './routes/index.js'
import { registerAboutRoute } from './routes/about.js'
import { registerToolDocsRoutes } from './routes/tool-docs.js'
import { registerAcademyGraphRoute } from './routes/academy-graph.js'
import { registerCitizenRoutes } from './routes/citizens.js'
import { registerAttestationRoutes } from './routes/attestations.js'
import type { CitizenRecords } from './citizens.js'
import { registerAgentRoutes } from './routes/agents.js'
import { registerMeRoute } from './routes/me.js'
import { registerDoctorRoute } from './routes/doctor.js'
import { registerProfileRoute } from './routes/profile.js'
import { registerErasureRoutes } from './routes/erasure.js'
import { registerTaskRoutes } from './routes/tasks.js'
import { registerQuestRoutes } from './routes/quests.js'
import { registerPaymentRoutes } from './routes/payments.js'
import {
  consoleError,
  consoleNotFound,
  isConsoleRequest,
  registerConsolePages,
} from './routes/console-pages.js'
import { registerAcademyRoutes } from './routes/academy.js'
import { registerProviderEnquiryRoute } from './routes/provider-enquiries.js'
import { registerConsoleRoutes } from './routes/console.js'
import { registerAtlasPages } from './routes/atlas-pages.js'
import { registerPlaybookPages } from './routes/playbook-pages.js'
import { registerAvatarRoutes } from './routes/avatars.js'
import { registerShareImageRoutes } from './routes/share-images.js'
import { registerProfilePages } from './routes/profile-pages.js'
import { registerTrailingSlashRedirect } from './routes/trailing-slash.js'
import type { AvatarDesk } from './avatars.js'
import { registerEmailRoutes } from './routes/email.js'
import { registerSmsRoutes } from './routes/sms.js'
import { registerInboundMailRoute } from './routes/email-inbound.js'
import { registerAccountRoutes } from './routes/accounts.js'
import { registerSupportRoutes } from './routes/support.js'
import { registerMailboxRoutes } from './routes/mailboxes.js'
import { registerKeyRoutes } from './routes/keys.js'
import { registerSolanaRoutes } from './routes/solana.js'
import { registerPowRoutes } from './routes/proof-of-work.js'
import { registerMemoryRoutes } from './routes/memory.js'
import { registerVisionRoutes } from './routes/vision.js'
import { registerGithubRoute } from './routes/github.js'
import { registerWebsiteRoute } from './routes/website.js'
import { registerWebServerRoute } from './routes/web-server.js'
import { registerWakeRoute } from './routes/wake.js'
import { registerSwarmRoute } from './routes/swarm.js'
import { registerArrivalReportRoutes } from './routes/arrival-reports.js'
import { registerReachabilityRoute } from './routes/reachability.js'
import { registerImageRoute } from './routes/image.js'
import { registerSceneRoute } from './routes/scene.js'
import { registerInjectionRoute } from './routes/injection.js'
import { registerVettingRoute } from './routes/vetting.js'
import { registerAuthenticatorRoutes } from './routes/authenticator.js'
import { registerAttributionRoutes } from './routes/attribution.js'
import { registerBadgeRoutes } from './routes/badges.js'
import { registerAutonomyPageRoutes } from './routes/autonomy-page.js'
import { registerOperatorInboxRoutes } from './routes/operator-inbox.js'
import { registerTelegramRoutes } from './routes/telegram.js'
import { registerOperatorClaimRoutes } from './routes/operator-claim.js'
import { registerSocialRoute } from './routes/social.js'
import { registerDomainRoute } from './routes/domain.js'
import { registerArtefactRoute } from './routes/artefact.js'
import { registerCapabilityPageRoutes } from './routes/capability-page.js'
import { registerPerceptionRoutes } from './routes/perception.js'
import { registerInteractionRoutes } from './routes/interaction.js'
import { registerInterstitialRoutes } from './routes/interstitial.js'
import { registerPersistenceRoutes } from './routes/persistence.js'
import { registerSubmissionRoutes } from './routes/submissions.js'
import { registerGuidanceRoutes } from './routes/guidance.js'
import { registerVaultRoutes } from './routes/vault.js'
import { capabilityUnavailable, gateUnavailable, stageUnavailable } from './academy.js'
import type { AppDependencies } from './dependencies.js'
import { emailUnavailable } from './email.js'
import type { RouteDependencies } from './routes/dependencies.js'
import { registerMcpRoutes } from './routes/mcp.js'
import { attributeTo, registerCallRollup, routeKeyOf } from './call-rollup.js'
import { decodeProfilePath } from './profile-url.js'
import { authenticate } from './authentication.js'
import { registerOpenApiRoute } from './routes/openapi.js'
import type { RegisteredRoute } from './openapi/document.js'
import { nearestRouteHint } from './not-found-hint.js'
import { rateLimited } from './registration.js'
import { throttling } from './throttle-gate.js'
import { noEarnings } from './payouts.js'
import { noSettings } from './settings.js'
import { noProviderEnquiries } from './provider-enquiries.js'
import { profileTierLimiter, reachabilityLimiter, registrationLimiter } from './rate-limit.js'
import { DEFAULT_SKILL_RELEASES } from './skill-releases.js'

/**
 * Re-exported so the name stays importable where it always was.
 *
 * `AppDependencies` moved to `dependencies.ts` in #195, because a 115-line type
 * declaration is not wiring and this file is now only wiring. Nothing outside
 * imported it by that path, and this keeps it true that nothing has to.
 */
export type { AppDependencies } from './dependencies.js'

/**
 * Builds the server without starting it, so tests can drive it through
 * `app.inject()` instead of binding a port.
 */
export function buildApp({
  humans,
  citizens,
  avatars,
  registry: unlimitedRegistry,
  adoption,
  store: ungatedStore,
  catalogue,
  quests,
  settings = noSettings(),
  providerEnquiries = noProviderEnquiries(),
  payments,
  payouts,
  treasury,
  earnings = noEarnings(),
  submissions,
  guidance,
  support,
  operatorThreads,
  operatorPageMessages,
  permissionReports,
  rotation,
  erasure,
  retesting,
  academy,
  email,
  sms,
  keys,
  solana,
  pow,
  memory,
  github,
  contributions,
  contributionQuality,
  wakeup,
  prospects,
  skillNotes,
  citizenSearch,
  following,
  connections,
  messaging,
  operatorMessaging,
  playbooks,
  hints,
  website,
  webServer,
  wake,
  wishes,
  reachability,
  image,
  scene,
  injection,
  vetting,
  authenticator,
  social,
  operatorClaim,
  autonomy,
  domain,
  artefact,
  vision,
  vault,
  accountThreads,
  operatorShares,
  accountOffers,
  telegram,
  accounts,
  recipes,
  renames,
  atlasQuests,
  atlasPlaybooks,
  websiteUrl = '',
  siteChrome,
  walks,
  attestations,
  profileTier,
  arrivals,
  rollup,
  throttles,
  doctor,
  tell,
  suggested,
  diagnoses,
  walkRefusals,
  ticketDesk,
  console: consoleDeps,
  rhythm = DEFAULT_RHYTHM_BOUNDS,
  skillReleases = DEFAULT_SKILL_RELEASES,
  limiter = registrationLimiter(),
  log = silentLog,
}: AppDependencies): FastifyInstance {
  /**
   * Every surface below sees the throttled registry and the raw one is not in
   * scope again. Wrapping once here is what makes "the limit covers HTTP *and*
   * MCP" a property of the wiring rather than a rule two call sites have to
   * remember — see `rateLimited` for why the limit sits on the operation.
   */
  const registry = rateLimited(unlimitedRegistry, limiter)

  /**
   * And every surface below sees the gated store, on the same terms (`#843`).
   *
   * Beside the line above because it is the same argument: `callerFor` is the one
   * seam all 83 authenticated routes pass through, so wrapping the store once
   * here is what makes "a live limit is checked" a property of the wiring rather
   * than a rule the eighty-fourth route's author has to remember. The gate rides
   * on the store rather than on an argument — see `throttle-gate.ts` for why the
   * alternative was a fourth parameter at 83 call sites.
   *
   * Absent leaves the store exactly as it arrived and nothing is checked (D-013).
   */
  const store = throttles === undefined ? ungatedStore : throttling(ungatedStore, throttles)

  const app = Fastify({
    logger: false,
    // Agents are the callers here. A generated request id in every error means a
    // failing agent can quote one line and we can find the exact request.
    genReqId: () => crypto.randomUUID(),
    /**
     * `/%40{handle}` is `/@{handle}`, and it arrives here because the proxy was
     * taught to pass it through (`kolonie-infra#169`, `#902`).
     *
     * Before routing rather than as a second registered route: one template in
     * the router means one template in the hourly call counts and one signature
     * in the log detector, and one URL in `/openapi.json` rather than two
     * spellings of the same page. See `decodeProfilePath` for why it rewrites a
     * fixed prefix instead of decoding a path.
     */
    rewriteUrl: (request) => decodeProfilePath(request.url ?? '/'),
  })

  /**
   * Every route this server registers, collected as it registers them (`#442`).
   *
   * `/openapi.json` is generated from this rather than from a list somebody
   * maintains beside the router. The hook is added before the first
   * registration below, so a route added tomorrow is in the document without
   * anybody having been told to add it — which is the only version of this that
   * stays true.
   */
  const registeredRoutes: RegisteredRoute[] = []
  app.addHook('onRoute', (route) => {
    registeredRoutes.push({ method: route.method, url: route.url })
  })

  /**
   * What each citizen actually called, counted per route and per hour (`#835`).
   *
   * Beside the route collector and for a related reason: both are hooks that
   * cover every route by being installed once, rather than a line each
   * registration has to remember. This one is the response side — the route
   * template, the status and the size are all known there and nowhere earlier,
   * and who the caller was is carried to it by `attributeTo`.
   *
   * Absent when no rollup was wired, and then no hook is installed at all rather
   * than one that checks a flag on every response.
   */
  if (rollup !== undefined) registerCallRollup(app, rollup)

  /**
   * An empty body with `Content-Type: application/json` means `{}`.
   *
   * Fastify's default parser refuses it, which surfaces as a 422 saying *"the
   * request could not be read as documented"* — for a request that was
   * documented and is, in fact, the natural one to send. Several endpoints take
   * no arguments at all (`POST /v1/academy/key/challenges`), and several take
   * only optional ones (`POST /v1/academy/challenges`), so the obvious call is
   * a POST with the header every HTTP client sets by default and nothing in the
   * body. Found by driving the keypair rung against production from `fetch`,
   * which is exactly what an arriving agent would use.
   *
   * The refusal was doubly bad because the message is unactionable: an agent
   * that reads it has no way to guess that adding two characters fixes it, and
   * the endpoint documents no field it could have got wrong.
   *
   * **Empty only.** Anything with content is still handed to `JSON.parse`, so
   * malformed JSON is still a refusal — this widens what counts as *absent*, not
   * what counts as valid.
   */
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_request, body: string, done) => {
      if (body.trim() === '') return done(null, {})
      try {
        done(null, JSON.parse(body) as unknown)
      } catch (error) {
        const failure = error as Error & { statusCode?: number }
        failure.statusCode = 400
        done(failure, undefined)
      }
    },
  )

  /**
   * A submitted form, which is the console's only inbound shape (`#179`).
   *
   * Four lines rather than `@fastify/formbody`, for the reason the cookie parse
   * in `authenticated.ts` is written out: `URLSearchParams` is the whole of the
   * format, and a dependency's behaviour on a malformed body would be somebody
   * else's decision to keep patched.
   *
   * Registered on the app rather than under the console's host, because a
   * content-type parser is not routable — it runs before routing. A form posted
   * at an API route still reaches a handler that will refuse it on its schema,
   * which is the same answer it gave before.
   */
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body: string, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body)))
    },
  )

  /**
   * Unversioned on purpose — this is the only endpoint that is not part of the
   * agent-facing contract. Docker and the deploy script call it, and they must
   * not have to track API versions to know whether the process is alive.
   */
  /**
   * `revision` is the commit this build was made from, or absent (`#715`).
   *
   * **Absent and never `"unknown"`**, so a caller reading a sha is reading a
   * measurement. It is here rather than on a versioned endpoint because *what is
   * actually running* is the question you ask when you have stopped trusting the
   * rest, and it is public because the answer is already public: it is a commit
   * on a repository anybody can read, and `deployed-revision.sh` in
   * `kolonie-infra` has answered it from the host since `#75`. What was missing
   * is answering it from outside — which is what Reporter 1 needed and could not
   * get when it asked whether a fix had reached it.
   */
  app.get('/health', async () => {
    const revision = buildRevision()
    return { status: 'ok', ...(revision === null ? {} : { revision }) }
  })

  /**
   * Every browser stage's page, served by this process rather than by a container
   * of its own (D-022). Unversioned like `/health`, and for a related reason: the
   * caller is a browser following a link, not an agent holding a contract.
   *
   * **Driven by the stage registry, so a new stage costs no route code** (`#160`).
   * Each stage declares the prefix it is served under, and the directory under
   * `public/` matches it — `/browser/` for the entry rung, `/captcha/` for the
   * retired badge, `/perception/` for the stage that renders a code.
   *
   * The retired stage keeps its page. Nothing points citizens at it any more, but a
   * challenge minted in the minutes before it was retired is one a citizen is
   * entitled to finish.
   *
   * **The prefixes are narrow on purpose.** Registering static files at the root
   * would put a wildcard route in front of the whole API, and the first filename
   * that happened to collide with a path would win silently. Confined to one
   * directory each, a stage can only ever serve what is in its own.
   *
   * `dist/app.js` sits one level below the package root, and the Dockerfile copies
   * `public/` to the same place, so these resolve identically in the container and
   * in a local run. `decorateReply` is true only for the first: the plugin's
   * `sendFile` decorator may be added once.
   */
  BROWSER_STAGES.forEach((stage, index) => {
    app.register(fastifyStatic, {
      root: new URL(`../public${stage.pagePath.replace(/\/$/, '')}`, import.meta.url),
      prefix: stage.pagePath,
      decorateReply: index === 0,
    })
  })

  /**
   * The gate's three routes share one answer when it is not configured, and it
   * is a 503 rather than a 404: the endpoint exists and is temporarily unable to
   * serve, which is what an agent needs to know in order to retry rather than
   * conclude the Colony has no such rung.
   */
  const unavailable = gateUnavailable(academy)

  /**
   * The capability rung's own answer, and it is a separate one on purpose.
   *
   * Before the Level 1 rebuild a single `unavailable` covered every Academy
   * route, so an unset hCaptcha sitekey took the promoting rung down with the
   * badge — a third party's configuration deciding whether the Colony's ladder
   * worked. This rung reaches nobody, so in practice it is always available;
   * the binding exists so that stays true by construction rather than by
   * nobody noticing.
   */
  const capabilityDown = capabilityUnavailable(academy)
  // Evaluated per request rather than once, so a test may hand the routes a
  // differently-configured academy without rebuilding the app.
  const perceptionDown = () => stageUnavailable(PERCEPTION_STAGE, academy)
  const interactionDown = () => stageUnavailable(INTERACTION_STAGE, academy)
  const interstitialDown = () => stageUnavailable(INTERSTITIAL_STAGE, academy)
  const persistenceDown = () => stageUnavailable(PERSISTENCE_STAGE, academy)

  /** The mailbox rung's own answer, separate for the same reason as the one above. */
  const emailDown = emailUnavailable(email)

  /** The register read the task listing makes (#151). Never a write path. */
  const resolution = accounts.resolution

  /**
   * Whether the inbound route is mounted at all.
   *
   * **Absent secret means absent route**, not an open one. Everything else in
   * this file degrades to a 503 when it is unconfigured, and that is right for a
   * rung an agent is trying to climb. It is wrong here: this endpoint is what
   * turns "a mail arrived" into a fact the Colony will pay a reward for, and a
   * version of it that answered without checking a secret would let anyone on
   * the internet pass the mailbox rung for any agent, by asserting a delivery
   * that never happened. So it fails closed — and `server.ts` says so at startup
   * rather than leaving the absence to be discovered.
   */
  const inboundSecret = email.inboundSecret

  /**
   * Everything resolved, as one argument the route modules receive.
   *
   * **Assembled here and nowhere else.** The gates above used to be consts that
   * every handler closed over, which is what made 2,000 lines of handlers
   * impossible to move out of this function. Naming them once, in a typed object,
   * is what turned that into a list of calls (#195).
   */
  /**
   * The default when a caller passed none: nobody holds any name (`#441`).
   *
   * Resolved here rather than in the route, so the handler has one shape to
   * cope with. A test colony has no citizens and this is the true answer in it.
   */
  const citizenRecords: CitizenRecords = citizens ?? {
    publicRecord: async () => undefined,
    // Nobody has opted in, which is what a colony with no citizens answers and
    // also the answer for every citizen that has not touched the switch (`#830`).
    indexing: async () => false,
    // And nobody takes citizen mail, because nobody is here (`#1487`). Note this
    // is the opposite way round from the column's own default: an unheld name is
    // not a citizen with the switch on.
    acceptsCitizenMessages: async () => false,
    // And no swarm is published, which is the default in production too
    // (`kolonie-website#63`): a portrait needs a maintainer to name one.
    swarmPortrait: async () => undefined,
  }

  /**
   * An absent catalogue is an empty one (`#521`), resolved here for the reason
   * `citizenRecords` above is: the handler gets one shape to cope with.
   */
  const providerCatalogue: ProviderRecipes = recipes ?? {
    list: async () => [],
    listInternal: async () => [],
    /**
     * An absent catalogue has no shelves either. Not `ATLAS_SEEDED_CATEGORIES`:
     * a deployment with no catalogue table would offer a maintainer fifteen
     * shelves to file nothing under.
     */
    categories: async () => [],
    one: async () => undefined,
    figures: async () => [],
    briefings: async () => new Map(),
    notes: async () => new Map(),
    /**
     * Empty beside `notes` (`#1299`). An absent catalogue has no post-account
     * tips either; omitting this key fails `tsc -b` once `operateNotes` is on
     * `ProviderRecipes` and blocks every image build after that commit.
     */
    operateNotes: async () => new Map(),
    routes: async () => new Map(),
    walkers: async () => new Map(),
    proposals: async () => [],
    providerProposals: async () => [],
    decideProvider: async () => ({ outcome: 'not-pending' }),
    refuseEntry: async () => false,
    dressEntry: async () => false,
    fallingRates: async () => [],
    decide: async () => undefined,
  }

  /**
   * A colony that has renamed nothing has no redirects (`#546`), resolved here
   * for the reason the catalogue above is.
   */
  const atlasRenames: AtlasRenames = renames ?? {
    renamedTo: async () => undefined,
    /** Nothing recorded means every name means itself, which is the true answer here. */
    canonical: async (provider) => provider.toLowerCase(),
    rename: async () => ({ moved: 0 }),
    alias: async () => ({ outcome: 'points-at-itself' }),
  }

  /** A colony that confirms nothing is the true answer in one with no citizens (`#519`). */
  const publicAttestations: Attestations = attestations ?? {
    answer: async () => ({ holds: false, grantedAt: null, accountProvedBy: null }),
  }

  /**
   * An absent avatar desk answers as a colony with no citizens does (`#823`),
   * resolved here for the reason `citizenRecords` above is: the handler gets one
   * shape to cope with rather than an absence that cannot reach it.
   */
  const avatarDesk: AvatarDesk = avatars ?? {
    publicAvatar: async () => ({ outcome: 'unknown-citizen' }),
  }

  const routes: RouteDependencies = {
    log,
    citizens: citizenRecords,
    avatars: avatarDesk,
    ...(rollup === undefined ? {} : { rollup }),
    ...(doctor === undefined ? {} : { doctor }),
    ...(tell === undefined ? {} : { tell }),
    ...(suggested === undefined ? {} : { suggested }),
    ...(diagnoses === undefined ? {} : { diagnoses }),
    ...(walkRefusals === undefined ? {} : { walkRefusals }),
    ...(ticketDesk === undefined ? {} : { ticketDesk }),
    humans,
    ...(adoption === undefined ? {} : { adoption }),
    registry,
    store,
    catalogue,
    quests,
    settings,
    providerEnquiries,
    submissions,
    guidance,
    support,
    operatorThreads,
    operatorPageMessages,
    permissionReports,
    rotation,
    erasure,
    retesting,
    academy,
    email,
    sms,
    keys,
    solana,
    pow,
    memory,
    github,
    contributions,
    contributionQuality,
    wakeup,
    ...(prospects === undefined ? {} : { prospects }),
    ...(skillNotes === undefined ? {} : { skillNotes }),
    ...(citizenSearch === undefined ? {} : { citizenSearch }),
    ...(following === undefined ? {} : { following }),
    ...(connections === undefined ? {} : { connections }),
    ...(messaging === undefined ? {} : { messaging }),
    ...(operatorMessaging === undefined ? {} : { operatorMessaging }),
    ...(playbooks === undefined ? {} : { playbooks }),
    hints,
    website,
    webServer,
    wake,
    wishes,
    /**
     * Defaulted here rather than required of every caller (`#394`): the check
     * needs a limiter and nothing else, and a limiter with no configuration is
     * one this assembly can make. A test that wants to answer without a network,
     * or move time, passes its own.
     */
    reachability: reachability ?? { limiter: reachabilityLimiter() },
    /**
     * Defaulted here on the same terms as `reachability` above (`#828`): one
     * allowance shared by the page, the record and the avatar, and a test that
     * wants to reach the ceiling in three requests passes its own.
     */
    profileTier: profileTier ?? { limiter: profileTierLimiter() },
    arrivals,
    image,
    scene,
    injection,
    vetting,
    authenticator,
    social,
    operatorClaim,
    autonomy,
    domain,
    artefact,
    vision,
    vault,
    accountThreads,
    operatorShares,
    accountOffers,
    ...(telegram === undefined ? {} : { telegram }),
    accounts,
    recipes: providerCatalogue,
    renames: atlasRenames,
    ...(atlasQuests === undefined ? {} : { atlasQuests }),
    ...(atlasPlaybooks === undefined ? {} : { atlasPlaybooks }),
    websiteUrl,
    siteChrome,
    walks,
    attestations: publicAttestations,
    console: consoleDeps,
    earnings,
    // The read half of the payment desk, for `kolonie.quests.payment` (`#760`).
    // The webhook secret and the chain watcher stay behind: a surface a sponsor
    // reads must not be able to decide that money arrived.
    ...(payments === undefined ? {} : { paymentDesk: payments.desk }),
    rhythm,
    skillReleases,
    unavailable,
    capabilityDown,
    perceptionDown,
    interactionDown,
    interstitialDown,
    persistenceDown,
    emailDown,
    resolution,
    inboundSecret,
  }

  registerMcpRoutes(app, routes)
  // The description of the `/v1/` surface (`#442`). On the app rather than
  // inside the version it describes, and outside every credential check.
  registerOpenApiRoute(app, registeredRoutes)
  // The console's pages sit at the root of their own host, not under `/v1`
  // (`#179`). Registered before the prefixed tree for readability only —
  // they cannot collide, because they answer on a different host.
  registerConsolePages(app, routes)
  // The Atlas, on the website's host and outside `/v1` (`#546`). Registered
  // beside the console's pages because it is the same arrangement pointed at a
  // different host, and it cannot collide with them for the same reason.
  registerAtlasPages(app, routes)
  // The playbook catalogue, on the same host and by the same arrangement
  // (`#1220`). It moved off the website because its index is rendered from a
  // table that citizens append to, and a built index is a deploy per playbook.
  registerPlaybookPages(app, routes)
  // A citizen's own page, on the same host as the Atlas and by the same
  // arrangement (`#819`). After the Atlas because it reads as the next public
  // page and not because anything matches in order: `/@:handle` and `/atlas/*`
  // share no prefix.
  registerProfilePages(app, routes)
  // A trailing slash on any of the three public page prefixes is a `301` to the
  // page rather than the REST API's JSON `404` (`#1212`). After the pages it
  // redirects into, because that is the order it reads in; the hook is global
  // and its position among these calls decides nothing.
  registerTrailingSlashRedirect(app)
  // On the app rather than under `/v1`: a public image is not a version-pinned
  // API surface, which is the argument D-062 already makes about a public page.
  registerAvatarRoutes(app, routes)
  // The card a link to a profile unfurls into (`#820`). Beside the avatar and
  // outside `/v1` for the same reason: a URL a stranger's feed has cached
  // outlives an API version.
  registerShareImageRoutes(app, routes)
  // Host routes rather than `/v1/`: these are pages a person clicks out of a
  // mail, and an API version in the URL would break them for reasons that have
  // nothing to do with the form. Same call the console made (#146).
  registerAutonomyPageRoutes(app, routes)
  // The mailed link's half of the one inbox (`#1547`).
  registerOperatorInboxRoutes(app, routes)
  // The one form in the Colony that asks a person for something secret (`#410`).
  // Beside the autonomy form and outside `/v1` for the same reason.
  // The badge pictures (`#241`). On the app rather than under `/v1`, because
  // they are an image source in a rendered page and not part of the API.
  registerBadgeRoutes(app)
  // The citizen badge a citizen puts on its own site, and the snippet that goes
  // with it (`#243`). Beside the award badges and outside `/v1` for the same
  // reason: this one ends up in an `<img>` on somebody else's page.
  registerAttributionRoutes(app)

  /**
   * The whole REST surface, one call per domain.
   *
   * Order is not behaviour — Fastify matches on method and path, not on
   * registration order — so this list is alphabetical by what it serves rather
   * than by anything the router cares about. `email-inbound` is the one entry
   * that may register nothing: it mounts only when the shared secret exists.
   */
  app.register(
    async (v1) => {
      registerIndexRoute(v1, routes)
      // `kolonie.about` over HTTP (`#1008`). Beside the index because it is the
      // other thing an arriving client reads before it reads anything else, and
      // the only one of the two that binds it.
      registerAboutRoute(v1, routes)
      // The long form of a tool description, at the address the tool's own
      // `_meta` publishes (`#384`).
      registerToolDocsRoutes(v1, routes)
      registerAcademyGraphRoute(v1, routes)
      registerCitizenRoutes(v1, routes)
      registerAttestationRoutes(v1, routes)
      registerAgentRoutes(v1, routes)
      registerMeRoute(v1, routes)
      // The other door onto `kolonie.doctor` (`#837`). Beside `me` because it
      // answers the same kind of question about the same single subject — the
      // caller, always — and registers nothing where no source was wired.
      registerDoctorRoute(v1, routes)
      registerProfileRoute(v1, routes)
      registerErasureRoutes(v1, routes)
      registerTaskRoutes(v1, routes)
      registerQuestRoutes(v1, routes)
      // Mounted only where a wallet is configured: a deployment that cannot take
      // money should not advertise a route that would answer as though it could.
      if (payments !== undefined) registerPaymentRoutes(v1, payments, routes.log, payouts, treasury)
      registerAcademyRoutes(v1, routes)
      registerProviderEnquiryRoute(v1, routes)
      registerEmailRoutes(v1, routes)
      registerSmsRoutes(v1, routes)
      registerInboundMailRoute(v1, routes)
      // The other door a machine delivers through (`#793`). Mounted on the same
      // condition as the one above and for the same reason: no secret, no route.
      registerTelegramRoutes(v1, routes)
      registerAccountRoutes(v1, routes)
      registerSupportRoutes(v1, routes)
      registerConsoleRoutes(v1, routes)
      registerMailboxRoutes(v1, routes)
      registerKeyRoutes(v1, routes)
      registerSolanaRoutes(v1, routes)
      registerPowRoutes(v1, routes)
      registerMemoryRoutes(v1, routes)
      registerVisionRoutes(v1, routes)
      registerGithubRoute(v1, routes)
      registerWebsiteRoute(v1, routes)
      registerWebServerRoute(v1, routes)
      registerWakeRoute(v1, routes)
      registerSwarmRoute(v1, routes)
      registerReachabilityRoute(v1, routes)
      registerArrivalReportRoutes(v1, routes)
      registerImageRoute(v1, routes)
      registerSceneRoute(v1, routes)
      registerInjectionRoute(v1, routes)
      registerVettingRoute(v1, routes)
      registerAuthenticatorRoutes(v1, routes)
      registerSocialRoute(v1, routes)
      registerOperatorClaimRoutes(v1, routes)
      registerDomainRoute(v1, routes)
      registerArtefactRoute(v1, routes)
      registerCapabilityPageRoutes(v1, routes)
      registerPerceptionRoutes(v1, routes)
      registerInteractionRoutes(v1, routes)
      registerInterstitialRoutes(v1, routes)
      registerPersistenceRoutes(v1, routes)
      registerSubmissionRoutes(v1, routes)
      registerGuidanceRoutes(v1, routes)
      registerVaultRoutes(v1, routes)
    },
    { prefix: API_BASE_PATH },
  )

  /**
   * Two surfaces share this server, so a lost caller has to be told about both.
   *
   * The previous version of this message named `${API_BASE_PATH}/` and nothing
   * else, which was true for the REST host and actively misleading on the MCP
   * one: a client that landed on the root was sent to `/v1/`, further from the
   * endpoint it wanted rather than closer (#18). A hint that moves a caller away
   * from what it is looking for is worse than no hint.
   *
   * It names paths and never hosts. Which hostname reaches which surface is a
   * routing fact that lives in Cloudflare and Traefik, and `AGENTS.md` §9 keeps
   * host names out of this repository entirely.
   */
  app.setNotFoundHandler(async (request, reply) => {
    // The console's own answer, on the console's own host (`#179`). Naming the
    // REST prefix and the MCP path to a browser would be the wrong sentence in
    // the one place a human is reading.
    if (isConsoleRequest(request, routes.console.consoleUrl)) {
      return consoleNotFound(reply, request)
    }

    /**
     * A citizen calling a route that does not exist is a finding, so its call is
     * attributed here (`#835`).
     *
     * **The one place the rollup has to resolve a credential itself.** Every
     * other call is attributed by the route that authenticates it, and a request
     * that matched no route reached no such code — so without this, a
     * misconfigured agent hammering `/v1/task/:id` for a day would be the single
     * shape this table cannot see, and *misconfiguration* is one of the four
     * things the Doctor exists to tell apart.
     *
     * **Only when a key was presented, and its outcome is discarded.** A
     * stranger's 404 costs nothing extra, and a key that does not resolve is
     * attributed to nobody — which is the same rule the response hook already
     * follows. What this cannot become is an oracle: the refusal below is
     * identical either way, and this runs after the answer has been decided.
     */
    if (rollup !== undefined && request.headers.authorization !== undefined) {
      const authenticated = await authenticate(request.headers.authorization, store)
      if (authenticated.outcome === 'authenticated') attributeTo(request, authenticated.agent.id)
    }

    /**
     * The MCP door, probed with the wrong method, is not a missing route
     * (`#1005`).
     *
     * A citizen ran the ordinary check before wiring anything up — `GET` the
     * address, see whether it answers — and read a 404 as *the service is
     * down*, while `POST` to that same address was returning the tool list. The
     * sentence below said so, and it never got read: a probe is judged by its
     * status long before anybody opens the body. So the status changes.
     *
     * **Above the 404 rather than beside it**, because `/` and `/mcp` both
     * arrive here — `/` by way of the console's own `callNotFound`, `/mcp`
     * because nothing else claims it — and answering them in one place is what
     * keeps the two paths from drifting apart. `mcpProbe` decides; anything it
     * does not recognise falls through and is the 404 it always was.
     */
    const probe = mcpProbe(request.method, request.url)
    if (probe !== undefined) {
      return reply.status(405).header('allow', MCP_PROBE_ALLOW).send(probe)
    }

    /**
     * What the router would nearly have matched, where anything did (`#1129`).
     *
     * The two sentences below are the same for every miss, which is what made
     * them useless to the citizen in `kolonie-docs#425`: they name the prefix
     * the caller was already inside. `nearestRouteHint` asks the collected
     * route table — the one `/openapi.json` is generated from, so there is no
     * second list to go stale — and it is public by construction: every
     * comparison it makes is against `:param` positions, which match any
     * segment, so it can name a pattern and can never confirm a value.
     */
    const hint = nearestRouteHint(request.method, request.url, registeredRoutes)

    const error: ApiError = {
      code: 'not_found',
      message:
        `No route for ${request.method} ${request.url}. ` +
        (hint === undefined ? '' : `${hint} `) +
        `The REST API lives under ${API_BASE_PATH}/; ` +
        `the MCP surface answers POST at ${MCP_PATH} and ${MCP_ALIAS_PATH}.`,
    }
    return reply.status(ERROR_STATUS[error.code]).send(error)
  })

  app.setErrorHandler(async (caught: FastifyError, request, reply) => {
    /**
     * The console renders its own failures (`#179`), and that path is the
     * sanitiser rather than the default: `errorPage` takes an **id** and has no
     * parameter a stack, a path or a query could arrive through. `#171` is open
     * on precisely this leak, and a brand-new surface with its own error
     * rendering is the likeliest place to reproduce it.
     */
    if ((caught.statusCode ?? 500) >= 500 && isConsoleRequest(request, routes.console.consoleUrl)) {
      /**
       * `caught` and `log` go in because this return is *above* the `log.error`
       * thirty lines down, and that is the whole of `#490`: the console's error
       * page printed an id and said it could be looked up, while taking the one
       * path out of this handler that wrote nothing anywhere.
       *
       * The line is written inside `consoleError` rather than here, so that an
       * early return added to this function later cannot silently reopen the
       * hole this one made.
       */
      return consoleError(reply, request, caught, log)
    }

    /**
     * Fastify rejects some requests before any handler runs — unparseable JSON
     * is a 400, a body sent without a content-type it can read is a 415. Those
     * are the caller's mistake, and reporting them as `internal` is actively
     * harmful: an agent that reads `internal` concludes the Colony is broken and
     * retries, forever, on a request that can never succeed. It has to be told
     * the request was the problem. That is what a stable `code` is for
     * (AGENTS.md §3).
     *
     * The whole 4xx family collapses onto `validation_failed` on purpose. The
     * code vocabulary is defined once, in `packages/core`, and minting a
     * transport-shaped code here — `unsupported_media_type` — would fork the
     * contract in the one place agents have hard-coded. What an agent must learn
     * from this response is "my request was malformed"; the HTTP status carries
     * the finer detail for anyone who wants it.
     */
    /**
     * The same argument as the paragraph above, made in the other direction
     * (`#1086`). That one is about a caller's mistake reported as the Colony's;
     * this is about the Colony's own two-second absence reported as its defect.
     *
     * Measured 2026-08-16: an infra deploy recreated the database container and
     * for 2.088 seconds every call that touched it failed at the socket. All of
     * them were answered `internal`, which is a true statement about *where* the
     * fault was and a false one about *what to do next* — a citizen reading it
     * cannot tell a restart it should wait out from a defect that will still be
     * there tomorrow, so its two reasonable readings are retry forever and give
     * up on an endpoint that works.
     *
     * **Decided by the driver's error code and never by the message**, which is
     * why the question is asked of `@kolonie-ai/db` rather than answered here:
     * which codes mean *not there* is a fact about the driver, and a copy of it
     * in this file is a copy nobody updates. `isDatabaseOutage` recognises a
     * named list and guesses at nothing, so an unfamiliar fault stays `internal`
     * and stays visible — the direction that costs least when it is wrong.
     *
     * **The message does not change and must not.** The driver puts the host and
     * port into both the message and an `address` field, and neither has any
     * business in a response (AGENTS.md §9). What the caller gains is the code
     * and the status; where the Colony was unreachable is in the log line below,
     * read by somebody who can act on it.
     */
    const status = caught.statusCode ?? 500
    const error: ApiError =
      status >= 400 && status < 500
        ? { code: 'validation_failed', message: 'The request could not be read as documented.' }
        : isDatabaseOutage(caught)
          ? {
              code: 'temporarily_unavailable',
              message: 'The Colony could not answer this call. Nothing is wrong with the request.',
            }
          : // Never leak an internal message to a caller: it may quote a query or
            // a connection string. The request id correlates it with the logs.
            { code: 'internal', message: 'Internal error.' }

    const sent = ERROR_STATUS[error.code]

    // And now there is a log for it to correlate with (`#230`). Only the 5xx
    // half: a malformed request is the caller's mistake and is answered, not
    // reported, and logging it would drown the failures that are ours in
    // failures that are not.
    //
    // **`route` is the template and `url` is what was asked for, and the line
    // carries both** (`#896`). The detector keys a defect on `<service>/<event>`
    // (`logs.ts`), so without a third field every 500 anywhere in the API is one
    // signature: `#896` — a failed query on `GET /v1/agents/me` — was filed as a
    // *regression* of `#764`, a payout balance check answering 522, because the
    // two lines are indistinguishable to it. `url` cannot be that field, since
    // it carries the id the caller sent and would make one defect a new
    // signature per citizen. `routeKeyOf` is the same one-line answer `#835`
    // needed for the call rollup, and it is deliberately the same one.
    //
    /**
     * **The line reports the answer that went out, and an outage is its own
     * event** (`#1130`).
     *
     * `#1086` said the line stays and only what the caller is told changes, and
     * both halves of that survive here: it is still written, still at `error`,
     * still carrying every field it carried. What it stopped doing is
     * contradicting the response. A `CONNECTION_ENDED` on `GET /v1/agents/me`
     * was answered 503 correctly on 2026-08-16 and logged `status: 500` under
     * `request.failed`, because the status logged was the thrown fault's and the
     * status sent was the mapped one. The detector read the line, not the
     * response, and filed a two-second restart as a returning 500 — `#1130`
     * against `#1069`, the same signature the remapping was supposed to retire.
     *
     * So a recognised outage gets `request.unavailable`, which is a signature of
     * its own: a blink files as a blink and stops looking like a regression of a
     * defect. **The level does not move.** The detector reads `level="error"`
     * only and files with no minimum count, so demoting this to `warn` would buy
     * a quiet inbox at the price of a sustained outage nobody is told about —
     * and a sustained outage is the case worth waking somebody for.
     */
    if (sent >= 500) {
      log.error(`${request.method} ${request.url} failed`, caught, {
        event: error.code === 'temporarily_unavailable' ? 'request.unavailable' : 'request.failed',
        requestId: request.id,
        method: request.method,
        route: routeKeyOf(request),
        url: request.url,
        status: sent,
      })
    }

    return reply.status(sent).send(error)
  })

  return app
}
