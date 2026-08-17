import {
  ATLAS_CACHE_SECONDS,
  ATLAS_PATH,
  atlasPath,
  now,
  AccountProviderSchema,
  AtlasCategorySlugSchema,
  type AtlasDocument,
  type AtlasEntry,
} from '@kolonie-ai/core'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ATLAS_HEADERS, atlasEntryPage, atlasIndexPage } from '../atlas/html.js'
import { siteChromeFrom } from '../atlas/site-chrome.js'
import { atlasSitemap } from '../atlas/sitemap.js'
import { atlasCatalogue } from '../provider-recipes.js'
import type { RouteDependencies } from './dependencies.js'

/**
 * The Atlas, served by the API on the website's host (`#546`).
 *
 * ## Why this is not a build
 *
 * The catalogue is a table edited by the maintainer, by stewards and by citizens
 * (`#525`). `kolonie.ai` is a static Astro site built into an image, so an entry
 * would cost a rebuild and a deploy — and a curation session would cost twenty
 * of each. That was considered and rejected on 2026-08-07.
 *
 * **The Colony already runs the alternative.** D-062 put `console.kolonie.ai` on
 * a host route: server-rendered HTML, no framework, no JavaScript, read straight
 * from the database. This is the same arrangement pointed at a different host —
 * Traefik sends `kolonie.ai/atlas*` here and everything else to the static site,
 * so the website has no runtime dependency on the API and nothing rebuilds.
 *
 * ## The risk this route introduces, stated as the rule it is enforced by
 *
 * **The API begins serving unauthenticated public traffic at volume.** Nothing
 * under this prefix authenticates, and nothing under it may read a citizen's
 * row. That is asserted rather than intended: `atlas-pages.test.ts` sends the
 * same request anonymously and with a credential and requires the bytes to be
 * identical, which is a check a personalisation cannot pass however it is
 * introduced.
 *
 * ## Registered on the app, not under `/v1`
 *
 * These are pages a person reads and a crawler indexes. An API version in a
 * public URL is a URL that breaks for a reason nothing to do with the page —
 * the same call the console made (`#179`) and the mailed pages after it.
 */
export function registerAtlasPages(app: FastifyInstance, deps: RouteDependencies): void {
  const { recipes, websiteUrl, renames, atlasQuests } = deps

  /**
   * The site's own header and footer, fetched from the website rather than
   * reproduced here (`kolonie-website#99`).
   *
   * `siteChrome` is injectable so a test can supply a fragment without a
   * server; production builds one from `websiteUrl`, which is the same value
   * every page below already writes into its canonical link. An absent or
   * unreachable fragment is an ordinary state: the pages render as they did
   * before `#99`, which `site-chrome.ts` explains at length.
   */
  const chromeOf = deps.siteChrome ?? siteChromeFrom({ websiteUrl, log: deps.log })

  /**
   * Every request here first asks *is this the Atlas's host*.
   *
   * The API answers on five hostnames from one process. Without this guard the
   * Atlas would also answer on `api.kolonie.ai` and `mcp.kolonie.ai`, which is
   * three more addresses for one page — duplicate content a canonical tag then
   * has to argue with, on hosts that have no business serving it.
   */
  const wrongHost = (request: FastifyRequest): boolean => !isAtlasRequest(request, websiteUrl)

  const send = (reply: FastifyReply, body: string, type: string): FastifyReply => {
    for (const [header, value] of Object.entries(ATLAS_HEADERS)) reply.header(header, value)

    return reply
      .header(
        'cache-control',
        `public, max-age=${ATLAS_CACHE_SECONDS}, s-maxage=${ATLAS_CACHE_SECONDS}, stale-while-revalidate=${ATLAS_CACHE_SECONDS * 4}`,
      )
      .type(type)
      .send(body)
  }

  /**
   * The catalogue with its measurements, in the order `#545` derives.
   *
   * **Ordered on every read and never from a stored rank**, which is what makes
   * the ordering something nobody can buy — there is no position field to set.
   *
   * The log goes in because this is the surface `#1096` was about: a provider
   * whose kind names no shelf is shelved by default here, and the line saying
   * so is worth having from the process that serves the pages it was missing
   * from.
   */
  const listEntries = async (): Promise<readonly AtlasEntry[]> =>
    atlasCatalogue(recipes, { log: deps.log })

  app.get<{ Querystring: { category?: string } }>(ATLAS_PATH, async (request, reply) => {
    if (wrongHost(request)) return reply.callNotFound()

    /**
     * The shelf a reader asked for, if they asked for one that exists
     * (`kolonie-website#97`).
     *
     * **A category nobody defined is not an error and not a 404** — it is the
     * unfiltered index, which is what a reader following a stale or mistyped
     * link most wants. `#591` took the same decision on the console's browser
     * and this follows it rather than inventing a second answer.
     *
     * **The canonical drops the filter.** A filtered view is a slice of one
     * page and not a page of its own; every shelf pointing at `/atlas` is what
     * stops fourteen near-identical URLs competing with each other in a search
     * index.
     *
     * **The vocabulary is read rather than compiled in, since `#1102`.** The
     * shelves are rows now, so *does this shelf exist* is a question for the
     * table and not for an enum frozen at the last release — a link to a shelf
     * added last week has to filter, and a link to one that was renamed away
     * has to fall back rather than render an empty page that reads as broken.
     * The shape is checked first so that a string which could not be a slug
     * never reaches the query.
     */
    const asked = AtlasCategorySlugSchema.safeParse(request.query.category)
    const shelves = asked.success ? await recipes.categories() : []
    const category = shelves.some((one) => one.slug === asked.data) ? asked.data : undefined

    return send(
      reply,
      atlasIndexPage({
        entries: await listEntries(),
        canonical: `${websiteUrl}${ATLAS_PATH}`,
        chrome: await chromeOf(),
        category,
      }),
      'text/html; charset=utf-8',
    )
  })

  /**
   * The sitemap, and it is the reason a dynamic Atlas indexes as well as a
   * static one would.
   *
   * Ahead of `/atlas/:provider` in this file for readability only — Fastify
   * matches a static segment before a parametric one regardless of order, so
   * `sitemap.xml` could not be read as a provider name even if a provider were
   * ever called that.
   */
  app.get(`${ATLAS_PATH}/sitemap.xml`, async (request, reply) => {
    if (wrongHost(request)) return reply.callNotFound()

    return send(
      reply,
      atlasSitemap({ entries: await listEntries(), websiteUrl }),
      'application/xml; charset=utf-8',
    )
  })

  /**
   * The catalogue as data, for a reader with no credential (`#551`).
   *
   * **Under `/atlas` and not `/v1`**, which is the same call the pages made and
   * for a stronger reason: this is the surface a third party stores a URL to. It
   * carries the same rules as the pages — anonymous, cacheable, aggregates only,
   * nothing per-citizen — so the one test that guards them guards this too.
   *
   * **`/v1/accounts/recipes` is not this.** That one authenticates, answers with
   * rows rather than entries, and carries no figures; a stranger checking the
   * Colony's claim cannot reach it at all. The two exist for different readers
   * and neither is the other's version.
   */
  app.get(`${ATLAS_PATH}/catalogue.json`, async (request, reply) => {
    if (wrongHost(request)) return reply.callNotFound()

    const document: AtlasDocument = {
      generatedAt: now(),
      maxAgeSeconds: ATLAS_CACHE_SECONDS,
      entries: [...(await listEntries())],
    }

    return send(reply, JSON.stringify(document), 'application/json; charset=utf-8')
  })

  app.get<{ Params: { provider: string } }>(`${ATLAS_PATH}/:provider`, async (request, reply) => {
    if (wrongHost(request)) return reply.callNotFound()

    const asked = AccountProviderSchema.safeParse(request.params.provider)
    if (!asked.success) return reply.callNotFound()

    const entry = (await listEntries()).find((one) => one.provider === asked.data)

    if (entry === undefined) {
      /**
       * **A page that used to be here is a redirect, not a 404.**
       *
       * Looked up only on the miss, so the ordinary read costs nothing: a
       * rename is rare and the query for one should not be on the path every
       * hit takes. 301 rather than 302 — the move is permanent, and a
       * temporary redirect leaves the old URL in an index forever.
       *
       * **An alias lands here too, and 301 is still right** (`#772`).
       * `clawhub.com` is a live name at the provider, but its *Atlas page* is
       * permanently the canonical entry's — two URLs for one entry is the
       * duplicate a crawler splits its judgement across.
       */
      const renamedTo = await renames.renamedTo(asked.data)
      if (renamedTo !== undefined) return reply.redirect(atlasPath(renamedTo), 301)

      return reply.callNotFound()
    }

    return send(
      reply,
      atlasEntryPage({
        entry,
        canonical: `${websiteUrl}${entry.path}`,
        chrome: await chromeOf(),
        /**
         * Who paid for the figures below them (`#602`). Read here rather than
         * in `listEntries`, so the index page — which shows no figures — pays
         * nothing for a fact only the entry page states.
         */
        quests: await atlasQuests?.naming(asked.data),
        /**
         * What the Colony wrote up from this provider's walks (`#831`). Read
         * here for the reason directly above: the index and the catalogue
         * document show no briefing, and neither should pay for one.
         */
        briefings: await recipes.briefings(asked.data),
      }),
      'text/html; charset=utf-8',
    )
  })
}

/**
 * Whether this request arrived on the host the Atlas serves.
 *
 * The same shape as `isConsoleRequest`, and separate from it because it reads a
 * different setting: the console's host is `CONSOLE_URL` and this one is the
 * website's. **An unset `WEBSITE_URL` means the Atlas does not serve** — a process
 * that cannot tell where the website lives must not guess, because the guess
 * would be the API's own host and the Atlas would appear on five addresses.
 */
export function isAtlasRequest(
  request: { readonly headers: { host?: string } },
  websiteUrl: string,
): boolean {
  const host = atlasHost(websiteUrl)
  if (host === undefined) return false

  return (request.headers.host ?? '').split(':')[0]?.toLowerCase() === host
}

/** The host from `WEBSITE_URL`, or nothing when it is unset or malformed. */
export function atlasHost(websiteUrl: string): string | undefined {
  if (websiteUrl.trim() === '') return undefined

  try {
    return new URL(websiteUrl).hostname.toLowerCase()
  } catch {
    return undefined
  }
}
