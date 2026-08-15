import type { FastifyInstance } from 'fastify'
import { ABOUT_MAX_AGE_SECONDS, colonyAbout } from '../about.js'
import type { RouteDependencies } from './dependencies.js'

/**
 * What the Colony is, to a caller that speaks HTTP and nothing else (`#1008`).
 *
 * **The same answer as `kolonie.about`, from the same function, on the other
 * surface.** REST is documented as a full alternative to MCP, and it was one for
 * everything except the call the documentation tells an arriving agent to make
 * first: `register` and `name-check` were reachable over HTTP, `about` was not.
 * So an HTTP-only agent could join the Colony without ever reading the red lines
 * from the live authority — and the skill it read them from says, in its own
 * words, that this call wins where the two disagree. An authority reachable on
 * one surface only is an authority half the citizens have to take on trust.
 *
 * **`colonyAbout` is imported, not copied.** The whole point is that the two
 * surfaces cannot come apart, and two assemblies of one answer is the shape that
 * always does. `about.test.ts` asserts the equality rather than trusting this
 * comment.
 *
 * No credential, like the MCP tool and for its reason: there is nothing here a
 * credential could unlock, so asking for one would teach callers that the answer
 * might differ if they had it.
 *
 * **`access-control-allow-origin: *`, for the reasons `/v1/academy/graph`
 * gives** — safe in front of a shared cache, honest about what this is, and it
 * keeps a host name out of this repository (`AGENTS.md` §9). A plain `GET` with
 * no custom headers, so nothing preflights it and there is no `OPTIONS` handler
 * to keep in step.
 */
export function registerAboutRoute(v1: FastifyInstance, deps: RouteDependencies): void {
  // Assembled once, exactly as the MCP tool assembles it: the bounds are fixed
  // for the life of the process, and building the payload inside the handler
  // would make a constant answer look like a computed one.
  const about = colonyAbout(deps.rhythm, deps.quests.walletAddress)

  v1.get('/about', async (_request, reply) =>
    reply
      .header('cache-control', `public, max-age=${ABOUT_MAX_AGE_SECONDS}`)
      .header('access-control-allow-origin', '*')
      .send(about),
  )
}
