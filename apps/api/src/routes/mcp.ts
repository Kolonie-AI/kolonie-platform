import { ERROR_STATUS, type AgentId } from '@kolonie-ai/core'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { authenticate, BEARER_SCHEME, observing, unsubstituted } from '../authentication.js'
import { clientIp } from '../client-ip.js'
import { observedOrigin } from '../observed-origin.js'
import { handleMcpRequest, MCP_PATHS } from '../mcp.js'
import type { McpDependencies } from '../mcp.js'
import { gateFor } from '../throttle-gate.js'
import type { RouteDependencies } from './dependencies.js'

/**
 * The MCP surface, mounted on the paths it answers.
 *
 * **The one route module that takes the app rather than the `/v1` instance**,
 * because it is the one surface that is not under `API_BASE_PATH`. Why it is
 * unversioned is stated on the mount below.
 */
export function registerMcpRoutes(app: FastifyInstance, deps: RouteDependencies): void {
  const {
    log,
    registry,
    store,
    rollup,
    doctor,
    tell,
    suggested,
    catalogue,
    recipes,
    walkPage,
    renames,
    submissions,
    guidance,
    quests,
    earnings,
    paymentDesk,
    support,
    operatorThreads,
    operatorPageMessages,
    permissionReports,
    rotation,
    erasure,
    recovery,
    retesting,
    academy,
    email,
    sms,
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
    playbooks,
    boards,
    cards,
    selfDirection,
    agentOperatorDelegations,
    professions,
    website,
    webServer,
    wake,
    wishes,
    walks,
    reachability,
    image,
    scene,
    injection,
    vetting,
    authenticator,
    social,
    operatorClaim,
    humans,
    adoption,
    autonomy,
    domain,
    artefact,
    keys,
    solana,
    pow,
    memory,
    vision,
    vault,
    accountThreads,
    accountOffers,
    accounts,
    rhythm,
    skillReleases,
    hints,
    citizens,
    profileTier,
    arrivals,
    mcpStandby,
  } = deps

  // Resolved once at registration, because the gate is a property of the store
  // and the store does not change between requests.
  const mcpThrottles = gateFor(store)

  /**
   * The dependency object both MCP doors hand to the server (`#1916`).
   *
   * **One literal, because there are now two doors into one surface.** The POST
   * door answers a request and the standby door holds a stream, and a server
   * assembled from a different set on one of them would serve a different
   * catalogue there — which is the exact class of drift `routes/mcp.ts` was
   * already carrying a paragraph about, where seven declared tools were absent
   * from the real door because one spread forgot them.
   *
   * `observed` is passed rather than closed over: it carries where this
   * particular call came from, and the two doors resolve it separately.
   */
  const mcpDependencies = (
    request: FastifyRequest,
    observed: ReturnType<typeof observing>,
  ): McpDependencies => ({
    registry,
    store: observed,
    ...(professions === undefined ? {} : { professions }),
    catalogue,
    // The provider catalogue (`#521`), which `app.ts` has already resolved to
    // an empty one when nothing was wired.
    recipes,
    /**
     * The page a sighted walk's `about` is answered against (`#1614`).
     * Absent in a deployment that wired no reader, and then the check
     * simply does not run.
     */
    ...(walkPage === undefined ? {} : { walkPage }),
    /**
     * What a provider name means, for the tools keyed by one (`#772`).
     * Resolved in `app.ts` like the catalogue beside it.
     */
    renames,
    submissions,
    guidance,
    quests,
    earnings,
    // Absent in a deployment with no wallet, and then the one sponsor tool
    // about arrivals is simply not registered (`#760`).
    ...(paymentDesk === undefined ? {} : { paymentDesk }),
    /**
     * Where a finished tool call is counted (`#835`), absent in a
     * deployment that wired no rollup — and then nothing is counted, which
     * changes no answer this door gives.
     */
    ...(rollup === undefined ? {} : { rollup }),
    /**
     * And who says whether a live limit covers the tool (`#843`).
     *
     * **Read off the store rather than taken as a dependency of its own.**
     * `buildApp` wraps the store with the gate once, which is what covers
     * the HTTP door; this door holds that same store, so asking it for the
     * gate is what guarantees the two doors enforce the same rows. A second
     * field on `RouteDependencies` would be a second chance to wire one
     * door and not the other, which is the failure a citizen would
     * experience as a limit it can route around.
     */
    ...(mcpThrottles === undefined ? {} : { throttles: mcpThrottles }),
    // The doctor surface (`#837`), absent where no rollup was wired.
    ...(doctor === undefined ? {} : { doctor }),
    // And the half that records a telling (`#842`), so the wake-up over
    // this door does not announce the same finding on every waking.
    ...(tell === undefined ? {} : { tell }),
    // And the same half one channel along (`#1034`), so the walk this door
    // suggests is not the walk it suggested last time.
    ...(suggested === undefined ? {} : { suggested }),
    /**
     * The public record and its brake (`#957`), forwarded as one pair.
     *
     * They travel together because they are one rule: the record is only
     * uncredentialled on the terms `profile-tier.ts` sets, and a door that
     * carried the first without the second would be the allowance that
     * limiter exists to prevent — a fourth budget for the same work.
     */
    citizens,
    profileTier,
    arrivals,
    support,
    operatorThreads,
    operatorPageMessages,
    permissionReports,
    rotation,
    erasure,
    recovery,
    retesting,
    academy,
    email,
    sms,
    github,
    contributions,
    contributionQuality,
    wakeup,
    ...(prospects === undefined ? {} : { prospects }),
    ...(skillNotes === undefined ? {} : { skillNotes }),
    ...(citizenSearch === undefined ? {} : { citizenSearch }),
    ...(following === undefined ? {} : { following }),
    /**
     * Connections (`#1293`) and private messaging (`#1286`), which this
     * door was not forwarding.
     *
     * **The defect `registers every tool it declares` exists to catch, a
     * second time.** Both ports are optional, both are wired in
     * `server.ts`, and neither reached `createMcpServer` — so seven tools
     * were declared in `AUTHENTICATED_TOOLS`, served by every test that
     * builds its own dependencies, and absent from the real HTTP door.
     * Noticed while wiring `#1288`, whose `kind` filter would have been
     * unreachable for the same reason.
     */
    ...(connections === undefined ? {} : { connections }),
    ...(messaging === undefined ? {} : { messaging }),
    // The catalogue of pipelines (`#1174`). Absent registers no playbook
    // tool at all, which is how eight of them went missing from a
    // production door that reported the revision that built them.
    ...(playbooks === undefined ? {} : { playbooks }),
    // The Workplace ports (`#1761`). Absent registers no
    // `kolonie.workplace` at all — the same class of omission `#1174`
    // caught for playbooks.
    ...(boards === undefined ? {} : { boards }),
    ...(cards === undefined ? {} : { cards }),
    ...(selfDirection === undefined ? {} : { selfDirection }),
    ...(agentOperatorDelegations === undefined ? {} : { agentOperatorDelegations }),
    website,
    webServer,
    wake,
    wishes,
    walks,
    reachability,
    image,
    scene,
    injection,
    vetting,
    authenticator,
    social,
    operatorClaim,
    humans,
    autonomy,
    domain,
    artefact,
    keys,
    solana,
    pow,
    memory,
    // Resolved here rather than inside the tool, so the MCP door and the
    // HTTP door agree on who is calling by construction. `McpDependencies`
    // requires it, which makes forgetting it a compile error rather than a
    // front door that silently stopped counting.
    vision,
    vault,
    /**
     * The sealed operator channel (`#410`, `#592`), which this literal did
     * not forward until `#614`.
     *
     * **An omission here is indistinguishable from a Colony that was never
     * given a sealing key**, and that is what made it survive: every tool
     * reads `deps.drops === undefined` and says so politely instead of
     * failing, so the production MCP surface answered `secretHandoff:
     * false` and refused every `kolonie.operator.drop.open` while
     * `OPERATOR_DROP_SEALING_KEY` was set and the HTTP door beside it was
     * carrying secrets normally. The two doors have to be given the same
     * things or they are not the same Colony.
     */
    accountThreads,
    // Unconditional, because the field is (`#1125`). A spread here would
    // be exactly the omission the paragraph above is a monument to.
    accountOffers,
    accounts,
    rhythm,
    skillReleases,
    // The MCP surface's own narrow log shape, answered by the process
    // logger rather than by `console.error` (`#230`). `detail` is what a
    // handler threw, and it is serialised rather than inspected, so one
    // unanticipated fault stays one line.
    log: (message, detail) => log.error(message, detail, { event: 'mcp.tool.threw' }),
    caller: { ip: clientIp(request.headers, request.ip) },
    // `#459`. Absent in a deployment with no console, and then the tool
    // is simply not registered — D-013's way of switching a surface off.
    ...(adoption === undefined ? {} : { adoption }),
    hints,
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
      /**
       * Where this call came from, resolved once for the whole request (`#191`).
       *
       * The store every tool underneath is handed is this one, so the fifty
       * `authenticate(credential, deps.store)` call sites record an observation
       * without any of them being edited — and none of them can forget to. It
       * mirrors `caller` below, which was made a required dependency for the
       * same reason: a door that silently stopped counting is the failure worth
       * designing against.
       */
      const observed = observing(store, observedOrigin(request.headers, request.ip))

      /**
       * A header carrying only `${KOLONIE_API_KEY}` counts as no header
       * (`kolonie-docs#341`). The packaging ships the reference; an agent that
       * has not registered yet has nothing to substitute into it, and that is
       * the state every arriving agent is in. See `unsubstituted`.
       */
      const presented = unsubstituted(request.headers.authorization)
        ? undefined
        : request.headers.authorization
      /**
       * Who is calling, kept from the check that was happening anyway (`#231`).
       *
       * The citizen was resolved here and discarded before hints existed. Held
       * now, because a sentence about a citizen's own standing needs to know
       * whose standing it is — and resolving the same key a second time deeper
       * down would be a credential lookup per call bought for nothing.
       */
      let agentId: AgentId | undefined
      /**
       * And whether that caller is a warden (`#320`), kept from the same check.
       *
       * The roles arrive on the identity this lookup already returns, so the
       * third tier costs nothing here. It is read fresh on every request, like
       * every other permission in the Colony — a revocation takes effect on the
       * next call rather than when some cached claim expires.
       */
      let warden = false
      if (presented !== undefined) {
        const authenticated = await authenticate(presented, observed)
        if (authenticated.outcome === 'rejected') {
          return reply
            .status(ERROR_STATUS[authenticated.error.code])
            .header('www-authenticate', BEARER_SCHEME)
            .send(authenticated.error)
        }
        agentId = authenticated.agent.id
        warden = authenticated.agent.roles.includes('warden')
      }

      // Fastify has already parsed the body and would otherwise send its own
      // response. `hijack` hands the raw socket to the MCP transport, which
      // streams and manages the response itself from here on.
      reply.hijack()
      await handleMcpRequest(
        mcpDependencies(request, observed),
        presented,
        agentId,
        warden,
        request.raw,
        reply.raw,
        request.body,
        mcpStandby !== undefined,
      )
    })

    /**
     * The standby stream (`#1916`), on the same two paths and behind the same
     * credential resolution.
     *
     * **An `onRequest` hook rather than `app.get`.** The console already
     * declares `GET /`, and a second declaration of the same method and path is
     * a startup error rather than a fallback — so a route here would make the
     * two surfaces unable to share an assembly. A hook runs before routing,
     * takes only the requests it recognises, and leaves every other `GET /`
     * going exactly where it went before.
     *
     * **Registered only where a deployment wired somewhere to hold one.** With
     * no registry there is no hook, `GET` reaches the not-found handler, and
     * `mcpProbe` answers it with the `405` it always did — so a deployment that
     * wants the old behaviour gets it by wiring nothing.
     *
     * **`Accept: text/event-stream` decides, not the path.** A probe running
     * `curl -I` or a browser opening the address is not asking for a stream, and
     * handing it one would replace a helpful `405` with a connection that never
     * finishes. Anything that does not accept the stream is passed on untouched.
     *
     * **The credential is resolved here for the reason the POST door resolves
     * it**: it decides which tools the server behind this stream would serve,
     * and a revoked key must be refused at the door rather than left holding an
     * open stream at a tier it no longer has.
     */
    if (mcpStandby !== undefined && path === MCP_PATHS[0]) {
      app.addHook('onRequest', async (request, reply) => {
        if (request.method !== 'GET') return
        if (!(request.headers.accept ?? '').includes('text/event-stream')) return

        const asked = request.url.split('?')[0]?.replace(/(.)\/+$/, '$1') ?? ''
        if (!MCP_PATHS.includes(asked as (typeof MCP_PATHS)[number])) return

        const observed = observing(store, observedOrigin(request.headers, request.ip))
        const presented = unsubstituted(request.headers.authorization)
          ? undefined
          : request.headers.authorization

        let agentId: AgentId | undefined
        let warden = false
        if (presented !== undefined) {
          const authenticated = await authenticate(presented, observed)
          if (authenticated.outcome === 'rejected') {
            return reply
              .status(ERROR_STATUS[authenticated.error.code])
              .header('www-authenticate', BEARER_SCHEME)
              .send(authenticated.error)
          }
          agentId = authenticated.agent.id
          warden = authenticated.agent.roles.includes('warden')
        }

        reply.hijack()
        await mcpStandby.open(
          mcpDependencies(request, observed),
          presented,
          agentId,
          warden,
          request.raw,
          reply.raw,
        )
      })
    }
  }
}
