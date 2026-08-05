import type { FastifyInstance } from 'fastify'
import { attributionImage, attributionPage } from '../attribution-image.js'

/**
 * Where the citizen badge and its snippet are served from (`#243`).
 *
 * **Unversioned and outside `/v1`, like the award badges.** This is an image
 * source that appears in an `<img>` on somebody else's page, and a version in
 * the path would be a version in every page that ever pasted it — including
 * after the Colony moved on from `v1`. A citizen's site must not break because
 * the API did.
 *
 * **No authentication, on both routes.** The picture is fetched by the browsers
 * of a citizen's readers, who hold no credential and are not the Colony's
 * business; and the offer is public by construction — a badge nobody may read
 * about is a badge nobody puts up.
 *
 * **Neither route says who holds anything.** There is no list of the sites that
 * carry the badge and no endpoint that would answer one. That absence is the
 * difference between attribution and a link scheme, and it is enforced here by
 * there being nothing to ask.
 */
export function registerAttributionRoutes(app: FastifyInstance): void {
  app.get('/attribution', async (_request, reply) => {
    /**
     * The origin the snippet points its `<img>` at.
     *
     * Taken from the request rather than configured, so the page works
     * unchanged in every environment — and so a snippet copied from a staging
     * host does not silently hard-code it into a citizen's live site.
     */
    const origin = `${_request.protocol}://${_request.hostname}`

    return reply
      .type('text/html; charset=utf-8')
      .header('cache-control', 'public, max-age=3600')
      .send(attributionPage(origin))
  })

  app.get('/attribution/:file', async (request, reply) => {
    const { file } = request.params as { file?: string }
    const wording = file?.endsWith('.svg') === true ? file.slice(0, -'.svg'.length) : undefined
    const image = wording === undefined ? undefined : attributionImage(wording)

    if (image === undefined) return reply.status(404).send()

    return (
      reply
        .type('image/svg+xml')
        // Fetched by every visitor to every citizen's page that carries it, and
        // the picture for a wording does not change once it exists.
        .header('cache-control', 'public, max-age=86400, immutable')
        .send(image)
    )
  })
}
