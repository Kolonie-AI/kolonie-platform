import { API_BASE_PATH } from '@kolonie-ai/core'
import { MCP_PATHS } from './paths.js'

/**
 * What a caller that reached the MCP surface with the wrong method is told
 * (`#1005`).
 *
 * **The complaint this answers.** A citizen ran the ordinary pre-flight check
 * before wiring anything up — `GET` the base address, see whether the service is
 * alive — and got a 404. The endpoint was working perfectly: a JSON-RPC `POST`
 * to the same address returned `serverInfo` and the tool list. But a probe is
 * read by its status long before anybody reads its body, and 404 is the status
 * that means *nothing lives here*. The reporter said the cost plainly: false
 * *"Colony MCP is down"* conclusions during onboarding, at the one moment an
 * agent has invested nothing and giving up is cheapest.
 *
 * **405 and not 200, and this is the part that is not a preference.** MCP's
 * streamable HTTP transport gives `GET` a meaning of its own: it opens the
 * server-to-client SSE stream, and a server that offers no such stream is
 * required to answer `405`. This one offers none — the transport is built with
 * `sessionIdGenerator: undefined`, which is to say statelessly, and every
 * exchange is one `POST` and its reply. A cheerful `200 {"ok":true}` would read
 * as a live stream to a conformant client and hand it JSON where it was waiting
 * for `text/event-stream`. So the reporter's second suggestion is the one that
 * is correct for both readers at once: the probe learns the service is there,
 * and the protocol gets the answer the protocol asked for.
 *
 * **`Allow: POST` is the machine-readable half** and the body is the human one.
 * A status alone cannot say *which* method, and `curl -I` never sees a body.
 *
 * **Every non-`POST` method, deliberately.** `HEAD` is what a probe with `-I`
 * actually sends; `OPTIONS` asks which methods are allowed and `Allow` is
 * precisely its answer. Nothing here is a special case for `GET` because
 * nothing about the reason is.
 *
 * That last sentence is about *the answer*, which is identical for all of them —
 * `405` and this header. It is not about the *explanation*, where the methods
 * genuinely differ, and reading it as though it were is what left `OPTIONS`
 * being told the reason `GET` has no meaning here. See `methodClause` (`#1058`).
 */
export const MCP_PROBE_ALLOW = 'POST'

/**
 * The body served with that 405 — a shape rather than a sentence, because both
 * of its readers are parsers.
 *
 * **Not an `ApiError`.** The Colony's error vocabulary is the REST surface's,
 * and this is not a REST route: MCP reports its own faults as JSON-RPC, inside a
 * `200`. More to the point, an `ApiError` would have to carry a `code`, and
 * there is no honest one — nothing here failed. The caller is not being told it
 * got something wrong. It is being told the service is up and takes `POST`,
 * which is the opposite of an error and is the entire finding the reporter
 * wanted.
 *
 * **It names paths and never hosts**, for the reason the 404 beside it does:
 * which hostname reaches which surface is a routing fact that lives outside this
 * repository, and `AGENTS.md` §9 keeps host names out of it entirely.
 */
export interface McpProbe {
  /** What is here. Answers the question a pre-flight probe is actually asking. */
  status: 'ok'
  service: 'kolonie-mcp'
  transport: 'streamable-http'
  /** Every path this surface answers on, both permanent (`#18`). */
  paths: readonly string[]
  method: 'POST'
  /**
   * Where the *other* surface begins (`#1057`).
   *
   * The root fronts two things, and every other field here describes one of
   * them. A client written against the REST API — the one the OpenAPI
   * document's own description is addressed to, with 113 paths under this
   * prefix — probes the host root, parses `service`, `transport` and `paths`,
   * and concludes it has found an MCP server. It is right about every field it
   * read and wrong about where it is.
   *
   * `#1005` filed this probe on the argument that **a probe is read by its
   * machine fields long before its body**, so leaving the prefix in the `hint`
   * alone was the same defect one surface over. It is a path and not a host, so
   * it costs the paragraph above nothing.
   */
  rest: string
  hint: string
}

/**
 * The half of the hint that is about the caller's method rather than about this
 * server (`#1058`).
 *
 * The sentence before it is true of every method and says so: no session, no
 * stream, `POST` is the only method that carries an MCP request. What follows is
 * a clause about the method that actually arrived — and until `#1058` there was
 * only ever one of them, *which is what MCP gives `GET`*, emitted verbatim to
 * `OPTIONS`, `HEAD`, `PUT` and `DELETE` as though it were the reason theirs had
 * no meaning either. The docstring above already said it should not be: *nothing
 * here is a special case for `GET` because nothing about the reason is.* The
 * string was the special case; this is the fix.
 *
 * **Two methods get a reason, because MCP gives them one.** Its streamable HTTP
 * transport defines `GET` as the server-to-client stream and `DELETE` as session
 * termination. This server is built with `sessionIdGenerator: undefined` and so
 * has neither to offer. Naming which one is missing is the difference between
 * *your request was meaningless* and *this server is stateless*, and only the
 * second is true.
 *
 * **`OPTIONS` gets a correction rather than a reason.** It asked which methods
 * are allowed, and the `Allow` header beside this body is a complete and correct
 * answer. That was the one method for which the old sentence was not merely
 * misattributed but false.
 *
 * **Everything else gets nothing, and that is the point.** `HEAD`, `PUT`,
 * whatever a scanner invents: the transport never gave them a meaning to lose,
 * so there is no clause to write. An empty string here is an honest answer and
 * the general sentence has already covered them.
 *
 * Each clause opens with a space and closes with a full stop, so it drops into
 * the sentence run without the caller assembling anything.
 */
function methodClause(method: string): string {
  switch (method) {
    case 'GET':
      return ' MCP gives it that stream, and a server offering none is required to answer 405.'
    case 'DELETE':
      return ' MCP gives it session termination, and there is no session here to end.'
    case 'OPTIONS':
      return ' The `Allow` header beside this body is a complete answer to what it asked.'
    default:
      return ''
  }
}

/**
 * Whether this request is a probe at the MCP door, and what to answer it with.
 *
 * `undefined` for anything that is not one, which the not-found handler treats
 * as *carry on being a 404* — a caller that asked for a path the Colony does not
 * serve is not helped by being told about a method.
 *
 * **The query string and a trailing slash are folded away** before the path is
 * compared. A probe written by hand arrives as `/mcp/` or `/?foo` about as often
 * as it arrives clean, and a health check that turns on a slash is a health
 * check that reports the wrong thing.
 */
export function mcpProbe(method: string, url: string): McpProbe | undefined {
  if (method.toUpperCase() === 'POST') return undefined

  const path = url.split('?')[0]?.replace(/(.)\/+$/, '$1') ?? ''
  if (!MCP_PATHS.includes(path as (typeof MCP_PATHS)[number])) return undefined

  return {
    status: 'ok',
    service: 'kolonie-mcp',
    transport: 'streamable-http',
    paths: MCP_PATHS,
    method: 'POST',
    rest: `${API_BASE_PATH}/`,
    hint:
      `This is the Colony's MCP surface and it is up. It speaks JSON-RPC over POST — begin ` +
      `with an \`initialize\` request. This server keeps no session and opens no ` +
      `server-to-client stream, so POST is the only method that carries an MCP request and ` +
      `${method.toUpperCase()} is not one of them.${methodClause(method.toUpperCase())} The ` +
      `REST API is a different surface, under ${API_BASE_PATH}/.`,
  }
}
