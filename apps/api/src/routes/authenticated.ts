import type { Agent, ApiError } from '@kolonie-ai/core'
import { ERROR_STATUS } from '@kolonie-ai/core'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { authenticate, BEARER_SCHEME, observing, type AgentStore } from '../authentication.js'
import { observedOrigin } from '../observed-origin.js'
import { attributeTo, routeKeyOf } from '../call-rollup.js'
import { gateFor } from '../throttle-gate.js'
import { SESSION_COOKIE } from './console.js'

/**
 * Whoever holds the key, or `null` with the refusal already sent.
 *
 * **One definition of what a refused credential looks like, where there were 46
 * identical copies.** Every authenticated route in this API opened with the same
 * seven lines — resolve the header, and on rejection answer
 * `ERROR_STATUS[error.code]` with a `WWW-Authenticate` header and the error as
 * the body. Forty-six copies of a rule is forty-six chances for the
 * forty-seventh to be written differently, and RFC 7235 requires that header on
 * every 401: a route that forgot it would be wrong in a way no test of that
 * route's own behaviour would notice.
 *
 * The scheme in the header is not a hint about what went wrong. Every failure
 * sends the same header and the same body, so a caller cannot learn from a
 * refusal whether the key was absent, malformed or revoked.
 *
 * **It sends the reply itself, and that is why it returns `null` rather than a
 * result to inspect.** A caller that gets `null` has nothing left to decide: the
 * response is written, and the only correct next statement is `return reply`. A
 * union the caller had to unwrap would put the refusal back in 46 places, which
 * is the thing this removes.
 *
 * **And it is the HTTP half of the Doctor's throttle** (`#843`). A citizen with
 * a live limit on the route it is calling is refused here, for the reason the
 * origin observation and the rollup attribution are attached here: this is the
 * one seam every authenticated route passes through, so the eighty-fourth is
 * covered without its author doing anything. Nothing is checked where no gate
 * was wired, and nothing is checked before the credential resolves — a refusal
 * needs a citizen, and a stranger is answered by the paragraph above.
 */
export async function callerFor(
  request: FastifyRequest,
  reply: FastifyReply,
  store: AgentStore,
): Promise<Agent | null> {
  const authenticated = await authenticate(
    request.headers.authorization,
    // Where this call came from, attached here because this is the HTTP door
    // (`#191`). Every authenticated route in the API resolves its caller through
    // this function, so wrapping the store once here is what makes the
    // observation impossible to forget in the forty-seventh route.
    observing(store, observedOrigin(request.headers, request.ip), (agentId) =>
      // And whose request this is, for the hourly rollup written when the
      // response finishes (`#835`). Here for the reason the origin is: every
      // authenticated route resolves its caller through this function, so one
      // wrapping covers the forty-seventh route as well.
      attributeTo(request, agentId),
    ),
    sessionCookie(request.headers.cookie),
  )
  if (authenticated.outcome !== 'rejected') {
    const refusal = await throttleRefusalFor(request, store, authenticated.agent.id)
    if (refusal === undefined) return authenticated.agent

    /**
     * **`Retry-After` as well as the field**, because this is HTTP and the
     * header is what a client library acts on without being taught anything.
     * The same number is in `details.retryAfterSeconds` for the agent reading
     * the body, which is the rule `ApiErrorSchema` states: `details` is
     * additional to the message and never the only place a fact appears.
     */
    const retryAfter = refusal.details?.['retryAfterSeconds']
    await reply
      .status(ERROR_STATUS[refusal.code])
      .header('retry-after', retryAfter ?? '60')
      .send(refusal)

    return null
  }

  await reply
    .status(ERROR_STATUS[authenticated.error.code])
    .header('www-authenticate', BEARER_SCHEME)
    .send(authenticated.error)

  return null
}

/**
 * Whether a live limit covers the route this request matched (`#843`).
 *
 * **`routeKeyOf` and never `request.url`**, so what is matched against the
 * throttle is the same string the rollup counted and the finding named. A limit
 * written from evidence about `/v1/tasks/:taskId` and enforced against
 * `/v1/tasks/8f2…` would never fire, and would look from the outside exactly
 * like a limit that had expired.
 *
 * **It cannot refuse a citizen because the database is unwell.** A gate that
 * rejects is treated as one that allowed: the alternative is a Colony that
 * starts limiting everybody the moment a read goes slow, which is a worse
 * failure than a limit that missed a few calls.
 */
async function throttleRefusalFor(
  request: FastifyRequest,
  store: AgentStore,
  agentId: Agent['id'],
): Promise<ApiError | undefined> {
  const gate = gateFor(store)
  if (gate === undefined) return undefined

  try {
    return await gate.refusalFor(agentId, routeKeyOf(request), new Date())
  } catch {
    return undefined
  }
}

/**
 * One cookie out of a `Cookie` header, if there is one (`#172`).
 *
 * Parsed here rather than through a plugin because the API reads two cookies and
 * the parse is six lines that can be read in full — against a dependency whose
 * behaviour on a malformed header is somebody else's decision.
 *
 * A header with several cookies is ordinary; a header with two of *ours* is not,
 * and the first wins rather than the last. Either choice is arbitrary, and the
 * one thing that would be wrong is having no rule: a browser that has somehow
 * been given two sessions must resolve to one identity deterministically, not to
 * whichever the string happened to end with.
 */
export function cookieValue(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined

  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=')
    if (separator === -1) continue
    if (pair.slice(0, separator).trim() !== name) continue

    const value = pair.slice(separator + 1).trim()
    if (value !== '') return value
  }

  return undefined
}

/**
 * The session value, whoever it belongs to.
 *
 * **One cookie name for both subjects** (`#425`): a person's session and a
 * citizen's console session travel under `__Host-kolonie_session`, are hashed
 * the same way and expire on the same rules. Which of the two a value resolves
 * to is decided by which table holds it, and never by the browser.
 */
export function sessionCookie(header: string | undefined): string | undefined {
  return cookieValue(header, SESSION_COOKIE)
}
