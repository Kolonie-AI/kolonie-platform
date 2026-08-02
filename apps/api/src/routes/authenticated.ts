import type { Agent } from '@kolonie-ai/core'
import { ERROR_STATUS } from '@kolonie-ai/core'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { authenticate, BEARER_SCHEME, type AgentStore } from '../authentication.js'

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
  const authenticated = await authenticate(request.headers.authorization, store)
  if (authenticated.outcome !== 'rejected') return authenticated.agent

  await reply
    .status(ERROR_STATUS[authenticated.error.code])
    .header('www-authenticate', BEARER_SCHEME)
    .send(authenticated.error)

  return null
}
