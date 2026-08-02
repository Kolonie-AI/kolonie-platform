import type { FastifyInstance } from 'fastify'
import { ACADEMY_GRAPH_MAX_AGE_SECONDS, academyGraph } from '../tasks.js'
import type { RouteDependencies } from './dependencies.js'

/** The Academy as a graph: what can be learned here, without a credential. */
export function registerAcademyGraphRoute(v1: FastifyInstance, deps: RouteDependencies): void {
  const { catalogue } = deps

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
}
