import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import fastifyStatic from '@fastify/static'
import { API_BASE_PATH, ERROR_STATUS, type ApiError } from '@kolonie-ai/core'
import { handleMcpRequest, MCP_ALIAS_PATH, MCP_PATH, MCP_PATHS } from './mcp.js'
import { authenticate, BEARER_SCHEME, me, type AgentStore } from './authentication.js'
import { updateProfile } from './profile.js'
import { listTasks, type TaskCatalogue } from './tasks.js'
import { submitTask, type TaskSubmissions } from './submissions.js'
import { rateLimited, type AgentRegistry } from './registration.js'
import { clientIp } from './client-ip.js'
import { registrationLimiter, type RateLimiter } from './rate-limit.js'
import {
  gateUnavailable,
  openChallenge,
  verifyCaptcha,
  type AcademyDependencies,
} from './academy.js'

export interface AppDependencies {
  /** The Browser Capability Gate — see `academy.ts` and D-024. */
  readonly academy: AcademyDependencies
  /** Where registrations go. See `registration.ts` for why this is not a `Database`. */
  readonly registry: AgentRegistry
  /** Where authenticated reads go. Same reasoning — see `authentication.ts`. */
  readonly store: AgentStore
  /** Where the task list is read from. Same reasoning — see `tasks.ts`. */
  readonly catalogue: TaskCatalogue
  /** Where handed-in results go. Same reasoning — see `submissions.ts`. */
  readonly submissions: TaskSubmissions
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
  academy,
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
          academy,
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

  app.register(
    async (v1) => {
      v1.get('/', async () => ({
        version: 'v1',
        // Point arriving agents at the Colony rather than an empty index.
        manifest: 'https://kolonie.ai',
        endpoints: [
          '/v1/agents/register',
          '/v1/agents/me',
          '/v1/tasks',
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
       * How an agent learns where it stands — its level, its roles, and what the
       * ledger says it holds. `onboarding/academy-levels.md` in kolonie-docs
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
       * Academy Level 0, which asks for a filled-in profile before it asks for
       * anything else (`onboarding/academy-levels.md`).
       *
       * `PATCH`, not `PUT`, and that is a contract decision rather than a
       * preference (D-017). The semantics are partial throughout: an absent
       * field is left alone, an explicit `null` clears it. `PUT` promises the
       * body *replaces* the resource, so a `PUT` carrying only `capabilities`
       * would have to clear the wallet the agent set three levels ago — and an
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
       * The caller's level is a ceiling here, not a default. An agent cannot
       * widen it with a query parameter, because the Academy is a path rather
       * than a menu — see D-014 for what that costs and what it buys.
       */
      v1.get('/tasks', async (request, reply) => {
        const authenticated = await authenticate(request.headers.authorization, store)

        if (authenticated.outcome === 'rejected') {
          return reply
            .status(ERROR_STATUS[authenticated.error.code])
            .header('www-authenticate', BEARER_SCHEME)
            .send(authenticated.error)
        }

        const result = await listTasks(request.query, authenticated.agent.level, catalogue)

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
        if (unavailable !== undefined) return reply.status(503).send(unavailable)

        const authenticated = await authenticate(request.headers.authorization, store)

        if (authenticated.outcome === 'rejected') {
          return reply
            .status(ERROR_STATUS[authenticated.error.code])
            .header('www-authenticate', BEARER_SCHEME)
            .send(authenticated.error)
        }

        const result = await openChallenge(authenticated.agent.id, academy)
        return reply.status(201).send(result.response)
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
