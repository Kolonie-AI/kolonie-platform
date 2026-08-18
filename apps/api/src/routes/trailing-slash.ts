import { ATLAS_PATH, CITIZEN_PATH_PREFIX, PROFILE_PATH_PREFIX } from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'

/**
 * The public HTML surfaces, each ending in the slash that makes it a segment.
 *
 * **Built from the constants and never spelled again here.** These same strings
 * decide where the pages answer (`atlas-pages.ts`, `profile-pages.ts`); a second
 * copy would be a redirect that keeps pointing at a URL after the route under it
 * has moved, which is the one failure a redirect cannot survive.
 *
 * **The trailing slash is what makes the match a segment boundary rather than a
 * string prefix.** `ATLAS_PATH` is `/atlas`, and matching on that would sweep in
 * `/atlaskit/`; matching on `/atlas/` cannot, and it still catches the index —
 * `/atlas/` is the index with the slash on it, which is the case this exists for.
 * `CITIZEN_PATH_PREFIX` already carries its slash and `/citizenship/` is outside
 * it for the same reason. `PROFILE_PATH_PREFIX` is `/@`, which needs no boundary:
 * no other path on any Kolonie host begins with `@`.
 */
const SLASHED_PREFIXES: readonly string[] = [
  `${ATLAS_PATH}/`,
  PROFILE_PATH_PREFIX,
  CITIZEN_PATH_PREFIX,
]

/**
 * A trailing slash on a public page is a `301` to the page, not a `404` (`#1212`).
 *
 * ## What was wrong
 *
 * `kolonie.ai/atlas/` answered `404`, and the body was the REST API's JSON error
 * telling a reader in a browser about `/v1/` and the MCP endpoint. That is not a
 * corner case somebody has to go looking for: **the website's own URLs all end in
 * a slash** — `/academy/`, `/pricing/`, `/about/` — because Astro emits directory
 * URLs, so the slash is the convention a reader carries over from the rest of the
 * site and `kolonie.ai/atlas/` is the form the Atlas gets linked as. A crawler
 * that found it indexed a `404` for the catalogue's index.
 *
 * ## Why one hook and not Fastify's `ignoreTrailingSlash`
 *
 * The option is per-instance and would apply to `/v1/` too, which would make
 * `POST /v1/tasks/` a synonym for `POST /v1/tasks` — a REST semantic nobody asked
 * for. It also answers `200` to both spellings, and **an alias accumulates URL
 * variants where a redirect collapses them**: the same argument
 * `profile-pages.ts` already makes about a handle's casing, and `app.test.ts`
 * asserts the `/v1/` half of it so this file cannot quietly grow into the option.
 *
 * ## Why one hook and not one route per page
 *
 * `/atlas/`, `/atlas/:provider/`, `/atlas/c/:slug/`, `/@:handle/` and
 * `/citizens/:handle/` would be five registrations mirroring five others, and the
 * sixth public page added later would silently not get one. The hook is a rule
 * about a shape; the routes are a list, and lists drift.
 *
 * ## `301`, and with no `cache-control` — unlike `permanently()`
 *
 * Permanent because the slashless form is canonical and does not change. And this
 * is the one redirect on these surfaces that should be cached indefinitely:
 * `profile-pages.ts` caps the lifetime of its own `301` because that `location`
 * carries a citizen's registered casing and must not outlive an erasure, whereas
 * this `location` is the caller's own URL with one character removed. It says
 * nothing about anybody and holds for every future request.
 *
 * ## Two things it deliberately does not do
 *
 * **It does not resolve a handle to save `/citizens/colette/` its second hop.**
 * That would put the `publicRecord` lookup in front of every request to these
 * prefixes; `/citizens/` is a redirect-only form already, and a slash on it is a
 * rare spelling of a rare URL. Two hops, accepted.
 *
 * **It does not check the host.** The host guard belongs to the page routes,
 * which run `isAtlasRequest` themselves. A request to `api.kolonie.ai/atlas/`
 * lands on `api.kolonie.ai/atlas` and 404s there exactly as it does today, so the
 * answer is right either way and this hook has one fewer thing to know.
 */
export function registerTrailingSlashRedirect(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    /**
     * Reading methods only. A `POST` to a slashed URL is somebody's client with
     * a bug in it and redirecting it would move the body to a URL that never
     * expected one; `HEAD` is in because Fastify derives one from every `GET`,
     * so a crawler that checks with `HEAD` gets the reader's answer.
     */
    if (request.method !== 'GET' && request.method !== 'HEAD') return

    const asked = request.url
    const query = asked.indexOf('?')
    const path = query === -1 ? asked : asked.slice(0, query)

    if (!path.endsWith('/')) return
    if (!SLASHED_PREFIXES.some((prefix) => path.startsWith(prefix))) return

    /**
     * Every trailing slash, not one of them. `/@colette//` has one canonical
     * destination and should reach it in one hop rather than bouncing through
     * `/@colette/` — a chain is what a crawler gives up on.
     */
    return reply.redirect(
      `${path.replace(/\/+$/, '')}${query === -1 ? '' : asked.slice(query)}`,
      301,
    )
  })
}
