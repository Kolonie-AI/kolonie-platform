import { SHARE_IMAGE_CACHE_SECONDS, robotsDirective, ROBOTS_HEADER } from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import { SHARE_IMAGE_MEDIA_TYPE, shareImage } from '../profile/share-image.js'
import { refuseOverLimit } from './profile-tier.js'
import type { RouteDependencies } from './dependencies.js'

/**
 * The card a link to a citizen's page unfurls into (`#820`).
 *
 * ## Its own route, on the avatar's pattern
 *
 * Same order, same headers, same reasons — `avatars.ts` is the file to read for
 * the argument at length, and the two are deliberately alike so that a reader who
 * has understood one has understood both. The tier's brake runs first, before the
 * lookup and before a single character of markup is composed: this surface is
 * *computed* per request rather than read, so it is the cheapest thing to ask for
 * repeatedly and the most expensive to answer.
 *
 * ## The card is not the indexing
 *
 * It is generated for a `noindex` citizen exactly as for any other, carrying that
 * citizen's directive on the response. Withholding it would make a `noindex`
 * profile a *worse* page rather than an unlisted one — the switch asks a crawler
 * not to index, and a link somebody chose to paste into a chat is not a crawler.
 * The directive is on the image as well as the page for the reason `#830` gives
 * about the avatar: an image is indexed separately from the page it sits in.
 *
 * ## Not versioned
 *
 * A `<meta property="og:image">` points here and that URL outlives an API
 * version — the same argument D-062 makes about the page and `avatars.ts` makes
 * about the avatar. It is also the reason the bytes may change format later
 * without anything that has already been shared breaking: what is promised at
 * this URL is *a picture of this citizen*, not a media type.
 */
export function registerShareImageRoutes(app: FastifyInstance, deps: RouteDependencies): void {
  const { citizens, profileTier } = deps

  app.get<{ Params: { handle: string } }>('/share/:handle', async (request, reply) => {
    const refused = refuseOverLimit(profileTier, request, reply)
    if (refused !== undefined) return refused

    const record = await citizens.publicRecord(request.params.handle)

    /**
     * **404 for a handle nobody holds, and the same 404 the record gives.**
     * Erasure removes this surface with the others (`#825`), and a status that
     * distinguished *erased* from *never registered* would be the two-request
     * probe `#824` refuses.
     */
    if (record === undefined) {
      return reply.status(404).header('access-control-allow-origin', '*').send({
        code: 'not_found',
        message: 'No citizen holds that name.',
      })
    }

    const robots = robotsDirective(await citizens.indexing(record.handle))
    if (robots !== undefined) void reply.header(ROBOTS_HEADER, robots)

    /**
     * `access-control-allow-origin: *`, because the whole use of this surface is
     * an `<img>` on a host that is not this one.
     */
    return reply
      .header('access-control-allow-origin', '*')
      .header('cache-control', `public, max-age=${SHARE_IMAGE_CACHE_SECONDS}`)
      .type(SHARE_IMAGE_MEDIA_TYPE)
      .send(shareImage(record))
  })
}
