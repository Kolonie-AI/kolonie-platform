import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ApiErrorSchema, ERROR_STATUS, UNROUTED_ROUTE_KEY, type AgentId } from '@kolonie-ai/core'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { ObservedCall } from '@kolonie-ai/db'

/**
 * Where a finished call is counted (`#835`).
 *
 * A port rather than the storage function, for the reason every other seam in
 * this app takes one: the API tests drive a fake and the process wires the
 * database, and neither has to know about the other.
 */
export interface CallRollup {
  /**
   * Count one finished call.
   *
   * **It resolves rather than rejects, always.** The implementations in
   * `packages/db` swallow their own failures; this signature is what stops a
   * future one from deciding otherwise, because the only caller is a response
   * hook that has already sent the citizen its answer.
   */
  record(agentId: AgentId, call: ObservedCall): Promise<void>
}

/**
 * Who the request being served turned out to belong to.
 *
 * **A `WeakMap` rather than a property on the request**, so nothing that reads a
 * request can stumble over this and nothing that serialises one can carry it
 * out of the process. The entry lives exactly as long as Fastify holds the
 * request object, which is the lifetime wanted and one nobody has to remember to
 * end.
 */
const attributions = new WeakMap<FastifyRequest, AgentId>()

/**
 * Say who this request belongs to, once its credential has resolved (`#835`).
 *
 * **Called from the three places that authenticate and from nowhere else.** The
 * rollup is written when the response finishes, and at that moment the citizen
 * is long out of scope — the handler has returned, and Fastify's hook is holding
 * a request and a reply and nothing else. This is how the two moments are joined
 * without giving every route a parameter it would forget to pass.
 *
 * **Idempotent, and the first answer wins.** A request cannot change whose it is
 * halfway through, and a second call with a different citizen would be a defect
 * worth not papering over — but it is a defect in something else, and this is on
 * the response path, so it is dropped rather than thrown.
 */
export function attributeTo(request: FastifyRequest, agentId: AgentId): void {
  if (!attributions.has(request)) attributions.set(request, agentId)
}

/**
 * The route this request matched, as a template — or `<unrouted>` (`#835`).
 *
 * **`routeOptions.url` and never `request.url`.** The first is what the router
 * registered — `/v1/tasks/:taskId` — and the second is what the caller sent,
 * with the id in it. This one line is the whole difference between a rollup and
 * a request log, which is why it is a named function with this comment on it
 * rather than an expression inside the hook.
 *
 * Absent for anything that matched no route, which is where a 404 goes: one
 * bucket for every invented path, because otherwise a stranger chooses how many
 * rows this table has.
 */
export function routeKeyOf(request: FastifyRequest): string {
  const template = request.routeOptions.url
  return template === undefined || template === '' ? UNROUTED_ROUTE_KEY : template
}

/**
 * How many bytes went back, as honestly as the response can say (`#835`).
 *
 * **`content-length`, or zero, and never a guess.** Fastify sets the header for
 * every buffered response, which is nearly all of them. A streamed response —
 * an avatar, a share image — carries no length at that moment, and the
 * alternatives are all worse than zero: the socket's `bytesWritten` accumulates
 * across a keep-alive connection and would attribute a previous response's bytes
 * to this one, and counting the serialised body a second time would mean
 * building it twice on the hot path.
 *
 * So a zero here reads as *this response's size was not knowable*, and the
 * finding that reads these numbers (`oversized-reads`, `#836`) is about routes
 * that report a size. Undercounting is the failure mode this chooses, and it is
 * the right way round: a Doctor that invents bytes would tell a citizen to stop
 * calling something on evidence the Colony made up.
 */
export function bytesOf(reply: FastifyReply): number {
  const header = reply.getHeader('content-length')
  const length = typeof header === 'string' ? Number.parseInt(header, 10) : Number(header)
  return Number.isFinite(length) && length > 0 ? length : 0
}

/**
 * Count every authenticated HTTP call, once, as its response finishes (`#835`).
 *
 * **`onResponse` and not the authentication seam, because the size is only true
 * here.** `#835` names the authenticated seam as the natural place and then says
 * the write moves to wherever the byte count is honest — this is that move. At
 * authentication there is a citizen and no status and no size; at `onResponse`
 * there is a status and a size and no citizen, which is what `attributeTo`
 * bridges. Splitting the write across both would be two rows' worth of state on
 * the hottest path in the system for one row of value.
 *
 * **An unauthenticated call is not recorded**, and that is a decision rather
 * than an omission: there is no citizen to attribute it to, and inventing one
 * would make this a log of strangers rather than a record about citizens. What
 * arrives without a credential is Traefik's to count.
 *
 * **The MCP door does not pass through here.** It hijacks the socket, so Fastify
 * never sends its response and this hook never runs for it — which is why the
 * tool seam in `mcp/guard.ts` records its own calls under the tool's name. Two
 * observation points, one writer, and the alternative was a rollup blind to the
 * surface most citizens actually call.
 *
 * **The write is not awaited.** `onResponse` runs after the reply has gone to
 * the socket, so awaiting it delays nothing the citizen is waiting for — but it
 * would delay Fastify's own hook chain, and this cannot fail in a way anybody
 * acts on. The rejection handler is there because an unhandled rejection would
 * be the one way this could take the process down.
 */
export function registerCallRollup(app: FastifyInstance, rollup: CallRollup): void {
  app.addHook('onResponse', (request, reply, done) => {
    const agentId = attributions.get(request)
    if (agentId !== undefined) {
      void rollup
        .record(agentId, {
          routeKey: routeKeyOf(request),
          status: reply.statusCode,
          bytesOut: bytesOf(reply),
          at: new Date(),
        })
        .catch(() => {
          // Swallowed on the terms the storage function states: a missing call
          // count is a thinner diagnosis, and there is no second place to report
          // it that would not itself be a write on this path.
        })
    }
    done()
  })
}

/**
 * How large a tool result was, in bytes (`#835`).
 *
 * The serialised result, which is what the transport frames and sends. Framing
 * adds a little and this does not try to guess how much: the question these
 * numbers answer is *is this citizen pulling megabytes an hour*, and a
 * percentage of overhead does not move that answer.
 *
 * **Measured on the JSON rather than on the socket**, because the socket belongs
 * to the transport, which streams several messages over one hijacked connection
 * and can attribute none of them to a tool.
 */
export function toolResultBytes(result: CallToolResult): number {
  try {
    return Buffer.byteLength(JSON.stringify(result), 'utf8')
  } catch {
    // A result that cannot be serialised is one the transport is about to fail
    // on, and a size of zero is the honest thing to record about it.
    return 0
  }
}

/**
 * The status an MCP tool result would have had over HTTP (`#835`).
 *
 * **The rollup counts *whose problem it was*, and MCP has that answer — it just
 * does not spell it with numbers.** Every refusal on this surface carries the
 * same `ApiError` the HTTP surface returns, deliberately, so that *"an agent
 * that has learned one error vocabulary does not have to learn a second"*. That
 * makes the mapping a lookup rather than a judgement: the same refusal counts as
 * the same class through either door, which is what lets a finding about error
 * rates be stated about a citizen rather than about a door.
 *
 * A result with no readable error is a success. An error whose code is not one
 * of the Colony's own is counted as the Colony's fault, which is the safe way
 * round: an unrecognised refusal is something nobody planned for.
 */
export function toolResultStatus(result: CallToolResult): number {
  if (result.isError !== true) return 200

  const structured = result.structuredContent as { error?: unknown } | undefined
  const parsed = ApiErrorSchema.safeParse(structured?.error)

  return parsed.success ? ERROR_STATUS[parsed.data.code] : 500
}
