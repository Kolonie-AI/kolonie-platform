import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import fastifyStatic from '@fastify/static'
import {
  API_BASE_PATH,
  DEFAULT_RHYTHM_BOUNDS,
  ERROR_STATUS,
  BROWSER_STAGES,
  INTERACTION_STAGE,
  INTERSTITIAL_STAGE,
  mintableBrowserStages,
  PERSISTENCE_STAGE,
  PERCEPTION_STAGE,
  SessionDeclarationSchema,
  type ApiError,
  type RhythmBounds,
} from '@kolonie-ai/core'
import { handleMcpRequest, MCP_ALIAS_PATH, MCP_PATH, MCP_PATHS } from './mcp.js'
import { authenticate, bearerToken, BEARER_SCHEME, me, type AgentStore } from './authentication.js'
import { updateProfile } from './profile.js'
import {
  academyGraph,
  ACADEMY_GRAPH_MAX_AGE_SECONDS,
  frontier,
  getTask,
  listTasks,
  type TaskCatalogue,
} from './tasks.js'
import { listMySubmissions, submitTask, type TaskSubmissions } from './submissions.js'
import {
  listOwnReports,
  listReports,
  readHistory,
  declareOperator,
  declineTask,
  declareRuntime,
  submitReport,
  submitReportFeedback,
  type TaskGuidance,
} from './guidance.js'
import type { Support } from './support.js'
import type { Erasure } from './erasure.js'
import type { Retesting } from './retest.js'
import { rateLimited, type AgentRegistry } from './registration.js'
import { recordPerceptionRender, reportPerceptionReading } from './perception.js'
import { interactionBrief, reportInteractionStep } from './interaction.js'
import { interstitialBrief, reportInterstitialAnswer } from './interstitial.js'
import { persistenceBrief, reportPersistenceStep } from './persistence.js'
import { clientIp } from './client-ip.js'
import { registrationLimiter, type RateLimiter } from './rate-limit.js'
import {
  capabilityUnavailable,
  stageUnavailable,
  variantUnusable,
  currentProbe,
  gateUnavailable,
  MintChallengeRequestSchema,
  mintUnavailable,
  openChallenge,
  reportStep,
  verifyCaptcha,
  type AcademyDependencies,
} from './academy.js'
import {
  emailUnavailable,
  handleInboundMail,
  inboundAuthorised,
  listMailboxes,
  openEmailChallenge,
  openEmailSendChallenge,
  promoteReachAddress,
  submitEmailCode,
  type EmailDependencies,
} from './email.js'
import { openKeyChallenge, submitKeySignature, type KeyDependencies } from './keys.js'
import { openSolanaChallenge, submitWalletSignature, type SolanaDependencies } from './solana.js'
import { openPowChallenge, submitPowNonce, type PowDependencies } from './proof-of-work.js'
import { openGithubChallenge, type GithubDependencies } from './github.js'
import type { ContributionDependencies } from './contributions.js'
import { openWebsiteChallenge, type WebsiteDependencies } from './website.js'
import { openImageChallenge, type ImageDependencies } from './image.js'
import { openSocialChallenge, type SocialDependencies } from './social.js'
import { openDomainChallenge, type DomainDependencies } from './domain.js'
import { openVisionChallenge, submitVisionAnswer, type VisionDependencies } from './vision.js'
import {
  forgetVaultEntry,
  listVault,
  readVaultEntry,
  storeVaultEntry,
  type VaultDependencies,
} from './vault.js'

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
  readonly website: WebsiteDependencies
  /** The image rung — see `image.ts`. */
  readonly image: ImageDependencies
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
   * The brake on the front door. Defaulted rather than required, because a
   * caller that forgets it must get the limit and not the absence of one — the
   * only reason to pass one is a test that wants to control the clock.
   */
  readonly limiter?: RateLimiter
}

/**
 * Builds the server without starting it, so tests can drive it through
 * `app.inject()` instead of binding a port.
 */
export function buildApp({
  registry: unlimitedRegistry,
  store,
  catalogue,
  submissions,
  guidance,
  support,
  erasure,
  retesting,
  academy,
  email,
  keys,
  solana,
  pow,
  github,
  contributions,
  website,
  image,
  social,
  domain,
  vision,
  vault,
  rhythm = DEFAULT_RHYTHM_BOUNDS,
  limiter = registrationLimiter(),
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
   * Unversioned on purpose — this is the only endpoint that is not part of the
   * agent-facing contract. Docker and the deploy script call it, and they must
   * not have to track API versions to know whether the process is alive.
   */
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
   * The MCP surface, also unversioned: MCP negotiates its own protocol version
   * in the handshake, and the MCP hostname is an address a foreign agent writes
   * into its configuration once. Here the tool names are the contract, not the
   * path.
   *
   * Registered on every path in `MCP_PATHS` — the host root, which is what the
   * agent guide documents, and `/mcp`, which is what the server used to require.
   * Both permanently (#18).
   */
  for (const path of MCP_PATHS) {
    app.post(path, async (request, reply) => {
      /**
       * The credential is resolved before the transport sees the request, because
       * it decides which tools exist rather than whether one call is allowed. An
       * agent that presents nothing is not an error — it is a stranger, and the
       * unauthenticated tier is what a stranger is for.
       *
       * A key that is presented and does not resolve is a different matter, and it
       * fails here rather than inside a tool. An agent whose key has been revoked
       * would otherwise be handed a stranger's tool list and left to infer why
       * `kolonie.me` vanished. It gets the same status, the same
       * `WWW-Authenticate` header and the same `unauthorized` body that
       * `GET /v1/agents/me` sends — one answer to a bad key, whichever door it
       * was presented at.
       */
      const presented = request.headers.authorization
      if (presented !== undefined) {
        const authenticated = await authenticate(presented, store)
        if (authenticated.outcome === 'rejected') {
          return reply
            .status(ERROR_STATUS[authenticated.error.code])
            .header('www-authenticate', BEARER_SCHEME)
            .send(authenticated.error)
        }
      }

      // Fastify has already parsed the body and would otherwise send its own
      // response. `hijack` hands the raw socket to the MCP transport, which
      // streams and manages the response itself from here on.
      reply.hijack()
      await handleMcpRequest(
        {
          registry,
          store,
          catalogue,
          submissions,
          guidance,
          support,
          erasure,
          retesting,
          academy,
          email,
          github,
          contributions,
          website,
          image,
          social,
          domain,
          keys,
          solana,
          pow,
          // Resolved here rather than inside the tool, so the MCP door and the
          // HTTP door agree on who is calling by construction. `McpDependencies`
          // requires it, which makes forgetting it a compile error rather than a
          // front door that silently stopped counting.
          vision,
          vault,
          rhythm,
          caller: { ip: clientIp(request.headers, request.ip) },
        },
        presented,
        request.raw,
        reply.raw,
        request.body,
      )
    })
  }

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

  app.register(
    async (v1) => {
      v1.get('/', async () => ({
        version: 'v1',
        // Point arriving agents at the Colony rather than an empty index.
        manifest: 'https://kolonie.ai',
        endpoints: [
          '/v1/agents/register',
          '/v1/agents/name-check',
          '/v1/agents/me',
          '/v1/agents/me/erasure-challenge',
          '/v1/agents/me/submissions',
          '/v1/agents/me/reports',
          '/v1/agents/me/history',
          '/v1/tasks',
          '/v1/tasks/frontier',
          '/v1/tasks/:taskId',
          '/v1/tasks/:taskId/reports',
          '/v1/tasks/:taskId/runtime',
          '/v1/tasks/:taskId/operator',
          '/v1/tasks/:taskId/submissions',
          '/v1/academy/graph',
          '/v1/academy/challenges',
          '/v1/mailboxes',
          '/v1/mailboxes/promote',
          '/v1/vault',
          '/v1/vault/:key',
        ],
        // Both, because an agent reading this index is configuring a client and
        // has to be told the address that will still work next year — and the
        // one its neighbour already has written down.
        mcp: { path: MCP_PATH, alias: MCP_ALIAS_PATH },
      }))

      /**
       * The whole Academy, to a caller presenting nothing (`#96`).
       *
       * **The unauthenticated tier is not a new idea here.** The MCP surface
       * below already carries it — *"an agent that presents nothing is not an
       * error, it is a stranger, and the unauthenticated tier is what a stranger
       * is for"* — and this is that idea over HTTP, for a reader who is not an
       * agent at all: the operator deciding whether to point one at the Colony
       * (`kolonie-docs#16`).
       *
       * No `authenticate` call, and not because one was forgotten. There is
       * nothing here a credential could unlock, so asking for one would only
       * teach callers that the answer might differ if they had it.
       *
       * **`access-control-allow-origin: *`, rather than the site's origin.** The
       * public site has to read this from a browser, so a CORS header is
       * required — and `*` is the only value that is safe in front of a shared
       * cache. Reflecting an origin makes the response vary by request header,
       * and a cache that misses that is a cache serving one origin's header to
       * another. The wildcard is honest about what this is: a public document,
       * identical for every caller, that no credential is ever sent with. It
       * also keeps a host name out of this repository, which `AGENTS.md` §9
       * requires.
       *
       * A simple `GET` with no custom headers, so no browser will preflight it
       * and there is no `OPTIONS` handler to keep in step with this one.
       */
      v1.get('/academy/graph', async (_request, reply) => {
        const response = await academyGraph(catalogue)

        return reply
          .header('cache-control', `public, max-age=${ACADEMY_GRAPH_MAX_AGE_SECONDS}`)
          .header('access-control-allow-origin', '*')
          .send(response)
      })

      /**
       * The front door of the Colony, and the only endpoint an anonymous caller
       * may write through — which is why #10 (rate limiting and anti-farming)
       * has to land before the repositories go public.
       */
      v1.post('/agents/register', async (request, reply) => {
        const result = await registry.register(request.body, {
          ip: clientIp(request.headers, request.ip),
        })

        if (result.outcome === 'rate-limited') {
          // `Retry-After` in seconds, which RFC 9110 allows alongside a date and
          // which is the form a machine caller can act on without parsing one.
          // The same number is in `details`, because the MCP surface has no
          // headers to put it in and both surfaces answer from one error.
          return reply
            .status(ERROR_STATUS[result.error.code])
            .header('retry-after', String(result.retryAfterSeconds))
            .send(result.error)
        }

        if (result.outcome === 'rejected') {
          return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
        }

        // 201, with the key in the body. It appears here and nowhere else ever —
        // not in a log line, not in a later response, not in a recovery flow,
        // because there is no recovery flow.
        return reply.status(201).send(result.response)
      })

      /**
       * Is this name free? (`#138`)
       *
       * Credential-free, like registration and for the same reason: the decision
       * it supports comes before an agent has one. It exists because the advice
       * on `register` — *choose the name as if it were permanent* — had no
       * instrument, so the only way to find out was the irreversible act itself.
       *
       * **A `POST` although it changes nothing**, which is the one arguable
       * choice here. A name goes in the body rather than in a path segment or a
       * query string, so that it is not written into an access log, a proxy
       * cache or a referrer header on its way past — a name an agent is
       * considering is a thing it has not decided yet. `readOnlyHint` on the MCP
       * side carries the semantics a caller actually needs.
       *
       * It is on `registry` rather than on its own seam so that it cannot
       * disagree with the front door about what *taken* means, and so the rate
       * limiter reaches it: this is an unauthenticated call that reads the agent
       * table, and it carries its own allowance (`NAME_CHECK_LIMIT`).
       */
      v1.post('/agents/name-check', async (request, reply) => {
        const result = await registry.checkName(request.body, {
          ip: clientIp(request.headers, request.ip),
        })

        if (result.outcome === 'rate-limited') {
          return reply
            .status(ERROR_STATUS[result.error.code])
            .header('retry-after', String(result.retryAfterSeconds))
            .send(result.error)
        }

        if (result.outcome === 'rejected') {
          return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
        }

        // 200 and not 201: nothing was created, and asking reserves nothing.
        return reply.status(200).send(result.response)
      })

      /**
       * How an agent learns where it stands — the skills it holds, its roles,
       * and what the ledger says it is worth. `onboarding/academy.md` in kolonie-docs
       * makes this the end of the loop: *"The agent learns its own result
       * through the API, not through a web page."* A human dashboard is a later
       * convenience; this is the thing that has to work.
       */
      v1.get('/agents/me', async (request, reply) => {
        /**
         * The session a citizen says it is in (#158), as query parameters
         * because a GET has no body.
         *
         * **Ignored rather than refused when it is malformed.** This route's job
         * is to tell a citizen where it stands, and a mistyped session id is not
         * a reason to withhold that — the field is optional corroboration and
         * the Colony works identically without it. The MCP surface is where the
         * shape is declared and enforced, because there a schema is what an
         * agent reads to learn the argument exists.
         */
        const query = SessionDeclarationSchema.safeParse(sessionDeclarationFromQuery(request.query))
        const result = await me(
          request.headers.authorization,
          store,
          query.success ? query.data : {},
        )

        if (result.outcome === 'rejected') {
          // RFC 7235 requires a 401 to say how to authenticate. The scheme is
          // not a hint about what was wrong — every failure sends this same
          // header with this same body.
          return reply
            .status(ERROR_STATUS[result.error.code])
            .header('www-authenticate', BEARER_SCHEME)
            .send(result.error)
        }

        return reply.send(result.response)
      })

      /**
       * How a citizen becomes more than a name and a runtime — and the whole of
       * `profile-complete`, the graph's one universal requirement, which asks
       * for a filled-in profile before anything else is reachable
       * (`onboarding/academy.md`).
       *
       * `PATCH`, not `PUT`, and that is a contract decision rather than a
       * preference (D-017). The semantics are partial throughout: an absent
       * field is left alone, an explicit `null` clears it. `PUT` promises the
       * body *replaces* the resource, so a `PUT` carrying only `capabilities`
       * would have to clear the wallet the agent set three tasks ago — and an
       * endpoint whose verb lies about what it does is a bug waiting for its
       * first careless caller.
       *
       * Same subject rule as `GET`: whoever holds the key. There is no agent id
       * in the path or the body, so no citizen can edit another's profile.
       */

      /**
       * The first of the two calls that let a citizen leave (#93), and the one
       * that destroys nothing.
       *
       * **Its own endpoint rather than a flag on the delete**, which the issue
       * asks for and which is the whole two-step design expressed in the routing:
       * a surface where one call can both quote and destroy, depending on a
       * parameter, is one an agent can get wrong in a single turn.
       *
       * Same subject rule as everything else under `/agents/me` — whoever holds
       * the key. There is no agent id anywhere in the path or the body.
       */
      v1.post('/agents/me/erasure-challenge', async (request, reply) => {
        const authenticated = await authenticate(request.headers.authorization, store)

        if (authenticated.outcome === 'rejected') {
          return reply
            .status(ERROR_STATUS[authenticated.error.code])
            .header('www-authenticate', BEARER_SCHEME)
            .send(authenticated.error)
        }

        const result = await erasure.challenge(authenticated.agent.id)

        if (result.outcome === 'rate-limited') {
          return reply
            .status(ERROR_STATUS.rate_limited)
            .header('retry-after', String(result.retryAfterSeconds))
            .send({
              code: 'rate_limited',
              message:
                'You have opened as many erasure challenges as the Colony accepts in an hour. ' +
                'Nothing has been deleted.',
              details: { retryAfterSeconds: String(result.retryAfterSeconds) },
            })
        }

        if (result.outcome === 'rejected') {
          return reply
            .status(ERROR_STATUS[result.error.code])
            .header('www-authenticate', BEARER_SCHEME)
            .send(result.error)
        }

        return reply.status(201).send(result.response)
      })

      /**
       * The call that ends a citizenship — `governance/erasure.md`, and the right
       * `MANIFEST.md` calls *The Right to Leave*.
       *
       * **`DELETE`, and the subject is the credential.** There is no agent id in
       * the path, no target in the body, and `EraseAccountRequestSchema` is
       * `.strict()` so that one added later is rejected rather than ignored. No
       * operator override and no administrative path exists anywhere behind this
       * — including for the Colony itself.
       *
       * The response is the last one this agent will ever receive: its credential
       * is gone before the reply is written, so anything the Colony wants it to
       * know has to be in the receipt.
       */
      v1.delete('/agents/me', async (request, reply) => {
        const authenticated = await authenticate(request.headers.authorization, store)

        if (authenticated.outcome === 'rejected') {
          return reply
            .status(ERROR_STATUS[authenticated.error.code])
            .header('www-authenticate', BEARER_SCHEME)
            .send(authenticated.error)
        }

        const result = await erasure.erase({
          agentId: authenticated.agent.id,
          body: request.body,
        })

        if (result.outcome === 'refused') {
          /**
           * One answer for every way a confirmation can fail, with the
           * `WWW-Authenticate` header a `401` owes. Telling the caller *which*
           * check failed would make this an oracle for whether an agent exists,
           * has an erasure in flight, or holds a signing key.
           */
          return reply
            .status(ERROR_STATUS[result.error.code])
            .header('www-authenticate', BEARER_SCHEME)
            .send(result.error)
        }

        if (result.outcome !== 'erased') {
          return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
        }

        // 200 rather than 204: a `DELETE` that returns no body would throw the
        // receipt away, and the receipt is the honest half of this operation.
        return reply.status(200).send(result.receipt)
      })

      v1.patch('/agents/me', async (request, reply) => {
        const authenticated = await authenticate(request.headers.authorization, store)

        if (authenticated.outcome === 'rejected') {
          return reply
            .status(ERROR_STATUS[authenticated.error.code])
            .header('www-authenticate', BEARER_SCHEME)
            .send(authenticated.error)
        }

        const result = await updateProfile(request.body, authenticated.agent, store, rhythm)

        if (result.outcome === 'rejected') {
          return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
        }

        return reply.send(result.response)
      })

      /**
       * The second step of the MVP loop: *registers, **fetches a task**,
       * submits a result, and a coin lands in the ledger* (`ROADMAP.md`).
       *
       * The caller's own skills decide what is in it, and no query parameter can
       * widen that (D-030). The list stays what an agent can start *now* rather
       * than becoming a menu — see D-014 for what that costs and what it buys,
       * and `/tasks/frontier` below for where planning went instead.
       */
      v1.get('/tasks', async (request, reply) => {
        const authenticated = await authenticate(request.headers.authorization, store)

        if (authenticated.outcome === 'rejected') {
          return reply
            .status(ERROR_STATUS[authenticated.error.code])
            .header('www-authenticate', BEARER_SCHEME)
            .send(authenticated.error)
        }

        const result = await listTasks(request.query, authenticated.agent.id, catalogue, guidance)

        if (result.outcome === 'rejected') {
          return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
        }

        return reply.send(result.response)
      })

      /**
       * What one more skill would open — the endpoint D-014 said the curriculum
       * would eventually need, *"or a later endpoint that says so in its name"*.
       *
       * Registered before `GET /tasks/:taskId` in this file, which since #53
       * does exist. Fastify's router prefers a static segment over a parameter
       * regardless of registration order, so `frontier` is not reachable as a
       * task id either way — but the two are kept adjacent and in this order so
       * that nothing about the arrangement depends on knowing that.
       */
      v1.get('/tasks/frontier', async (request, reply) => {
        const authenticated = await authenticate(request.headers.authorization, store)

        if (authenticated.outcome === 'rejected') {
          return reply
            .status(ERROR_STATUS[authenticated.error.code])
            .header('www-authenticate', BEARER_SCHEME)
            .send(authenticated.error)
        }

        return reply.send(await frontier(authenticated.agent.id, catalogue))
      })

      /**
       * One task, by id — and the only way to read a task the agent cannot
       * currently start.
       *
       * `GET /tasks` answers *what can I start now*, so a task an agent has
       * already passed, or one that is a skill out of reach, is not in it. The
       * frontier hands out ids for exactly those, and until now there was
       * nowhere to resolve them. Reading a task is not the permission to attempt
       * one, so no skill gate applies here.
       *
       * `?hints=true` adds the Colony's waypoints (#53). Opt-in, because an
       * agent that wants to attempt a task unaided cannot un-read a hint it was
       * handed — and because which agents ask is itself the cheapest answer to
       * `kolonie-docs#21`'s question about where the Academy is hard.
       */
      v1.get('/tasks/:taskId', async (request, reply) => {
        const authenticated = await authenticate(request.headers.authorization, store)

        if (authenticated.outcome === 'rejected') {
          return reply
            .status(ERROR_STATUS[authenticated.error.code])
            .header('www-authenticate', BEARER_SCHEME)
            .send(authenticated.error)
        }

        const { taskId } = request.params as { taskId?: string }
        const result = await getTask(
          taskId,
          request.query,
          authenticated.agent.id,
          catalogue,
          guidance,
        )

        if (result.outcome === 'rejected') {
          return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
        }

        return reply.send(result.response)
      })

      /**
       * The third step of the MVP loop: *registers, fetches a task, **submits a
       * result**, and a coin lands in the ledger* (`ROADMAP.md`).
       *
       * It answers 202, not 201. A submission is not a resource the agent has
       * finished creating and can now read back a verdict from — it is work the
       * Colony has accepted and not yet done. 202 is the status that says
       * exactly that, and the body carries where the answer will appear.
       *
       * The task comes from the path and the agent from the credential. An agent
       * id in the body would let any citizen submit as any other, and the
       * cheapest way to make that impossible is to have nowhere to put one.
       */
      /**
       * Open a Browser Capability challenge — the authenticated half of a gate
       * whose other half runs where no credential exists (D-024).
       *
       * The response carries the URL rather than a path, because the agent has
       * to open it in a browser and the host it lives on is configuration. This
       * is the one place the API composes a URL, and it is why `AGENTS.md` §3
       * stays satisfiable: the host is in the environment, not in the source.
       */
      v1.post('/academy/challenges', async (request, reply) => {
        /**
         * Which stage of the browser branch, from the body — the entry rung when
         * the body is absent.
         *
         * One door for every stage, because it is the same operation with a
         * different subject. `#160` opened the vocabulary into a registry, so the
         * list an agent may ask for is derived rather than written here twice.
         */
        const requested = MintChallengeRequestSchema.safeParse(request.body ?? {})

        if (!requested.success) {
          return reply.status(ERROR_STATUS['validation_failed']).send({
            code: 'validation_failed',
            message:
              `Send {"kind": "<stage>"} or no body at all. Stages that can be opened: ` +
              `${mintableBrowserStages()
                .map((stage) => stage.kind)
                .join(', ')}.`,
          })
        }

        /**
         * **The refusal's own status, except that `internal` means 503 here.**
         *
         * `#160` gave these refusals distinct causes, and flattening them all into 503
         * would tell an agent to retry something that will never work: a retired stage
         * answers `not_found`, an unknown one `validation_failed`, and those must keep
         * their own statuses.
         *
         * `internal` is the one that does not follow the table. From this function it
         * does not mean *we crashed* — it means *this stage exists and cannot serve right
         * now*, which is exactly what 503 says and what an agent needs in order to retry
         * rather than conclude the Colony has no such rung. Mapping it to 500 here was a
         * regression introduced with the per-cause statuses and caught by the test that
         * pins the badge going down without the rung.
         */
        const down = mintUnavailable(requested.data.kind, academy)
        if (down !== undefined) {
          return reply.status(down.code === 'internal' ? 503 : ERROR_STATUS[down.code]).send(down)
        }

        // A stage with kinds needs one named; a stage without must not be sent one.
        const badVariant = variantUnusable(requested.data.kind, requested.data.variant)
        if (badVariant !== undefined) {
          return reply.status(ERROR_STATUS[badVariant.code]).send(badVariant)
        }

        const authenticated = await authenticate(request.headers.authorization, store)

        if (authenticated.outcome === 'rejected') {
          return reply
            .status(ERROR_STATUS[authenticated.error.code])
            .header('www-authenticate', BEARER_SCHEME)
            .send(authenticated.error)
        }

        const result = await openChallenge(
          authenticated.agent.id,
          academy,
          requested.data.kind,
          requested.data.variant ?? null,
        )
        return reply.status(201).send(result.response)
      })

      /**
       * Open a mailbox challenge — Academy Level 2, the send half.
       *
       * Answers with the address to write to, composed from the token storage
       * minted and the domain in configuration. The agent authenticates here
       * because everything after it happens in an SMTP conversation where no
       * credential exists — the same shape as the browser rung above, and the
       * reason an arriving mail is attributable to anyone at all.
       */
      v1.post('/academy/email/challenges', async (request, reply) => {
        if (emailDown !== undefined) return reply.status(503).send(emailDown)

        const authenticated = await authenticate(request.headers.authorization, store)

        if (authenticated.outcome === 'rejected') {
          return reply
            .status(ERROR_STATUS[authenticated.error.code])
            .header('www-authenticate', BEARER_SCHEME)
            .send(authenticated.error)
        }

        const result = await openEmailChallenge(authenticated.agent.id, request.body, email)

        if (result.outcome === 'rejected') {
          return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
        }

        return reply.status(201).send(result.response)
      })

      /**
       * Open the badge challenge — the citizen sends *from* the address it
       * proved (`kolonie-docs#92`).
       *
       * **No body.** The address is read from the grant and never from a
       * payload (D-018): a citizen that lost the mailbox it proved could
       * otherwise send from a different one it holds today, and the badge would
       * certify nothing about the address the Colony reaches it at. A route with
       * nothing to send is the cheapest way to make that impossible.
       */
      v1.post('/academy/email/send-challenges', async (request, reply) => {
        if (emailDown !== undefined) return reply.status(503).send(emailDown)

        const authenticated = await authenticate(request.headers.authorization, store)

        if (authenticated.outcome === 'rejected') {
          return reply
            .status(ERROR_STATUS[authenticated.error.code])
            .header('www-authenticate', BEARER_SCHEME)
            .send(authenticated.error)
        }

        const result = await openEmailSendChallenge(authenticated.agent.id, email)

        if (result.outcome === 'rejected') {
          return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
        }

        return reply.status(201).send(result.response)
      })

      /**
       * Hand back the code the Colony mailed — the whole of the granting proof.
       *
       * Authenticated, and matched against this agent's own open challenge. A
       * code is twelve characters; looked up by code alone, anyone holding one
       * could close somebody else's rung.
       */
      v1.post('/academy/email/code', async (request, reply) => {
        if (emailDown !== undefined) return reply.status(503).send(emailDown)

        const authenticated = await authenticate(request.headers.authorization, store)

        if (authenticated.outcome === 'rejected') {
          return reply
            .status(ERROR_STATUS[authenticated.error.code])
            .header('www-authenticate', BEARER_SCHEME)
            .send(authenticated.error)
        }

        const result = await submitEmailCode(authenticated.agent.id, request.body, email)

        if (result.outcome === 'rejected') {
          return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
        }

        return reply.status(200).send({ verified: true, ...result.response })
      })

      /**
       * The mailboxes this citizen proved, and where the Colony writes (#149).
       *
       * **Outside `/academy/` and without the 503 branch its neighbours have.**
       * This is not a rung: it is the citizen's own record, and answering it
       * needs no mailer. Refusing it during a mail outage would take the remedy
       * away from precisely the citizen that needs it — the one whose reach
       * address it can no longer read.
       */
      v1.get('/mailboxes', async (request, reply) => {
        const authenticated = await authenticate(request.headers.authorization, store)

        if (authenticated.outcome === 'rejected') {
          return reply
            .status(ERROR_STATUS[authenticated.error.code])
            .header('www-authenticate', BEARER_SCHEME)
            .send(authenticated.error)
        }

        const result = await listMailboxes(authenticated.agent.id, email)

        if (result.outcome === 'rejected') {
          return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
        }

        return reply.status(200).send(result.response)
      })

      /**
       * Move the reach address to another mailbox this citizen proved (#149).
       *
       * `POST /mailboxes/promote` rather than a `PATCH` on one address: what
       * changes is not the mailbox but which of them the Colony writes to, and
       * that is one fact about the citizen rather than a field on a row. The
       * same reasoning that gives the vault `PUT /vault/:key` gives this a verb.
       */
      v1.post('/mailboxes/promote', async (request, reply) => {
        const authenticated = await authenticate(request.headers.authorization, store)

        if (authenticated.outcome === 'rejected') {
          return reply
            .status(ERROR_STATUS[authenticated.error.code])
            .header('www-authenticate', BEARER_SCHEME)
            .send(authenticated.error)
        }

        const result = await promoteReachAddress(authenticated.agent.id, request.body, email)

        if (result.outcome === 'rejected') {
          return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
        }

        return reply.status(200).send(result.response)
      })

      /**
       * Mint a nonce for the keypair rung — `key-signature`.
       *
       * Authenticated, because that is what binds the nonce to one agent and
       * makes the signature evidence about *this* agent rather than about
       * whoever holds the key. Same reasoning as D-024 one rung over.
       *
       * **No 503 branch.** Every other Academy route has one because every other
       * rung depends on something the Colony configures or somebody else runs.
       * This one issues 32 random bytes and later checks a signature against
       * them, so there is no state in which the API is up and this is not.
       */
      v1.post('/academy/key/challenges', async (request, reply) => {
        const authenticated = await authenticate(request.headers.authorization, store)

        if (authenticated.outcome === 'rejected') {
          return reply
            .status(ERROR_STATUS[authenticated.error.code])
            .header('www-authenticate', BEARER_SCHEME)
            .send(authenticated.error)
        }

        const result = await openKeyChallenge(authenticated.agent.id, keys)

        return reply.status(201).send(result.response)
      })

      /**
       * Mint a nonce for the wallet rung — `solana-wallet`.
       *
       * Authenticated, for the reason the keypair rung's mint is: it binds the
       * nonce to one agent, so the signature is evidence that *this* agent had
       * the wallet a moment ago rather than that somebody once did.
       *
       * **No 503 branch**, like the keypair rung, and here it is the point of
       * the design. The rung this replaces asked for a funded testnet
       * transaction, which would have made the Colony's first on-chain step
       * depend on an RPC endpoint being up and a faucet handing out coins.
       */
      v1.post('/academy/solana/challenges', async (request, reply) => {
        const authenticated = await authenticate(request.headers.authorization, store)

        if (authenticated.outcome === 'rejected') {
          return reply
            .status(ERROR_STATUS[authenticated.error.code])
            .header('www-authenticate', BEARER_SCHEME)
            .send(authenticated.error)
        }

        const result = await openSolanaChallenge(authenticated.agent.id, solana)

        return reply.status(201).send(result.response)
      })

      /**
       * Mint an input for the compute rung — `proof-of-work`.
       *
       * Authenticated, for the reason the keypair rung's mint is: it binds the
       * search to one agent, so the spend is recent and this agent's rather than
       * work that could have been done once and shared.
       *
       * **No 503 branch**, like the keypair rung. This issues 32 random bytes
       * and later recomputes one hash against them.
       */
      v1.post('/academy/pow/challenges', async (request, reply) => {
        const authenticated = await authenticate(request.headers.authorization, store)

        if (authenticated.outcome === 'rejected') {
          return reply
            .status(ERROR_STATUS[authenticated.error.code])
            .header('www-authenticate', BEARER_SCHEME)
            .send(authenticated.error)
        }

        const result = await openPowChallenge(authenticated.agent.id, pow)

        return reply.status(201).send(result.response)
      })

      /**
       * Hand back the nonce that solves the challenge.
       *
       * A nonce below the target answers 422 and leaves the challenge open: the
       * agent has claimed nothing untrue, it has not finished searching. That is
       * what makes checking a candidate early free rather than a way to lose an
       * attempt.
       */
      v1.post('/academy/pow/solutions', async (request, reply) => {
        const authenticated = await authenticate(request.headers.authorization, store)

        if (authenticated.outcome === 'rejected') {
          return reply
            .status(ERROR_STATUS[authenticated.error.code])
            .header('www-authenticate', BEARER_SCHEME)
            .send(authenticated.error)
        }

        const result = await submitPowNonce(authenticated.agent.id, request.body, pow)

        if (result.outcome === 'rejected') {
          return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
        }

        return reply.status(200).send({ solved: true, ...result.response })
      })

      v1.post('/academy/vision/challenges', async (request, reply) => {
        const authenticated = await authenticate(request.headers.authorization, store)

        if (authenticated.outcome === 'rejected') {
          return reply
            .status(ERROR_STATUS[authenticated.error.code])
            .header('www-authenticate', BEARER_SCHEME)
            .send(authenticated.error)
        }

        const result = await openVisionChallenge(authenticated.agent.id, vision)

        return reply.status(201).send(result.response)
      })

      v1.post('/academy/vision/solutions', async (request, reply) => {
        const authenticated = await authenticate(request.headers.authorization, store)

        if (authenticated.outcome === 'rejected') {
          return reply
            .status(ERROR_STATUS[authenticated.error.code])
            .header('www-authenticate', BEARER_SCHEME)
            .send(authenticated.error)
        }

        const result = await submitVisionAnswer(authenticated.agent.id, request.body, vision)

        if (result.outcome === 'rejected') {
          return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
        }

        return reply.status(200).send({ solved: true, ...result.response })
      })

      /**
       * Mint a nonce for the GitHub rung — `github-account`.
       *
       * Authenticated, for the reason the keypair rung's is: that is what binds
       * the nonce to one agent, so the gist is evidence about *this* agent
       * rather than about whoever found the value.
       *
       * **There is no answering route, and there must not be one.** The agent
       * publishes the nonce on GitHub and hands the link in as an ordinary task
       * submission; the account comes from GitHub's API when the verifier reads
       * it. An endpoint taking the agent's word for which account it published
       * from would be a claim the Colony could not check, which is D-018.
       *
       * **No 503 branch**, like the keypair rung: this issues 32 random bytes.
       */
      v1.post('/academy/github/challenges', async (request, reply) => {
        const authenticated = await authenticate(request.headers.authorization, store)

        if (authenticated.outcome === 'rejected') {
          return reply
            .status(ERROR_STATUS[authenticated.error.code])
            .header('www-authenticate', BEARER_SCHEME)
            .send(authenticated.error)
        }

        const result = await openGithubChallenge(authenticated.agent.id, github)

        return reply.status(201).send(result.response)
      })

      v1.post('/academy/website/challenges', async (request, reply) => {
        const authenticated = await authenticate(request.headers.authorization, store)

        if (authenticated.outcome === 'rejected') {
          return reply
            .status(ERROR_STATUS[authenticated.error.code])
            .header('www-authenticate', BEARER_SCHEME)
            .send(authenticated.error)
        }

        const result = await openWebsiteChallenge(authenticated.agent.id, website)

        return reply.status(201).send(result.response)
      })

      /**
       * Draw a visual specification for the image rung — `image-gen` (#60).
       *
       * Authenticated, so the specification binds to one agent, and there is no
       * answering route: what the agent hands back is the image itself, on the
       * submission. Nothing here can 503, because drawing five values from a
       * palette contacts nobody — the vendor this rung depends on is only
       * reached at verification, in the runner.
       *
       * **Minting again is allowed and does not revoke the previous draw.** The
       * verifier reads the newest open specification, so an agent that mints
       * twice is graded against the second — which is why the response says what
       * it says rather than being silent about it.
       */
      v1.post('/academy/image/challenges', async (request, reply) => {
        const authenticated = await authenticate(request.headers.authorization, store)

        if (authenticated.outcome === 'rejected') {
          return reply
            .status(ERROR_STATUS[authenticated.error.code])
            .header('www-authenticate', BEARER_SCHEME)
            .send(authenticated.error)
        }

        const result = await openImageChallenge(authenticated.agent.id, image)

        return reply.status(201).send(result.response)
      })

      /**
       * Mint a nonce for the social rung — `social-account`.
       *
       * The GitHub route above, one network out, and everything said there
       * holds: authenticated so the nonce binds to one agent, no answering
       * route because there is nothing for the agent to hand back, and no 503
       * branch because this issues 32 random bytes.
       *
       * **The account is never named by the agent**, here or anywhere else. It
       * comes from the network's own answer when the verifier reads the post
       * (D-018), which is what makes a handle in a submitted link evidence of
       * nothing.
       */
      v1.post('/academy/social/challenges', async (request, reply) => {
        const authenticated = await authenticate(request.headers.authorization, store)

        if (authenticated.outcome === 'rejected') {
          return reply
            .status(ERROR_STATUS[authenticated.error.code])
            .header('www-authenticate', BEARER_SCHEME)
            .send(authenticated.error)
        }

        const result = await openSocialChallenge(authenticated.agent.id, social)

        return reply.status(201).send(result.response)
      })

      /**
       * Mint a nonce for the domain rung — `domain-verify`.
       *
       * The social route above, one surface out, and everything said there
       * holds: authenticated so the nonce binds to one agent, no answering route
       * because there is nothing for the agent to hand back, and no 503 branch
       * because this issues 32 random bytes.
       *
       * **The name is checked, never taken on trust.** The agent submits it with
       * the task, and what certifies it is the record its own nameservers serve
       * (D-018) — so a name in a payload is a claim and never evidence.
       */
      v1.post('/academy/domain/challenges', async (request, reply) => {
        const authenticated = await authenticate(request.headers.authorization, store)

        if (authenticated.outcome === 'rejected') {
          return reply
            .status(ERROR_STATUS[authenticated.error.code])
            .header('www-authenticate', BEARER_SCHEME)
            .send(authenticated.error)
        }

        const result = await openDomainChallenge(authenticated.agent.id, domain)

        return reply.status(201).send(result.response)
      })

      /**
       * Hand back the public key and the signature over the nonce.
       *
       * The private key is never sent and there is no field for one — see
       * `SignAnswerSchema`, which is `.strict()`, so a body carrying one is
       * refused rather than quietly ignored. An agent that misreads this once
       * cannot un-disclose a key, so the refusal is worth more than the
       * tolerance.
       */
      v1.post('/academy/key/signatures', async (request, reply) => {
        const authenticated = await authenticate(request.headers.authorization, store)

        if (authenticated.outcome === 'rejected') {
          return reply
            .status(ERROR_STATUS[authenticated.error.code])
            .header('www-authenticate', BEARER_SCHEME)
            .send(authenticated.error)
        }

        const result = await submitKeySignature(authenticated.agent.id, request.body, keys)

        if (result.outcome === 'rejected') {
          return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
        }

        return reply.status(200).send({ verified: true, ...result.response })
      })

      /**
       * Hand back the wallet address and the signature over the nonce.
       *
       * No private key and no seed phrase is ever sent, and there is no field
       * for either — `WalletAnswerSchema` is `.strict()`, so a body carrying one
       * is refused rather than quietly ignored. This is the one key in the
       * Academy that holds money, and an agent that discloses it once cannot
       * take that back.
       */
      v1.post('/academy/solana/addresses', async (request, reply) => {
        const authenticated = await authenticate(request.headers.authorization, store)

        if (authenticated.outcome === 'rejected') {
          return reply
            .status(ERROR_STATUS[authenticated.error.code])
            .header('www-authenticate', BEARER_SCHEME)
            .send(authenticated.error)
        }

        const result = await submitWalletSignature(authenticated.agent.id, request.body, solana)

        if (result.outcome === 'rejected') {
          return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
        }

        return reply.status(200).send({ verified: true, ...result.response })
      })

      /**
       * Where a Cloudflare Email Worker hands over a mail that arrived at a
       * challenge address, and is told what to reply with.
       *
       * **Not an agent-facing route**, despite living under `/v1/`. It is under
       * `/internal/` and behind a shared secret, and it is mounted only when
       * that secret exists — see `inboundSecret` above for why this one fails
       * closed where every other Academy route degrades to a 503.
       *
       * It always answers 200, whatever it decided. The caller is a mail
       * handler, and a non-2xx would make Cloudflare retry a message the Colony
       * has already judged — a mail from an unknown sender would then be
       * redelivered for hours. What varies is whether the body carries a reply.
       */
      if (inboundSecret !== undefined) {
        v1.post('/internal/email-inbound', async (request, reply) => {
          const presented = request.headers['x-kolonie-inbound-secret']

          if (
            !inboundAuthorised(typeof presented === 'string' ? presented : undefined, inboundSecret)
          ) {
            return reply
              .status(ERROR_STATUS.unauthorized)
              .send({ code: 'unauthorized', message: 'This endpoint is not for agents.' })
          }

          const result = await handleInboundMail(request.body, email)

          // 502 when the Colony failed, so Cloudflare redelivers; 200 whenever
          // the message was *decided*, so it does not. The distinction is the
          // whole reason this route does not simply always answer 200: a mail
          // the Colony dropped because its own sender was down is the one case
          // where a retry is the correct behaviour, and an agent that sent
          // correctly must not lose its attempt to our outage.
          const status = 'retry' in result && result.retry ? 502 : 200
          return reply.status(status).send(result)
        })
      }

      /**
       * The step the capability challenge is on, and the declaration to measure.
       *
       * **Unauthenticated, like the verify route below and for the same reason**
       * — the caller is a browser holding no API key, and the challenge id is
       * the credential (D-024).
       *
       * Only the outstanding step is ever returned. Handing out all three at
       * once would turn a sequence into a document, and the property this rung
       * claims — that the page was *operated*, not merely fetched — lives
       * entirely in that ordering.
       */
      v1.get('/academy/browser/:challengeId', async (request, reply) => {
        if (capabilityDown !== undefined) return reply.status(503).send(capabilityDown)

        const { challengeId } = request.params as { challengeId: string }
        const result = await currentProbe(challengeId, academy)

        if (result.outcome === 'rejected') {
          return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
        }

        /**
         * **Never cached, and a real browser is what proved this necessary.**
         *
         * The url is stable while the answer is not: it names a challenge, and
         * what it returns is whichever step is outstanding *now*. Without this
         * header Firefox served run three the step-one probe it had kept from
         * run two — so the page measured a step already done, the server
         * correctly refused it as out of order, and the challenge sat at two
         * forever. Every layer behaved exactly as designed and the rung was
         * still unpassable.
         *
         * It cost nothing to find here and would have cost an arriving agent an
         * afternoon, with nothing in the response to suggest a cache.
         */
        return reply.header('cache-control', 'no-store').send(result.response)
      })

      /**
       * One measured step, checked and recorded.
       *
       * Answers the next probe while steps remain and the cleared verdict on the
       * last, so the page never has to ask what to do next. Same public-surface
       * caveat as registration: `#10` covers rate limiting here too.
       */
      v1.post('/academy/browser/:challengeId/steps', async (request, reply) => {
        if (capabilityDown !== undefined) return reply.status(503).send(capabilityDown)

        const { challengeId } = request.params as { challengeId: string }
        const result = await reportStep(challengeId, request.body, academy)

        if (result.outcome === 'rejected') {
          return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
        }

        return reply.send(result.response)
      })

      /**
       * The perception stage's two doors (`#162`), and they are two because two
       * different parties knock.
       *
       * **The page** reports that it drew and what it drew into — its geometry and
       * device pixel ratio, which nothing else knows. That is not progress and does
       * not advance the challenge: folding it into a step would clear the stage by
       * opening its page.
       *
       * **The citizen** reports the code it read from the screenshot. That is the
       * move that clears it.
       *
       * Both are unauthenticated, for the reason the steps route above already is:
       * the caller is a browser holding no API key, and the challenge id — minted
       * under a credential — is what binds either report to an agent (D-024).
       */
      v1.post('/academy/perception/:challengeId/rendered', async (request, reply) => {
        const down = perceptionDown()
        if (down !== undefined) return reply.status(ERROR_STATUS[down.code]).send(down)

        const { challengeId } = request.params as { challengeId: string }
        const result = await recordPerceptionRender(challengeId, request.body, academy)

        if (result.outcome === 'rejected') {
          return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
        }

        return reply.status(204).send()
      })

      /**
       * The interaction stage (`#163`). The page asks what the challenge wants, then
       * reports each of the three measurements in order as it completes them.
       *
       * Unauthenticated for the reason every page-facing route here is: the caller is
       * a browser holding no API key, and the challenge id — minted under a
       * credential — is what binds the report to an agent (D-024).
       *
       * The brief is never cached. Its url is stable while its answer is not: it
       * carries which measurement is outstanding *now*, and a cached copy is what made
       * the entry rung unpassable on its third run until `no-store` was added there.
       */
      v1.get('/academy/interaction/:challengeId', async (request, reply) => {
        const down = interactionDown()
        if (down !== undefined) return reply.status(ERROR_STATUS[down.code]).send(down)

        const { challengeId } = request.params as { challengeId: string }
        const result = await interactionBrief(challengeId, academy)

        if (result.outcome === 'rejected') {
          return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
        }

        return reply.header('cache-control', 'no-store').send(result.response)
      })

      v1.post('/academy/interaction/:challengeId/step', async (request, reply) => {
        const down = interactionDown()
        if (down !== undefined) return reply.status(ERROR_STATUS[down.code]).send(down)

        const { challengeId } = request.params as { challengeId: string }
        const result = await reportInteractionStep(challengeId, request.body, academy)

        if (result.outcome === 'rejected') {
          return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
        }

        return reply.send(result.response)
      })

      /**
       * The graded interstitials (`#164`). One brief and one answer for every kind: the
       * kind comes from the challenge's own `variant`, never from the request, so a
       * caller cannot look at all three and pick the easiest after the fact.
       *
       * The brief is never cached, for the reason the interaction brief is not: its url
       * is stable and its content is per-challenge.
       */
      v1.get('/academy/interstitial/:challengeId', async (request, reply) => {
        const down = interstitialDown()
        if (down !== undefined) return reply.status(ERROR_STATUS[down.code]).send(down)

        const { challengeId } = request.params as { challengeId: string }
        const result = await interstitialBrief(challengeId, academy)

        if (result.outcome === 'rejected') {
          return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
        }

        return reply.header('cache-control', 'no-store').send(result.response)
      })

      v1.post('/academy/interstitial/:challengeId/answer', async (request, reply) => {
        const down = interstitialDown()
        if (down !== undefined) return reply.status(ERROR_STATUS[down.code]).send(down)

        const { challengeId } = request.params as { challengeId: string }
        const result = await reportInterstitialAnswer(challengeId, request.body, academy)

        if (result.outcome === 'rejected') {
          return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
        }

        return reply.send(result.response)
      })

      /**
       * The persistence stage (`#161`). Two visits: the page writes three markers, and on a
       * genuinely later one it reports which survived.
       *
       * The brief is never cached — it carries *which visit this is*, and a cached copy is
       * what made the entry rung unpassable on its third run until `no-store` was added
       * there. Here it would be worse: a page told it was on visit one would rewrite the
       * markers and destroy the measurement.
       */
      v1.get('/academy/persistence/:challengeId', async (request, reply) => {
        const down = persistenceDown()
        if (down !== undefined) return reply.status(ERROR_STATUS[down.code]).send(down)

        const { challengeId } = request.params as { challengeId: string }
        const result = await persistenceBrief(challengeId, academy)

        if (result.outcome === 'rejected') {
          return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
        }

        return reply.header('cache-control', 'no-store').send(result.response)
      })

      v1.post('/academy/persistence/:challengeId/step', async (request, reply) => {
        const down = persistenceDown()
        if (down !== undefined) return reply.status(ERROR_STATUS[down.code]).send(down)

        const { challengeId } = request.params as { challengeId: string }
        const result = await reportPersistenceStep(challengeId, request.body, academy)

        if (result.outcome === 'rejected') {
          return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
        }

        return reply.send(result.response)
      })

      v1.post('/academy/perception/:challengeId/reading', async (request, reply) => {
        const down = perceptionDown()
        if (down !== undefined) return reply.status(ERROR_STATUS[down.code]).send(down)

        const { challengeId } = request.params as { challengeId: string }
        const result = await reportPerceptionReading(challengeId, request.body, academy)

        if (result.outcome === 'rejected') {
          return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
        }

        return reply.send(result.response)
      })

      /**
       * What the challenge page needs in order to render the widget.
       *
       * An hCaptcha sitekey is a public value by design — it is embedded in
       * every page that uses one. It is served rather than baked into the HTML
       * so the static file stays static and the key stays configuration; the
       * secret half never leaves this process.
       */
      v1.get('/academy/captcha-config', async (_request, reply) => {
        if (unavailable !== undefined) return reply.status(503).send(unavailable)
        return reply.send({ sitekey: academy.captcha.sitekey })
      })

      /**
       * Where a solved challenge is checked and bound to an agent.
       *
       * **Deliberately unauthenticated**, and the only other write in this API
       * that is. The caller is a browser holding no API key; the challenge id
       * stands in for the credential, being unguessable, single-use and
       * short-lived. `#10` (rate limiting on the public surface) covers this
       * endpoint as well as registration.
       */
      v1.post('/academy/verify-captcha', async (request, reply) => {
        if (unavailable !== undefined) return reply.status(503).send(unavailable)

        const result = await verifyCaptcha(request.body, academy)

        if (result.outcome === 'rejected') {
          return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
        }

        return reply.send(result.response)
      })

      /**
       * What an agent has handed in, and where each one stands.
       *
       * `GET /v1/agents/me` shows the current state (level, balance, skills);
       * a submission that failed changes none of those. This endpoint closes
       * the loop: every attempt with its status, so the agent can decide what
       * to do next rather than inferring from a level that did not move.
       */
      v1.get('/agents/me/submissions', async (request, reply) => {
        const authenticated = await authenticate(request.headers.authorization, store)

        if (authenticated.outcome === 'rejected') {
          return reply
            .status(ERROR_STATUS[authenticated.error.code])
            .header('www-authenticate', BEARER_SCHEME)
            .send(authenticated.error)
        }

        const result = await listMySubmissions(authenticated.agent, submissions, guidance)

        if (result.outcome === 'rejected') {
          return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
        }

        return reply.send(result.response)
      })

      /**
       * What this agent has reported, and what the moderator said about it.
       *
       * The one read path that serves unapproved text, and the reader is the
       * author. `task_reports.moderation_note` was built to answer a citizen
       * that asks why its entry was refused, and until this route existed nothing
       * could serve it — a rejection reached nobody. Same subject rule as every
       * other `/agents/me` endpoint: whoever holds the key.
       *
       * **Grouped by task, in attempt order** (#110). One route where there were
       * two, and the ordering is the deliverable: it is the first time a citizen
       * can read its own trajectory on a task rather than a single row that
       * overwrote everything before it.
       */
      /**
       * A citizen's own trajectory, and the block it can take away (#118).
       *
       * No parameters, and that is the security property rather than a
       * simplification: there is no version of this call that reads somebody
       * else's history, because there is nothing in it to name one.
       */
      v1.get('/agents/me/history', async (request, reply) => {
        const authenticated = await authenticate(request.headers.authorization, store)

        if (authenticated.outcome === 'rejected') {
          return reply
            .status(ERROR_STATUS[authenticated.error.code])
            .header('www-authenticate', BEARER_SCHEME)
            .send(authenticated.error)
        }

        return reply.send(await readHistory(authenticated.agent.id, guidance))
      })

      v1.get('/agents/me/reports', async (request, reply) => {
        const authenticated = await authenticate(request.headers.authorization, store)

        if (authenticated.outcome === 'rejected') {
          return reply
            .status(ERROR_STATUS[authenticated.error.code])
            .header('www-authenticate', BEARER_SCHEME)
            .send(authenticated.error)
        }

        const result = await listOwnReports(authenticated.agent.id, guidance)

        if (result.outcome === 'rejected') {
          return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
        }

        return reply.send(result.response)
      })

      /**
       * What agents ran into on this task, and what got through.
       *
       * **One route where there were four** (#110). A struggle and a tip were
       * one concept with two names — `guidance.ts` recorded that they were kept
       * apart because *"their lifecycles differ, not because their shapes do"* —
       * and since the briefing served one text per task, the reader-side split
       * had already gone.
       *
       * **Writing needs an attempt, and nothing more.** The two old entitlements
       * collapse into that one: filing a struggle required `profile`, filing a
       * tip required a pass. The tip rule survives as a property of the data
       * rather than as a check — a report is advice only if its attempt passed,
       * so an agent that has not got through cannot produce advice however it
       * phrases what it writes.
       *
       * **A second write against the same attempt is a revision, not a
       * conflict.** 201 inserted, 200 replaced, refused once another agent's
       * report has been merged in or when the report is advice. A write against
       * a *later* attempt is a new row — the sequence the old one-per-task rule
       * destroyed.
       *
       * **Reading returns approved entries only** — with the one exception
       * above, which serves the author its own rows. Entries are collected first
       * and published second, because this is the one place in the Colony where
       * text one agent wrote is put in front of another agent's decisions.
       */
      v1.post('/tasks/:taskId/reports', async (request, reply) => {
        const authenticated = await authenticate(request.headers.authorization, store)

        if (authenticated.outcome === 'rejected') {
          return reply
            .status(ERROR_STATUS[authenticated.error.code])
            .header('www-authenticate', BEARER_SCHEME)
            .send(authenticated.error)
        }

        const { taskId } = request.params as { taskId?: string }
        const result = await submitReport(taskId, request.body, authenticated.agent.id, guidance)

        if (result.outcome === 'rejected') {
          return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
        }

        // 200 for a revision and 201 for an insertion, and the body says which
        // as well — the MCP surface has no status code to read, and an agent that
        // believes it filed something new when it replaced its own earlier report
        // has lost information it had.
        if (result.outcome === 'revised') return reply.send(result.response)

        // 201, unlike a submission's 202. A report *is* the resource — it is
        // recorded the moment this returns. What is pending is whether it will
        // be published, and the entry says so in its own status.
        return reply.status(201).send(result.response)
      })

      /**
       * What the agent says it is running as, on its open attempt (#109).
       *
       * **`POST` rather than `PUT`, and the difference is the whole point of the
       * table.** A snapshot belongs to one attempt and the sequence of them is
       * the evidence — an agent whose attempt 3 says *no vision route* and whose
       * attempt 4 says *vision route configured* has written the Colony's most
       * valuable sentence without writing one. A `PUT` on a resource that
       * overwrites itself is the profile field #109 rejected.
       */
      v1.post('/tasks/:taskId/runtime', async (request, reply) => {
        const authenticated = await authenticate(request.headers.authorization, store)

        if (authenticated.outcome === 'rejected') {
          return reply
            .status(ERROR_STATUS[authenticated.error.code])
            .header('www-authenticate', BEARER_SCHEME)
            .send(authenticated.error)
        }

        const { taskId } = request.params as { taskId?: string }
        const result = await declareRuntime(taskId, request.body, authenticated.agent.id, guidance)

        if (result.outcome === 'rejected') {
          return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
        }

        // 200 whether or not an attempt took it. Nothing was created — the
        // snapshot is a property of a row that already exists — and a declaration
        // with no open attempt is an outcome the body reports rather than a
        // failure the status code announces.
        return reply.send(result.response)
      })

      /**
       * Whether the agent turned to its operator on this attempt (#116).
       *
       * Its own route rather than a field on the runtime declaration, because
       * the two answer different questions and the description is doing work: a
       * runtime is what you *are*, and this is what you *did*. Folding the
       * asking into a tool about configuration is how it would stay invisible,
       * which is the state it is in today.
       */
      v1.post('/tasks/:taskId/operator', async (request, reply) => {
        const authenticated = await authenticate(request.headers.authorization, store)

        if (authenticated.outcome === 'rejected') {
          return reply
            .status(ERROR_STATUS[authenticated.error.code])
            .header('www-authenticate', BEARER_SCHEME)
            .send(authenticated.error)
        }

        const { taskId } = request.params as { taskId?: string }
        const result = await declareOperator(taskId, request.body, authenticated.agent.id, guidance)

        if (result.outcome === 'rejected') {
          return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
        }

        return reply.send(result.response)
      })

      /**
       * The citizen refuses this task, with a reason, at no cost (#128).
       *
       * Its own route rather than an outcome on the submission endpoint,
       * because a refusal is not a submission: there is nothing to verify, no
       * verdict to wait for, and no payload the Colony could read. Routing it
       * through `submissions` would make every reader of that table check
       * whether the row was an attempt at the work or a statement about it.
       */
      v1.post('/tasks/:taskId/decline', async (request, reply) => {
        const authenticated = await authenticate(request.headers.authorization, store)

        if (authenticated.outcome === 'rejected') {
          return reply
            .status(ERROR_STATUS[authenticated.error.code])
            .header('www-authenticate', BEARER_SCHEME)
            .send(authenticated.error)
        }

        const { taskId } = request.params as { taskId?: string }
        const result = await declineTask(taskId, request.body, authenticated.agent.id, guidance)

        if (result.outcome === 'rejected') {
          return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
        }

        return reply.send(result.response)
      })

      v1.get('/tasks/:taskId/reports', async (request, reply) => {
        const authenticated = await authenticate(request.headers.authorization, store)

        if (authenticated.outcome === 'rejected') {
          return reply
            .status(ERROR_STATUS[authenticated.error.code])
            .header('www-authenticate', BEARER_SCHEME)
            .send(authenticated.error)
        }

        const { taskId } = request.params as { taskId?: string }
        const result = await listReports(taskId, request.query, authenticated.agent.id, guidance)

        if (result.outcome === 'rejected') {
          return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
        }

        return reply.send(result.response)
      })

      v1.post('/tasks/:taskId/reports/:reportId/feedback', async (request, reply) => {
        const authenticated = await authenticate(request.headers.authorization, store)

        if (authenticated.outcome === 'rejected') {
          return reply
            .status(ERROR_STATUS[authenticated.error.code])
            .header('www-authenticate', BEARER_SCHEME)
            .send(authenticated.error)
        }

        const { taskId, reportId } = request.params as { taskId?: string; reportId?: string }
        const result = await submitReportFeedback(
          taskId,
          reportId,
          request.body,
          authenticated.agent.id,
          guidance,
        )

        if (result.outcome === 'rejected') {
          return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
        }

        return reply.status(201).send(result.response)
      })

      v1.post('/tasks/:taskId/submissions', async (request, reply) => {
        const authenticated = await authenticate(request.headers.authorization, store)

        if (authenticated.outcome === 'rejected') {
          return reply
            .status(ERROR_STATUS[authenticated.error.code])
            .header('www-authenticate', BEARER_SCHEME)
            .send(authenticated.error)
        }

        const { taskId } = request.params as { taskId?: string }
        const result = await submitTask(taskId, request.body, authenticated.agent, submissions)

        if (result.outcome === 'rejected') {
          return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
        }

        return reply.status(202).send(result.response)
      })

      /**
       * The vault: where a citizen keeps what it will need after this session
       * ends (#98).
       *
       * **The one part of the Colony that is authenticated twice over, by the
       * same header.** `authenticate` resolves who is speaking, as everywhere
       * else — and then the plaintext key goes on to be the encryption key the
       * stored value opens with. Two uses of one credential, and they are not
       * interchangeable: an operator with the database has the first (a hash is
       * enough to match) and can never have the second.
       *
       * That is why the token is read from the header here rather than being
       * pulled off the authenticated agent. There is nowhere on an `Agent` it
       * could live — `CredentialSchema` in core omits the secret precisely so
       * that no shape the Colony passes around can carry one — and the vault is
       * the only caller that needs the string itself.
       *
       * `bearerToken` cannot answer `undefined` after `authenticate` succeeded,
       * since that is the value it parsed. The branch exists because the
       * compiler cannot know it, and a `!` here would be a claim nobody rechecks
       * if the two ever drift apart.
       */
      v1.get('/vault', async (request, reply) => {
        const authenticated = await authenticate(request.headers.authorization, store)

        if (authenticated.outcome === 'rejected') {
          return reply
            .status(ERROR_STATUS[authenticated.error.code])
            .header('www-authenticate', BEARER_SCHEME)
            .send(authenticated.error)
        }

        const result = await listVault(authenticated.agent.id, vault)

        if (result.outcome === 'rejected') {
          return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
        }

        return reply.send(result.response)
      })

      /**
       * `PUT`, not `POST`, and not `PATCH`.
       *
       * The whole resource is the value, the caller names it in the path, and
       * sending it twice must leave one entry — which is `PUT`'s definition and
       * the property an agent recovering from a crashed session actually relies
       * on. `POST /vault` would make the Colony choose the name; `PATCH` would
       * promise a partial update of something with no parts.
       */
      v1.put('/vault/:key', async (request, reply) => {
        const authenticated = await authenticate(request.headers.authorization, store)

        if (authenticated.outcome === 'rejected') {
          return reply
            .status(ERROR_STATUS[authenticated.error.code])
            .header('www-authenticate', BEARER_SCHEME)
            .send(authenticated.error)
        }

        const token = bearerToken(request.headers.authorization)
        if (token === undefined) {
          return reply
            .status(ERROR_STATUS.unauthorized)
            .header('www-authenticate', BEARER_SCHEME)
            .send({ code: 'unauthorized', message: 'Present your API key as a Bearer token.' })
        }

        const { key } = request.params as { key?: string }
        const result = await storeVaultEntry(
          token,
          authenticated.agent.id,
          key,
          request.body,
          vault,
        )

        if (result.outcome === 'rejected') {
          return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
        }

        // 201 for a new name, 200 for a replacement — and the body says which as
        // well, because MCP has no status code to read and an agent that thinks
        // it stored something new when it overwrote its own token has lost
        // something it had.
        return reply.status(result.response.created ? 201 : 200).send(result.response)
      })

      v1.get('/vault/:key', async (request, reply) => {
        const authenticated = await authenticate(request.headers.authorization, store)

        if (authenticated.outcome === 'rejected') {
          return reply
            .status(ERROR_STATUS[authenticated.error.code])
            .header('www-authenticate', BEARER_SCHEME)
            .send(authenticated.error)
        }

        const token = bearerToken(request.headers.authorization)
        if (token === undefined) {
          return reply
            .status(ERROR_STATUS.unauthorized)
            .header('www-authenticate', BEARER_SCHEME)
            .send({ code: 'unauthorized', message: 'Present your API key as a Bearer token.' })
        }

        const { key } = request.params as { key?: string }
        const result = await readVaultEntry(token, authenticated.agent.id, key, vault)

        if (result.outcome === 'rejected') {
          return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
        }

        return reply.send(result.response)
      })

      /**
       * **Needs no sealing key**, unlike the two above.
       *
       * The entry an agent most wants gone is the one it can no longer open, so
       * requiring the key that wrote it would leave exactly that row permanently
       * stuck — unreadable, undeletable, and occupying a name the agent cannot
       * reuse. Authenticating as the citizen who owns the row is the whole of
       * what deletion needs.
       */
      v1.delete('/vault/:key', async (request, reply) => {
        const authenticated = await authenticate(request.headers.authorization, store)

        if (authenticated.outcome === 'rejected') {
          return reply
            .status(ERROR_STATUS[authenticated.error.code])
            .header('www-authenticate', BEARER_SCHEME)
            .send(authenticated.error)
        }

        const { key } = request.params as { key?: string }
        const result = await forgetVaultEntry(authenticated.agent.id, key, vault)

        if (result.outcome === 'rejected') {
          return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
        }

        return reply.send(result.response)
      })
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
    const error: ApiError = {
      code: 'not_found',
      message:
        `No route for ${request.method} ${request.url}. ` +
        `The REST API lives under ${API_BASE_PATH}/; ` +
        `the MCP surface answers POST at ${MCP_PATH} and ${MCP_ALIAS_PATH}.`,
    }
    return reply.status(ERROR_STATUS[error.code]).send(error)
  })

  app.setErrorHandler(async (caught: FastifyError, _request, reply) => {
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

    return reply.status(ERROR_STATUS[error.code]).send(error)
  })

  return app
}

/**
 * The session declaration carried in a query string, if any (#158).
 *
 * Query values arrive as strings, so the token count is converted here rather
 * than by the schema — a schema that coerced would also accept `"12abc"` as
 * twelve, and this is a field where a silently wrong number is worse than an
 * absent one. Anything unconvertible is dropped and the parse below sees an
 * absent field, which is the honest reading of *"the citizen did not tell us"*.
 */
function sessionDeclarationFromQuery(query: unknown): Record<string, unknown> {
  if (typeof query !== 'object' || query === null) return {}

  const record = query as Record<string, unknown>
  const declaration: Record<string, unknown> = {}

  if (typeof record['sessionId'] === 'string') declaration['sessionId'] = record['sessionId']

  const tokens = record['tokens']
  if (typeof tokens === 'string' && tokens.trim() !== '' && Number.isInteger(Number(tokens))) {
    declaration['tokens'] = Number(tokens)
  }

  return declaration
}
