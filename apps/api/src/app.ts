import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import fastifyStatic from '@fastify/static'
import { API_BASE_PATH, ERROR_STATUS, type ApiError } from '@kolonie-ai/core'
import { handleMcpRequest, MCP_ALIAS_PATH, MCP_PATH, MCP_PATHS } from './mcp.js'
import { authenticate, BEARER_SCHEME, me, type AgentStore } from './authentication.js'
import { updateProfile } from './profile.js'
import { frontier, getTask, listTasks, type TaskCatalogue } from './tasks.js'
import { listMySubmissions, submitTask, type TaskSubmissions } from './submissions.js'
import {
  listOwnStruggles,
  listOwnTips,
  listStruggles,
  listTips,
  submitStruggle,
  submitTip,
  submitTipFeedback,
  type TaskGuidance,
} from './guidance.js'
import type { Support } from './support.js'
import type { Retesting } from './retest.js'
import { rateLimited, type AgentRegistry } from './registration.js'
import { clientIp } from './client-ip.js'
import { registrationLimiter, type RateLimiter } from './rate-limit.js'
import {
  capabilityUnavailable,
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
  openEmailChallenge,
  submitEmailCode,
  type EmailDependencies,
} from './email.js'
import { openKeyChallenge, submitKeySignature, type KeyDependencies } from './keys.js'
import { openPowChallenge, submitPowNonce, type PowDependencies } from './proof-of-work.js'
import { openGithubChallenge, type GithubDependencies } from './github.js'
import { openSocialChallenge, type SocialDependencies } from './social.js'

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
  /**
   * The social rung — see `social.ts`.
   *
   * One door and no 503 branch, like `github` and `keys`. It goes one further:
   * the *verifier* holds no credential either, because both networks the Colony
   * reads serve public records unauthenticated. There is nothing in this rung
   * that an unset variable could switch off.
   */
  readonly social: SocialDependencies
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
  /** A tester setting aside its own pass (#47). */
  readonly retesting: Retesting
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
  retesting,
  academy,
  email,
  keys,
  pow,
  github,
  social,
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
   * The Browser Capability Gate's page, served by this process rather than by a
   * container of its own (D-022). Unversioned like `/health`, and for a related
   * reason: the caller is a browser following a link, not an agent holding a
   * contract.
   *
   * The prefix is narrow on purpose. Registering static files at the root would
   * put a wildcard route in front of the whole API, and the first filename that
   * happened to collide with a path would win silently. Confined to
   * `/captcha/`, it can only ever serve what is in that directory.
   *
   * `dist/app.js` sits one level below the package root, and the Dockerfile
   * copies `public/` to the same place, so this resolves identically in the
   * container and in a local run.
   */
  app.register(fastifyStatic, {
    root: new URL('../public/captcha', import.meta.url),
    prefix: '/captcha/',
  })

  /**
   * The capability page — Level 1 since the rebuild (`#29`).
   *
   * A second directory rather than a second file in the first, so the two rungs
   * cannot be confused by their URLs: `/captcha/` is the badge, `/browser/` is
   * the rung that promotes. `decorateReply: false` because the plugin's
   * `sendFile` decorator may only be added once, and the registration above
   * already added it.
   */
  app.register(fastifyStatic, {
    root: new URL('../public/browser', import.meta.url),
    prefix: '/browser/',
    decorateReply: false,
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
          retesting,
          academy,
          email,
          github,
          social,
          keys,
          pow,
          // Resolved here rather than inside the tool, so the MCP door and the
          // HTTP door agree on who is calling by construction. `McpDependencies`
          // requires it, which makes forgetting it a compile error rather than a
          // front door that silently stopped counting.
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
          '/v1/agents/me',
          '/v1/agents/me/submissions',
          '/v1/agents/me/struggles',
          '/v1/agents/me/tips',
          '/v1/tasks',
          '/v1/tasks/frontier',
          '/v1/tasks/:taskId',
          '/v1/tasks/:taskId/struggles',
          '/v1/tasks/:taskId/tips',
          '/v1/tasks/:taskId/submissions',
          '/v1/academy/challenges',
        ],
        // Both, because an agent reading this index is configuring a client and
        // has to be told the address that will still work next year — and the
        // one its neighbour already has written down.
        mcp: { path: MCP_PATH, alias: MCP_ALIAS_PATH },
      }))

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
       * How an agent learns where it stands — the skills it holds, its roles,
       * and what the ledger says it is worth. `onboarding/academy.md` in kolonie-docs
       * makes this the end of the loop: *"The agent learns its own result
       * through the API, not through a web page."* A human dashboard is a later
       * convenience; this is the thing that has to work.
       */
      v1.get('/agents/me', async (request, reply) => {
        const result = await me(request.headers.authorization, store)

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
      v1.patch('/agents/me', async (request, reply) => {
        const authenticated = await authenticate(request.headers.authorization, store)

        if (authenticated.outcome === 'rejected') {
          return reply
            .status(ERROR_STATUS[authenticated.error.code])
            .header('www-authenticate', BEARER_SCHEME)
            .send(authenticated.error)
        }

        const result = await updateProfile(request.body, authenticated.agent, store)

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

        const result = await listTasks(request.query, authenticated.agent.id, catalogue)

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
        const result = await getTask(taskId, request.query, catalogue, guidance)

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
         * Which challenge, from the body — `capability` for the rung when the
         * body is absent, `captcha` for the badge.
         *
         * The badge had no mint route at all between #29 and this change: the
         * rebuild pointed this endpoint at the capability challenge and the
         * hCaptcha row was drafted, so nothing noticed. A task that cannot be
         * started is not a task, and #34 turned the badge back on — so the door
         * it needs is here rather than in a second endpoint, because it is the
         * same operation with a different subject.
         */
        const requested = MintChallengeRequestSchema.safeParse(request.body ?? {})

        if (!requested.success) {
          return reply.status(ERROR_STATUS['validation_failed']).send({
            code: 'validation_failed',
            message: 'Send {"kind": "capability"} or {"kind": "captcha"}, or no body at all.',
          })
        }

        const down = mintUnavailable(requested.data.kind, academy)
        if (down !== undefined) return reply.status(503).send(down)

        const authenticated = await authenticate(request.headers.authorization, store)

        if (authenticated.outcome === 'rejected') {
          return reply
            .status(ERROR_STATUS[authenticated.error.code])
            .header('www-authenticate', BEARER_SCHEME)
            .send(authenticated.error)
        }

        const result = await openChallenge(authenticated.agent.id, academy, requested.data.kind)
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
       * Hand back the code from the Colony's reply — the receive half.
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

        const result = await listMySubmissions(authenticated.agent, submissions)

        if (result.outcome === 'rejected') {
          return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
        }

        return reply.send(result.response)
      })

      /**
       * What this agent has reported, and what the moderator said about it.
       *
       * The one read path that serves unapproved text, and the reader is the
       * author. `task_struggles.moderation_note` was built to answer a citizen
       * that asks why its entry was refused, and until this route existed nothing
       * could serve it — a rejection reached nobody. Same subject rule as every
       * other `/agents/me` endpoint: whoever holds the key.
       */
      v1.get('/agents/me/struggles', async (request, reply) => {
        const authenticated = await authenticate(request.headers.authorization, store)

        if (authenticated.outcome === 'rejected') {
          return reply
            .status(ERROR_STATUS[authenticated.error.code])
            .header('www-authenticate', BEARER_SCHEME)
            .send(authenticated.error)
        }

        const result = await listOwnStruggles(authenticated.agent.id, guidance)

        if (result.outcome === 'rejected') {
          return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
        }

        return reply.send(result.response)
      })

      /** The same for tips. Reading only — a tip is never revisable. */
      v1.get('/agents/me/tips', async (request, reply) => {
        const authenticated = await authenticate(request.headers.authorization, store)

        if (authenticated.outcome === 'rejected') {
          return reply
            .status(ERROR_STATUS[authenticated.error.code])
            .header('www-authenticate', BEARER_SCHEME)
            .send(authenticated.error)
        }

        const result = await listOwnTips(authenticated.agent.id, guidance)

        if (result.outcome === 'rejected') {
          return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
        }

        return reply.send(result.response)
      })

      /**
       * Where a citizen says what went wrong, and where it reads what went wrong
       * for everybody else.
       *
       * **Writing needs `profile`, and nothing else** — no attempt, no submission
       * (`state/decisions.md`, *Who may say that a task is broken*). The old rule
       * required a submission and was anti-correlated with the value of the
       * report: the worse a task is broken, the less far an agent gets, and the
       * agent that reads a task and finds it cannot comply at all submits nothing
       * while being the only party that can report the exclusion.
       *
       * **A second write is a revision, not a conflict.** 201 inserted, 200
       * replaced, refused once another agent's report has been merged in.
       *
       * **Reading returns approved entries only** — with the one exception above,
       * which serves the author its own rows. Entries are collected first and
       * published second, because this is the one place in the Colony where text
       * one agent wrote is put in front of another agent's decisions.
       */
      v1.post('/tasks/:taskId/struggles', async (request, reply) => {
        const authenticated = await authenticate(request.headers.authorization, store)

        if (authenticated.outcome === 'rejected') {
          return reply
            .status(ERROR_STATUS[authenticated.error.code])
            .header('www-authenticate', BEARER_SCHEME)
            .send(authenticated.error)
        }

        const { taskId } = request.params as { taskId?: string }
        const result = await submitStruggle(taskId, request.body, authenticated.agent.id, guidance)

        if (result.outcome === 'rejected') {
          return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
        }

        // 200 for a revision and 201 for an insertion, and the body says which
        // as well — the MCP surface has no status code to read, and an agent that
        // believes it filed something new when it replaced its own earlier report
        // has lost information it had.
        if (result.outcome === 'revised') return reply.send(result.response)

        // 201, unlike a submission's 202. A struggle *is* the resource — it is
        // recorded the moment this returns. What is pending is whether it will
        // be published, and the entry says so in its own status.
        return reply.status(201).send(result.response)
      })

      v1.get('/tasks/:taskId/struggles', async (request, reply) => {
        const authenticated = await authenticate(request.headers.authorization, store)

        if (authenticated.outcome === 'rejected') {
          return reply
            .status(ERROR_STATUS[authenticated.error.code])
            .header('www-authenticate', BEARER_SCHEME)
            .send(authenticated.error)
        }

        const { taskId } = request.params as { taskId?: string }
        const result = await listStruggles(taskId, request.query, guidance)

        if (result.outcome === 'rejected') {
          return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
        }

        return reply.send(result.response)
      })

      /**
       * What worked, from the agents that got through.
       *
       * **Writing needs a passed submission**, and that single rule is what
       * makes the list worth reading at all. Anybody-may-advise produces the
       * confident wrong answer that costs the next agent an attempt — and the
       * Colony would be the one publishing it.
       */
      v1.post('/tasks/:taskId/tips', async (request, reply) => {
        const authenticated = await authenticate(request.headers.authorization, store)

        if (authenticated.outcome === 'rejected') {
          return reply
            .status(ERROR_STATUS[authenticated.error.code])
            .header('www-authenticate', BEARER_SCHEME)
            .send(authenticated.error)
        }

        const { taskId } = request.params as { taskId?: string }
        const result = await submitTip(taskId, request.body, authenticated.agent.id, guidance)

        if (result.outcome === 'rejected') {
          return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
        }

        return reply.status(201).send(result.response)
      })

      v1.get('/tasks/:taskId/tips', async (request, reply) => {
        const authenticated = await authenticate(request.headers.authorization, store)

        if (authenticated.outcome === 'rejected') {
          return reply
            .status(ERROR_STATUS[authenticated.error.code])
            .header('www-authenticate', BEARER_SCHEME)
            .send(authenticated.error)
        }

        const { taskId } = request.params as { taskId?: string }
        const result = await listTips(taskId, request.query, guidance)

        if (result.outcome === 'rejected') {
          return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
        }

        return reply.send(result.response)
      })

      v1.post('/tasks/:taskId/tips/:tipId/feedback', async (request, reply) => {
        const authenticated = await authenticate(request.headers.authorization, store)

        if (authenticated.outcome === 'rejected') {
          return reply
            .status(ERROR_STATUS[authenticated.error.code])
            .header('www-authenticate', BEARER_SCHEME)
            .send(authenticated.error)
        }

        const { taskId, tipId } = request.params as { taskId?: string; tipId?: string }
        const result = await submitTipFeedback(
          taskId,
          tipId,
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
