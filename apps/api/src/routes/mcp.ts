import { ERROR_STATUS, type AgentId } from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import { authenticate, BEARER_SCHEME, observing, unsubstituted } from '../authentication.js'
import { clientIp } from '../client-ip.js'
import { observedOrigin } from '../observed-origin.js'
import { handleMcpRequest, MCP_PATHS } from '../mcp.js'
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
    catalogue,
    recipes,
    renames,
    submissions,
    guidance,
    quests,
    earnings,
    paymentDesk,
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
    github,
    contributions,
    wakeup,
    prospects,
    skillNotes,
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
    drops,
    handovers,
    shares,
    shareNotifier,
    dropBaseUrl,
    accounts,
    rhythm,
    skillReleases,
    hints,
  } = deps

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
       * And whether that caller is a steward (`#320`), kept from the same check.
       *
       * The roles arrive on the identity this lookup already returns, so the
       * third tier costs nothing here. It is read fresh on every request, like
       * every other permission in the Colony — a revocation takes effect on the
       * next call rather than when some cached claim expires.
       */
      let steward = false
      if (presented !== undefined) {
        const authenticated = await authenticate(presented, observed)
        if (authenticated.outcome === 'rejected') {
          return reply
            .status(ERROR_STATUS[authenticated.error.code])
            .header('www-authenticate', BEARER_SCHEME)
            .send(authenticated.error)
        }
        agentId = authenticated.agent.id
        steward = authenticated.agent.roles.includes('steward')
      }

      // Fastify has already parsed the body and would otherwise send its own
      // response. `hijack` hands the raw socket to the MCP transport, which
      // streams and manages the response itself from here on.
      reply.hijack()
      await handleMcpRequest(
        {
          registry,
          store: observed,
          catalogue,
          // The provider catalogue (`#521`), which `app.ts` has already resolved to
          // an empty one when nothing was wired.
          recipes,
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
          // The doctor surface (`#837`), absent where no rollup was wired.
          ...(doctor === undefined ? {} : { doctor }),
          // And the half that records a telling (`#842`), so the wake-up over
          // this door does not announce the same finding on every waking.
          ...(tell === undefined ? {} : { tell }),
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
          github,
          contributions,
          wakeup,
          ...(prospects === undefined ? {} : { prospects }),
          ...(skillNotes === undefined ? {} : { skillNotes }),
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
          ...(drops === undefined ? {} : { drops }),
          ...(handovers === undefined ? {} : { handovers }),
          // The third channel (`#737`), absent for the same reason the two
          // sockets are: an app wired with no database has no desk to give.
          ...(shares === undefined ? {} : { shares }),
          /**
           * And the thing that tells the operator about a share (`#774`).
           *
           * Absent where the deployment has no mailer or no console address, and
           * absent is a working state here rather than a missing capability: the
           * offer still stands in the operator's queue for its whole window, and
           * the tool says in a word that nobody was written to. This forwarding
           * is what the test above exists for — a notifier held by the door and
           * not handed on is a Colony that can mail and never does.
           */
          ...(shareNotifier === undefined ? {} : { shareNotifier }),
          dropBaseUrl,
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
        },
        presented,
        agentId,
        steward,
        request.raw,
        reply.raw,
        request.body,
      )
    })
  }
}
