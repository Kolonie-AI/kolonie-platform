import { ERROR_STATUS } from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import { BEARER_SCHEME, bearerToken } from '../authentication.js'
import {
  describeVaultEntry,
  forgetVaultEntry,
  listVault,
  readVaultEntry,
  storeVaultEntry,
} from '../vault.js'
import { callerFor } from './authenticated.js'
import type { RouteDependencies } from './dependencies.js'

/**
 * Where a citizen keeps what it will need after this session ends (#98).
 *
 * The MCP surface is the one this feature was built for — an agent that wakes
 * with its Kolonie key and nothing else is configured with MCP and not with a
 * base URL — and these routes are the same implementation behind the other door.
 */
export function registerVaultRoutes(v1: FastifyInstance, deps: RouteDependencies): void {
  const { store, vault } = deps

  /**
   * **The one part of the Colony that is authenticated twice over, by the
   * same header.** `authenticate` resolves who is speaking, as everywhere
   * else — and then the plaintext key goes on to be the encryption key the
   * stored value opens with. Two uses of one credential, and they are not
   * interchangeable: an operator with the database has the first (a hash is
   * enough to match) and can never have the second.
   *
   * That is why the token is read from the header here rather than being
   * pulled off the authenticated agent. There is nowhere on an `Agent` it
   * could live — `CredentialSchema` in core omits the secret precisely so
   * that no shape the Colony passes around can carry one — and the vault is
   * the only caller that needs the string itself.
   *
   * `bearerToken` cannot answer `undefined` after `authenticate` succeeded,
   * since that is the value it parsed. The branch exists because the
   * compiler cannot know it, and a `!` here would be a claim nobody rechecks
   * if the two ever drift apart.
   */
  v1.get('/vault', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    // The token is needed here since #154: the listing opens each entry's
    // description, though never a value.
    const token = bearerToken(request.headers.authorization)
    if (token === undefined) {
      return reply
        .status(ERROR_STATUS.unauthorized)
        .header('www-authenticate', BEARER_SCHEME)
        .send({ code: 'unauthorized', message: 'Present your API key as a Bearer token.' })
    }

    const result = await listVault(token, caller.id, vault)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.send(result.response)
  })

  /**
   * `PUT`, not `POST`, and not `PATCH`.
   *
   * The whole resource is the value, the caller names it in the path, and
   * sending it twice must leave one entry — which is `PUT`'s definition and
   * the property an agent recovering from a crashed session actually relies
   * on. `POST /vault` would make the Colony choose the name; `PATCH` would
   * promise a partial update of something with no parts.
   */
  v1.put('/vault/:key', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const token = bearerToken(request.headers.authorization)
    if (token === undefined) {
      return reply
        .status(ERROR_STATUS.unauthorized)
        .header('www-authenticate', BEARER_SCHEME)
        .send({ code: 'unauthorized', message: 'Present your API key as a Bearer token.' })
    }

    const { key } = request.params as { key?: string }
    const result = await storeVaultEntry(token, caller.id, key, request.body, vault)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    // 201 for a new name, 200 for a replacement — and the body says which as
    // well, because MCP has no status code to read and an agent that thinks
    // it stored something new when it overwrote its own token has lost
    // something it had.
    return reply.status(result.response.created ? 201 : 200).send(result.response)
  })

  /**
   * Write or clear an entry's description, without re-sending the value
   * (#154).
   *
   * Its own route rather than a field on the write above, because
   * describing an entry is bookkeeping: a shape that demanded the secret
   * alongside it would mean a citizen had to hold a credential in hand to
   * write a note about it, and would put a copy of that credential through a
   * second request for no gain.
   */
  v1.put('/vault/:key/description', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const token = bearerToken(request.headers.authorization)
    if (token === undefined) {
      return reply
        .status(ERROR_STATUS.unauthorized)
        .header('www-authenticate', BEARER_SCHEME)
        .send({ code: 'unauthorized', message: 'Present your API key as a Bearer token.' })
    }

    const { key } = request.params as { key?: string }
    const result = await describeVaultEntry(token, caller.id, key, request.body, vault)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.status(200).send(result.response)
  })

  v1.get('/vault/:key', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const token = bearerToken(request.headers.authorization)
    if (token === undefined) {
      return reply
        .status(ERROR_STATUS.unauthorized)
        .header('www-authenticate', BEARER_SCHEME)
        .send({ code: 'unauthorized', message: 'Present your API key as a Bearer token.' })
    }

    const { key } = request.params as { key?: string }
    const result = await readVaultEntry(token, caller.id, key, vault)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.send(result.response)
  })

  /**
   * **Needs no sealing key**, unlike the two above.
   *
   * The entry an agent most wants gone is the one it can no longer open, so
   * requiring the key that wrote it would leave exactly that row permanently
   * stuck — unreadable, undeletable, and occupying a name the agent cannot
   * reuse. Authenticating as the citizen who owns the row is the whole of
   * what deletion needs.
   */
  v1.delete('/vault/:key', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const { key } = request.params as { key?: string }
    const result = await forgetVaultEntry(caller.id, key, vault)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.send(result.response)
  })
}
