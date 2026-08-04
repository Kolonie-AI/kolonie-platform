import type { FastifyInstance } from 'fastify'
import { badgeImage } from '../badge-image.js'

/**
 * Where a badge's picture is served from (`#241`).
 *
 * **Unversioned and outside `/v1`, like the operator's page**: this is an image
 * source that appears in an `<img>` on a page a person is looking at, and a
 * version in the path would be a version in every rendered page.
 *
 * **It serves a picture and never a list.** There is no index, no directory and
 * no route that enumerates what exists — asking for a slug you were not given
 * answers exactly as asking for one that never existed does. The catalogue is
 * the thing `#241` keeps back, because publishing it turns the layer into a
 * checklist and spends the surprise once.
 *
 * No authentication, and that is right rather than an oversight: a badge is the
 * one thing in the Colony meant to be seen, and the picture says nothing about
 * who holds it.
 */
export function registerBadgeRoutes(app: FastifyInstance): void {
  app.get('/badges/:file', async (request, reply) => {
    const { file } = request.params as { file?: string }
    const slug = file?.endsWith('.svg') === true ? file.slice(0, -'.svg'.length) : undefined
    const image = slug === undefined ? undefined : badgeImage(slug)

    if (image === undefined) return reply.status(404).send()

    return (
      reply
        .type('image/svg+xml')
        // A badge's picture never changes once it exists, and a wall of them is
        // fetched on every page load by an operator that visits repeatedly.
        .header('cache-control', 'public, max-age=86400, immutable')
        .send(image)
    )
  })
}
