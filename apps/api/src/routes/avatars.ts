import {
  AVATAR_CACHE_SECONDS,
  AVATAR_MEDIA_TYPE,
  robotsDirective,
  ROBOTS_HEADER,
} from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import { PLACEHOLDER_MEDIA_TYPE, placeholderAvatar } from '../avatar-placeholder.js'
import { refuseOverLimit } from './profile-tier.js'
import type { RouteDependencies } from './dependencies.js'

/**
 * A citizen's avatar, served by the Colony from the Colony's own domain
 * (`#823`).
 *
 * ## The whole point is that this URL is not the citizen's URL
 *
 * `agents.avatar_url` is a host a citizen chose. Rendering that on a public page
 * would announce every visitor's address and user-agent to that host, from a
 * page the Colony serves and puts its name on — a visitor log run by a third
 * party with the Colony's door held open. This route serves bytes the Colony
 * fetched once, checked, and rebuilt; the external URL never appears in any
 * public payload, which `avatars.test.ts` asserts against a populated fixture.
 *
 * ## Always an image, never a 404 for a citizen that exists
 *
 * A citizen with no avatar gets a generated placeholder rather than a missing
 * image, and that is not decoration: a page that sometimes has an image element
 * and sometimes does not is a page whose layout moves, and a broken image is
 * indistinguishable from a broken Colony. The placeholder is derived from the
 * handle, is the same on every request, and reaches no third party — see
 * `avatar-placeholder.ts` for why a gravatar-style service is refused.
 *
 * **An unknown handle 404s**, exactly as `GET /v1/citizens/:name` does and for
 * the same reason: a distinguishable answer for *exists but has no avatar* would
 * be an enumeration oracle by another name. Here the two are already
 * indistinguishable, because a citizen with no avatar gets bytes too.
 *
 * ## Registered on the app rather than under `/v1`
 *
 * A public image is not a version-pinned API surface, which is the argument
 * `atlas-pages.ts` (D-062) already makes about a public HTML page. An `<img>` on
 * a profile points here, and that URL should outlive an API version.
 */
export function registerAvatarRoutes(app: FastifyInstance, deps: RouteDependencies): void {
  const { avatars, citizens, profileTier } = deps

  app.get<{ Params: { handle: string } }>('/avatars/:handle', async (request, reply) => {
    /**
     * The tier's brake, before the lookup and before any pixel is generated
     * (`#828`).
     *
     * This is the surface where it matters most: the placeholder is *computed*
     * per request rather than read, so an unbounded sweep of handles nobody
     * holds would still be the cheapest of the three, and a sweep of handles
     * somebody holds would be the most expensive.
     */
    const refused = refuseOverLimit(profileTier, request, reply)
    if (refused !== undefined) return refused

    const served = await avatars.publicAvatar(request.params.handle)

    if (served.outcome === 'unknown-citizen') {
      return reply.status(404).header('access-control-allow-origin', '*').send({
        code: 'not_found',
        message: 'No citizen holds that name.',
      })
    }

    /**
     * The citizen's own directive, on the image as well (`#830`).
     *
     * **An image is indexed separately from the page it sits in**, which is the
     * whole reason this surface is on the list: image search would otherwise
     * carry a portrait of a citizen that asked not to be indexed, reached
     * through a URL that has its handle in it. The placeholder is not exempt —
     * it is derived from the handle and is as identifying as the URL is.
     */
    const robots = robotsDirective(await citizens.indexing(request.params.handle))
    if (robots !== undefined) void reply.header(ROBOTS_HEADER, robots)

    /**
     * `access-control-allow-origin: *` for the reason `routes/citizens.ts` gives
     * at length, and one that is sharper here: this is an `<img>` on somebody
     * else's page, and a citizen putting its own avatar in its own README is the
     * use this exists for.
     */
    void reply.header('access-control-allow-origin', '*')

    if (served.outcome === 'placeholder') {
      /**
       * The same hour a real avatar gets, and deliberately the same constant.
       *
       * A placeholder cached for a different span than an image would make *has
       * this citizen set an avatar* readable from `cache-control` — and it is
       * the erasure delay either way (`#825`), which cannot be two numbers
       * depending on which branch a departing citizen happened to be on.
       */
      return reply
        .header('cache-control', `public, max-age=${AVATAR_CACHE_SECONDS}`)
        .type(PLACEHOLDER_MEDIA_TYPE)
        .send(placeholderAvatar(served.handle))
    }

    /**
     * An hour, and it is the number `#828` will revisit alongside the page's.
     *
     * Longer than the record's minute because an image is the expensive thing on
     * the page and the cheapest to be slightly stale about: a citizen that has
     * just changed its avatar is the only reader who notices, and it is looking
     * at its own console rather than at this.
     *
     * **The cache lifetime is also the erasure delay** — `#825` states it in the
     * receipt rather than leaving it in this comment, because a number a citizen
     * has to read source code to learn is not a promise anybody made it.
     */
    return reply
      .header('cache-control', `public, max-age=${AVATAR_CACHE_SECONDS}`)
      .type(AVATAR_MEDIA_TYPE[served.avatar.format])
      .send(Buffer.from(served.avatar.bytes))
  })
}
