import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import fastifyStatic from '@fastify/static'
import type { ProviderRecipes } from './provider-recipes.js'
import type { Attestations } from './attestations.js'
import {
  API_BASE_PATH,
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
import { MCP_ALIAS_PATH, MCP_PATH } from './mcp.js'
import { registerIndexRoute } from './routes/index.js'
import { registerToolDocsRoutes } from './routes/tool-docs.js'
import { registerAcademyGraphRoute } from './routes/academy-graph.js'
import { registerCitizenRoutes } from './routes/citizens.js'
import { registerAttestationRoutes } from './routes/attestations.js'
import type { CitizenRecords } from './citizens.js'
import { registerAgentRoutes } from './routes/agents.js'
import { registerMeRoute } from './routes/me.js'
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
  registerStewardPages,
} from './routes/console-pages.js'
import { registerAcademyRoutes } from './routes/academy.js'
import { registerProviderEnquiryRoute } from './routes/provider-enquiries.js'
import { registerConsoleRoutes } from './routes/console.js'
import { registerEmailRoutes } from './routes/email.js'
import { registerSmsRoutes } from './routes/sms.js'
import { registerInboundMailRoute } from './routes/email-inbound.js'
import { registerAccountRoutes } from './routes/accounts.js'
import { registerMailboxRoutes } from './routes/mailboxes.js'
import { registerKeyRoutes } from './routes/keys.js'
import { registerSolanaRoutes } from './routes/solana.js'
import { registerPowRoutes } from './routes/proof-of-work.js'
import { registerMemoryRoutes } from './routes/memory.js'
import { registerVisionRoutes } from './routes/vision.js'
import { registerGithubRoute } from './routes/github.js'
import { registerWebsiteRoute } from './routes/website.js'
import { registerWebServerRoute } from './routes/web-server.js'
import { registerReachabilityRoute } from './routes/reachability.js'
import { registerImageRoute } from './routes/image.js'
import { registerSceneRoute } from './routes/scene.js'
import { registerInjectionRoute } from './routes/injection.js'
import { registerVettingRoute } from './routes/vetting.js'
import { registerAuthenticatorRoutes } from './routes/authenticator.js'
import { registerAttributionRoutes } from './routes/attribution.js'
import { registerBadgeRoutes } from './routes/badges.js'
import { registerAutonomyPageRoutes } from './routes/autonomy-page.js'
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
import {
  registerOperatorDropPageRoutes,
  registerOperatorDropRoutes,
} from './routes/operator-drops.js'
import { registerVaultRoutes } from './routes/vault.js'
import { capabilityUnavailable, gateUnavailable, stageUnavailable } from './academy.js'
import type { AppDependencies } from './dependencies.js'
import { emailUnavailable } from './email.js'
import type { RouteDependencies } from './routes/dependencies.js'
import { registerMcpRoutes } from './routes/mcp.js'
import { registerOpenApiRoute } from './routes/openapi.js'
import type { RegisteredRoute } from './openapi/document.js'
import { rateLimited } from './registration.js'
import { noEarnings } from './payouts.js'
import { noSettings } from './settings.js'
import { noProviderEnquiries } from './provider-enquiries.js'
import { reachabilityLimiter, registrationLimiter } from './rate-limit.js'
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
  registry: unlimitedRegistry,
  adoption,
  store,
  catalogue,
  quests,
  settings = noSettings(),
  providerEnquiries = noProviderEnquiries(),
  payments,
  payouts,
  earnings = noEarnings(),
  submissions,
  guidance,
  support,
  operatorRequests,
  operatorNotes,
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
  wakeup,
  prospects,
  skillNotes,
  hints,
  website,
  webServer,
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
  drops,
  dropBaseUrl = '',
  accounts,
  recipes,
  attestations,
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

  const app = Fastify({
    logger: false,
    // Agents are the callers here. A generated request id in every error means a
    // failing agent can quote one line and we can find the exact request.
    genReqId: () => crypto.randomUUID(),
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
  app.get('/health', async () => ({ status: 'ok' }))

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
  const citizenRecords: CitizenRecords = citizens ?? { publicRecord: async () => undefined }

  /**
   * An absent catalogue is an empty one (`#521`), resolved here for the reason
   * `citizenRecords` above is: the handler gets one shape to cope with.
   */
  const providerCatalogue: ProviderRecipes = recipes ?? {
    list: async () => [],
    one: async () => undefined,
  }

  /** A colony that confirms nothing is the true answer in one with no citizens (`#519`). */
  const publicAttestations: Attestations = attestations ?? {
    answer: async () => ({ holds: false, grantedAt: null, accountProvedBy: null }),
  }

  const routes: RouteDependencies = {
    log,
    citizens: citizenRecords,
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
    operatorRequests,
    operatorNotes,
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
    wakeup,
    ...(prospects === undefined ? {} : { prospects }),
    ...(skillNotes === undefined ? {} : { skillNotes }),
    hints,
    website,
    webServer,
    /**
     * Defaulted here rather than required of every caller (`#394`): the check
     * needs a limiter and nothing else, and a limiter with no configuration is
     * one this assembly can make. A test that wants to answer without a network,
     * or move time, passes its own.
     */
    reachability: reachability ?? { limiter: reachabilityLimiter() },
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
    drops,
    dropBaseUrl,
    accounts,
    recipes: providerCatalogue,
    attestations: publicAttestations,
    console: consoleDeps,
    earnings,
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
  registerStewardPages(app, routes)
  // Host routes rather than `/v1/`: these are pages a person clicks out of a
  // mail, and an API version in the URL would break them for reasons that have
  // nothing to do with the form. Same call the console made (#146).
  registerAutonomyPageRoutes(app, routes)
  // The one form in the Colony that asks a person for something secret (`#410`).
  // Beside the autonomy form and outside `/v1` for the same reason.
  registerOperatorDropPageRoutes(app, routes)
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
      // The long form of a tool description, at the address the tool's own
      // `_meta` publishes (`#384`).
      registerToolDocsRoutes(v1, routes)
      registerAcademyGraphRoute(v1, routes)
      registerCitizenRoutes(v1, routes)
      registerAttestationRoutes(v1, routes)
      registerAgentRoutes(v1, routes)
      registerMeRoute(v1, routes)
      registerProfileRoute(v1, routes)
      registerErasureRoutes(v1, routes)
      registerTaskRoutes(v1, routes)
      registerQuestRoutes(v1, routes)
      // Mounted only where a wallet is configured: a deployment that cannot take
      // money should not advertise a route that would answer as though it could.
      if (payments !== undefined) registerPaymentRoutes(v1, payments, routes.log, payouts)
      registerAcademyRoutes(v1, routes)
      registerProviderEnquiryRoute(v1, routes)
      registerEmailRoutes(v1, routes)
      registerSmsRoutes(v1, routes)
      registerInboundMailRoute(v1, routes)
      registerAccountRoutes(v1, routes)
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
      registerReachabilityRoute(v1, routes)
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
      registerOperatorDropRoutes(v1, routes)
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

    const error: ApiError = {
      code: 'not_found',
      message:
        `No route for ${request.method} ${request.url}. ` +
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
    const status = caught.statusCode ?? 500
    const error: ApiError =
      status >= 400 && status < 500
        ? { code: 'validation_failed', message: 'The request could not be read as documented.' }
        : // Never leak an internal message to a caller: it may quote a query or
          // a connection string. The request id correlates it with the logs.
          { code: 'internal', message: 'Internal error.' }

    // And now there is a log for it to correlate with (`#230`). Only the 5xx
    // half: a malformed request is the caller's mistake and is answered, not
    // reported, and logging it would drown the failures that are ours in
    // failures that are not.
    if (status >= 500) {
      log.error(`${request.method} ${request.url} failed`, caught, {
        event: 'request.failed',
        requestId: request.id,
        method: request.method,
        url: request.url,
        status,
      })
    }

    return reply.status(ERROR_STATUS[error.code]).send(error)
  })

  return app
}
