import { ERROR_STATUS, SessionDeclarationSchema } from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import { BEARER_SCHEME, me, observing } from '../authentication.js'
import { observedOrigin } from '../observed-origin.js'
import { sessionCookie } from './authenticated.js'
import type { RouteDependencies } from './dependencies.js'

/**
 * Where a citizen stands, over HTTP.
 *
 * The MCP counterpart is `kolonie.me`, and both read one implementation. What
 * differs is only how the session declaration arrives: query parameters here,
 * because a GET has no body.
 */
export function registerMeRoute(v1: FastifyInstance, deps: RouteDependencies): void {
  const { store } = deps

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
      // The same wrapping `callerFor` does, because this route resolves its own
      // caller rather than going through it (`#191`).
      observing(store, observedOrigin(request.headers, request.ip)),
      query.success ? query.data : {},
      // A sponsor reading the console asks the same question an agent does, and
      // gets it answered by the same route (`#172`). The cookie is read only
      // when no key was presented — see `authenticate`.
      sessionCookie(request.headers.cookie),
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
}

/**
 * The session declaration carried in a query string, if any (#158).
 *
 * Query values arrive as strings, so the token count is converted here rather
 * than by the schema — a schema that coerced would also accept `"12abc"` as
 * twelve, and this is a field where a silently wrong number is worse than an
 * absent one. Anything unconvertible is dropped and the parse at the call site
 * sees an absent field, which is the honest reading of *"the citizen did not
 * tell us"*.
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

  const runtimeTools = toolNamesFromQuery(record['runtimeTools'])
  if (runtimeTools !== undefined) declaration['runtimeTools'] = runtimeTools

  return declaration
}

/**
 * The tool list carried in a query string (`#192`).
 *
 * **Two spellings, because a query string has two honest ways to say "several"**
 * — `?runtimeTools=bash&runtimeTools=read` and `?runtimeTools=bash,read` — and a
 * caller that picked the other one has not made a mistake worth punishing. Both
 * arrive here; anything else is dropped and read as *the citizen did not tell
 * us*, which is the same treatment the token count gets and for the same reason:
 * this route's job is to say where a citizen stands, and a malformed optional
 * field is not a reason to withhold that.
 *
 * **Empty is undefined, not `[]`.** `?runtimeTools=` is a caller sending a
 * parameter it had no value for, not a citizen declaring that its run used no
 * tools. The empty array is a real answer and it is reachable — over MCP, where
 * a client sends an actual array and means it. Inferring it from an empty string
 * here would put words in the citizen's mouth on the surface least able to be
 * precise.
 */
function toolNamesFromQuery(value: unknown): readonly string[] | undefined {
  const raw =
    typeof value === 'string'
      ? value.split(',')
      : Array.isArray(value) && value.every((entry) => typeof entry === 'string')
        ? value.flatMap((entry) => entry.split(','))
        : undefined
  if (raw === undefined) return undefined

  const names = raw.map((entry) => entry.trim()).filter((entry) => entry !== '')
  return names.length === 0 ? undefined : names
}
