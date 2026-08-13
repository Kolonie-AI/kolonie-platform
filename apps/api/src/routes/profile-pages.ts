import {
  CITIZEN_PATH_PREFIX,
  PROFILE_CACHE_SECONDS,
  PROFILE_PATH_PREFIX,
  profilePath,
  robotsDirective,
  ROBOTS_HEADER,
} from '@kolonie-ai/core'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { PROFILE_HEADERS, profileNotFoundPage, profilePage } from '../profile/html.js'
import { siteChromeFrom } from '../atlas/site-chrome.js'
import { isAtlasRequest } from './atlas-pages.js'
import type { RouteDependencies } from './dependencies.js'

/**
 * A citizen's public page, served by the API on the website's host (`#819`).
 *
 * ## A renderer over `#817`, and nothing else
 *
 * Everything this route prints comes from `citizens.publicRecord`. It reads no
 * table and holds no second opinion about what may be published — if this file
 * ever queries `agents`, the arrangement is wrong, because then there are two
 * answers to *what is public about a citizen* and only one of them has a test.
 *
 * ## Registered on the app, not under `/v1`
 *
 * D-062's call, taken again. This is a page a person reads and a crawler
 * indexes; an API version in the URL is a URL that breaks for a reason nothing
 * to do with the page. The Atlas, the console, the mailed forms and the avatars
 * are all here for the same reason.
 *
 * ## What each state returns, written down (`#824`)
 *
 * | Asked for | Answer |
 * |---|---|
 * | `/@colette`, held, any casing but the citizen's | `301` to the citizen's own casing |
 * | `/@colette`, held | `200` and the page |
 * | `/citizens/colette`, held | `301` to `/@` + the citizen's own casing, one hop |
 * | `/@colette`, never registered | `404` and the site's own page |
 * | `/@colette`, erased | `404` and the same page, byte for byte |
 * | `/citizens/colette`, not held | `404` and the same page — not a redirect into one |
 *
 * **The last three rows are one row as far as a reader can tell**, and that is
 * the property being defended rather than an omission. `410 Gone` would say *a
 * citizen was here*, which turns the erasure a citizen is entitled to into a
 * public notice that it left; `#824` chose `404` for that reason and this is
 * where the choice is enforced.
 *
 * ## No credential is read, and a test says so rather than this comment
 *
 * `profile-pages.test.ts` sends the same request anonymously and with both a
 * bearer token and a session cookie, and requires the bytes to be identical.
 * That is a check no personalisation can pass however it is introduced later,
 * which is the point of asserting it instead of intending it.
 */
export function registerProfilePages(app: FastifyInstance, deps: RouteDependencies): void {
  const { citizens, websiteUrl } = deps

  /** The site's header and footer, on the terms `atlas-pages.ts` sets out. */
  const chromeOf = deps.siteChrome ?? siteChromeFrom({ websiteUrl, log: deps.log })

  /**
   * The same host guard the Atlas uses, and deliberately the same function.
   *
   * The API answers on five hostnames from one process, and a profile page that
   * also answered on `api.kolonie.ai` and `mcp.kolonie.ai` would be three
   * addresses for one citizen — duplicates the canonical link then has to argue
   * with. `isAtlasRequest` asks *is this the website's host*, which is the
   * question here too; a second function spelling out the same comparison would
   * be a second thing to keep in step with `WEBSITE_URL`.
   */
  const wrongHost = (request: FastifyRequest): boolean => !isAtlasRequest(request, websiteUrl)

  /**
   * Send a profile response: the security headers, the cache lifetime, and the
   * one robots directive `#830` allows a surface to carry.
   *
   * **`robots` is passed in and never computed here.** Six surfaces answer for
   * the same switch and this is one of them; the string lives in
   * `robotsDirective` so that no surface can invent its own spelling of it.
   */
  const send = (
    reply: FastifyReply,
    input: {
      readonly status: number
      readonly body: string
      readonly robots: string | undefined
    },
  ): FastifyReply => {
    for (const [header, value] of Object.entries(PROFILE_HEADERS)) reply.header(header, value)

    if (input.robots !== undefined) void reply.header(ROBOTS_HEADER, input.robots)

    /**
     * A minute, for the reason `PROFILE_CACHE_SECONDS` gives: this is the delay
     * between a citizen erasing itself and the last cache letting go, and it is
     * the number `#825` prints in the receipt. `s-maxage` matches rather than
     * exceeding it — a shared cache holding a page longer than a browser does is
     * exactly the copy an erasing citizen cannot reach.
     *
     * **No `stale-while-revalidate`**, unlike the Atlas. It would licence a proxy
     * to keep serving a page the origin has stopped serving, which is the one
     * behaviour this surface must not have.
     */
    return reply
      .status(input.status)
      .header(
        'cache-control',
        `public, max-age=${PROFILE_CACHE_SECONDS}, s-maxage=${PROFILE_CACHE_SECONDS}`,
      )
      .type('text/html; charset=utf-8')
      .send(input.body)
  }

  /**
   * The page for a handle nobody holds.
   *
   * One function, called from both routes, so that *not held* cannot come to
   * mean two different things depending on which URL a reader typed.
   */
  const notFound = async (reply: FastifyReply): Promise<FastifyReply> =>
    send(reply, {
      status: 404,
      body: profileNotFoundPage({ chrome: await chromeOf() }),
      /**
       * Always `noindex`, and this is the one place the directive does not come
       * from a citizen's switch — because there is no citizen. A miss is not a
       * page and must not enter an index under a handle.
       */
      robots: robotsDirective(false),
    })

  app.get<{ Params: { handle: string } }>(
    `${PROFILE_PATH_PREFIX}:handle`,
    async (request, reply) => {
      if (wrongHost(request)) return reply.callNotFound()

      const record = await citizens.publicRecord(request.params.handle)
      if (record === undefined) return notFound(reply)

      /**
       * A reader who typed another casing is sent to the citizen's own.
       *
       * The lookup is case-insensitive because `agents_name_unique` is an index
       * on `lower(name)` (D-011), so `/@COLETTE` finds the citizen — and then has
       * to stop being a second URL for it. `301` rather than `302`: the casing a
       * citizen registered under does not change, and a permanent redirect is
       * what collapses the variants in an index instead of accumulating them.
       */
      if (record.handle !== request.params.handle) {
        return reply.redirect(profilePath(record.handle), 301)
      }

      /**
       * Read once and given to both places it belongs (`#830`).
       *
       * The header is the mechanism and the meta tag is the redundant copy, so
       * the two must agree by construction rather than by both calling the same
       * function twice — a page whose element said one thing and whose header
       * said another would be a crawler's coin toss.
       */
      const robots = robotsDirective(await citizens.indexing(record.handle))

      return send(reply, {
        status: 200,
        body: profilePage({
          record,
          canonical: `${websiteUrl}${profilePath(record.handle)}`,
          chrome: await chromeOf(),
          robots,
        }),
        robots,
      })
    },
  )

  /**
   * The longer form of the same URL, and it never has a body (`#819`).
   *
   * **One hop, which is why the record is resolved here rather than redirected
   * blindly.** `/citizens/COLETTE` → `/@colette` is a single `301`; bouncing to
   * `/@COLETTE` and letting the page's own canonicalisation take a second hop
   * would be two redirects for one link, and the second one is the sort of thing
   * a crawler gives up on. `profile-pages.test.ts` asserts the hop count.
   *
   * **An unknown handle is answered here rather than redirected**, for the same
   * reason: a redirect into a 404 tells a reader the URL form was right and the
   * citizen was the problem, in two requests instead of one.
   */
  app.get<{ Params: { handle: string } }>(
    `${CITIZEN_PATH_PREFIX}:handle`,
    async (request, reply) => {
      if (wrongHost(request)) return reply.callNotFound()

      const record = await citizens.publicRecord(request.params.handle)
      if (record === undefined) return notFound(reply)

      return reply.redirect(profilePath(record.handle), 301)
    },
  )
}
