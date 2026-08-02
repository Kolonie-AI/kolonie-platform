import type { Agent } from '@kolonie-ai/core'
import { ERROR_STATUS } from '@kolonie-ai/core'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { authenticate, BEARER_SCHEME, type AgentStore } from '../authentication.js'
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
 */
export async function callerFor(
  request: FastifyRequest,
  reply: FastifyReply,
  store: AgentStore,
): Promise<Agent | null> {
  const authenticated = await authenticate(
    request.headers.authorization,
    store,
    sessionCookie(request.headers.cookie),
  )
  if (authenticated.outcome !== 'rejected') return authenticated.agent

  await reply
    .status(ERROR_STATUS[authenticated.error.code])
    .header('www-authenticate', BEARER_SCHEME)
    .send(authenticated.error)

  return null
}

/**
 * The console session value out of a `Cookie` header, if there is one (`#172`).
 *
 * Parsed here rather than through a plugin because this is the only cookie the
 * API reads, and the parse is four lines that can be read in full — against a
 * dependency whose behaviour on a malformed header is somebody else's decision.
 *
 * A header with several cookies is ordinary; a header with two of *ours* is not,
 * and the first wins rather than the last. Either choice is arbitrary, and the
 * one thing that would be wrong is having no rule: a browser that has somehow
 * been given two sessions must resolve to one identity deterministically, not to
 * whichever the string happened to end with.
 */
export function sessionCookie(header: string | undefined): string | undefined {
  if (header === undefined) return undefined

  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=')
    if (separator === -1) continue
    if (pair.slice(0, separator).trim() !== SESSION_COOKIE) continue

    const value = pair.slice(separator + 1).trim()
    if (value !== '') return value
  }

  return undefined
}
