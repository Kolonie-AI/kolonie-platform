import type { FastifyInstance } from 'fastify'
import { API_VERSION } from '@kolonie-ai/core'
import { buildOpenApiDocument, type RegisteredRoute } from '../openapi/document.js'

/**
 * `GET /openapi.json` — the description of the fallback door (`#442`).
 *
 * On the app rather than under `/v1/`, and that is deliberate: a document
 * describing every version of the API cannot live inside one of them. It is
 * where a runtime looks — `https://api.kolonie.ai/openapi.json` — and it needs
 * no credential, because a description a caller must authenticate to read
 * cannot be what tells it how to authenticate.
 *
 * Built on the first request and kept, not written to disk: the route table it
 * reads is fixed once the server has finished starting, so building it twice
 * would produce the same bytes.
 */
export function registerOpenApiRoute(
  app: FastifyInstance,
  routes: readonly RegisteredRoute[],
): void {
  let document: Record<string, unknown> | undefined

  app.get('/openapi.json', async (_request, reply) => {
    document ??= buildOpenApiDocument(routes, { version: `${API_VERSION.slice(1)}.0.0` })

    return (
      reply
        .header('content-type', 'application/json; charset=utf-8')
        // The same answer for every caller, and no credential is ever sent with
        // the request — the reasons `/v1/academy/graph` already gives for this
        // header apply unchanged.
        .header('access-control-allow-origin', '*')
        .send(document)
    )
  })
}
