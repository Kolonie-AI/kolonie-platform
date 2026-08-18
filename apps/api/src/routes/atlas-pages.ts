import {
  ATLAS_CACHE_SECONDS,
  ATLAS_PATH,
  atlasCategoryPath,
  atlasPath,
  now,
  AccountProviderSchema,
  AtlasCategorySlugSchema,
  type AtlasDocument,
  type AtlasEntry,
} from '@kolonie-ai/core'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  ATLAS_HEADERS,
  atlasCategoryPage,
  atlasEntryPage,
  atlasIndexPage,
  atlasPageAsked,
  atlasPageCount,
  atlasShelfPath,
  atlasShelfRows,
} from '../atlas/html.js'
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
  const { recipes, websiteUrl, renames, atlasQuests, atlasPlaybooks } = deps

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

  app.get<{ Querystring: { category?: string; worked?: string } }>(
    ATLAS_PATH,
    async (request, reply) => {
      if (wrongHost(request)) return reply.callNotFound()

      /**
       * Which half of the catalogue to show (`#1103` decisions 1 and 7).
       *
       * **Only `false` turns the default off, and everything else is the
       * default silently.** `?worked=banana` renders the index rather than an
       * error — a reader following a mangled link wants the page, and a 400 on
       * a public URL is a page a crawler stops asking for.
       */
      const worked = request.query.worked !== 'false'

      /**
       * `?category=` used to filter this page; it is a redirect now (`#1107`
       * decision 3).
       *
       * **The shelf is a page of its own, so the filter is one address for
       * another page's content** — the duplicate a canonical then has to argue
       * with, and the reason the old arrangement could never rank a shelf. 301
       * rather than 302: the move is permanent, and every link the Colony's own
       * pages emit already points at the new address.
       *
       * **`?worked=false` is carried across.** A reader on the failures of one
       * shelf who clicked a link into the same shelf and landed on its successes
       * would have been silently overruled by a redirect, which is worse than
       * the filter it replaced.
       *
       * **An unknown category is still the unfiltered index and not a 404.** It
       * is what a reader following a stale or mistyped link most wants, `#591`
       * took the same decision on the console's browser, and the page it lands
       * on exists — which is not true of `/atlas/c/<unknown>`, where the address
       * itself names nothing and 404 is the honest answer.
       *
       * The vocabulary is read rather than compiled in, since `#1102`: the
       * shelves are rows, so *does this shelf exist* is a question for the table
       * and not for an enum frozen at the last release. The shape is checked
       * first so that a string which could not be a slug never reaches the query.
       */
      const asked = AtlasCategorySlugSchema.safeParse(request.query.category)
      if (asked.success) {
        const shelves = await recipes.categories()
        if (shelves.some((one) => one.slug === asked.data)) {
          return reply.redirect(
            `${atlasCategoryPath(asked.data)}${worked ? '' : '?worked=false'}`,
            301,
          )
        }
      }

      return send(
        reply,
        atlasIndexPage({
          entries: await listEntries(),
          /**
           * **The canonical carries neither filter.** `#1103` puts `?worked=`
           * under the rule `#1107` moved `?category=` out of: the default view
           * is the page, and the other half is a slice of it. Written as a
           * constant rather than built from the query, so nothing a reader types
           * can become a second address for this page.
           */
          canonical: `${websiteUrl}${ATLAS_PATH}`,
          chrome: await chromeOf(),
          worked,
        }),
        'text/html; charset=utf-8',
      )
    },
  )

  /**
   * One shelf, at an address of its own (`#1107`).
   *
   * **Ahead of `/atlas/:provider` for readability only.** Fastify matches a
   * static segment before a parametric one whatever order they were registered
   * in, so a provider called `c` could not swallow this route — and `#1107`
   * decision 1 chose the `/c/` prefix precisely so that a category named
   * `storage` and a provider named `storage` are two addresses rather than one
   * whose winner depends on this file's line order.
   *
   * **Both levels of the taxonomy answer here** (decision 1). A top page groups
   * its entries into the sub categories under it and lists those in its nav; a
   * sub page lists its own entries and its siblings. The difference is what the
   * table says about the row, not which route was hit.
   */
  app.get<{ Params: { slug: string }; Querystring: { worked?: string; page?: string } }>(
    `${ATLAS_PATH}/c/:slug`,
    async (request, reply) => {
      if (wrongHost(request)) return reply.callNotFound()

      /**
       * **Two ways to be nothing, and both are a 404** (decision 3, and the
       * inverse of the index's fallback above). A string that could not be a
       * slug never reaches the query; a well-formed slug no row carries is a
       * shelf that does not exist, and rendering the whole catalogue under
       * somebody else's heading would be a page pretending to be the one they
       * asked for.
       */
      const asked = AtlasCategorySlugSchema.safeParse(request.params.slug)
      if (!asked.success) return reply.callNotFound()

      const shelves = await recipes.categories()
      const category = shelves.find((one) => one.slug === asked.data)
      if (category === undefined) return reply.callNotFound()

      /**
       * The shelves beside this one, and the entries that belong on the page.
       * A top category covers its children; a sub category covers itself.
       */
      const children = shelves.filter((one) => one.parent === category.slug)
      const isTop = category.parent === null
      const nav = isTop ? children : shelves.filter((one) => one.parent === category.parent)
      const covers = isTop ? children.map((one) => one.slug) : [category.slug]

      const entries = await listEntries()
      const worked = request.query.worked !== 'false'
      const page = atlasPageAsked(request.query.page)

      /**
       * **A page past the last one is a 404** (`#1143` decision 4), and it is
       * deliberately unlike the unknown `category` above, which falls back to
       * the index. A slug is a name and a wrong one is a broken link worth
       * answering with the catalogue; `?page=40` on a shelf of three pages is a
       * well-formed request for rows that do not exist, and the honest answer to
       * it is that there is nothing there. Serving the last page instead would
       * mint an unbounded number of addresses all holding the same rows.
       */
      if (page > atlasPageCount(atlasShelfRows(entries, covers, worked)))
        return reply.callNotFound()

      return send(
        reply,
        atlasCategoryPage({
          entries,
          category,
          nav,
          parent: shelves.find((one) => one.slug === category.parent),
          covers,
          /**
           * Decision 6 of `#1107`: the canonical is the shelf, with neither
           * filter on it — and `#1143` decision 3 puts the page on it, past the
           * first. A first page is the bare address however the reader spelled
           * it, so `?page=1`, `?page=0` and `?page=abc` all canonicalise there
           * rather than each being an address of its own.
           */
          canonical: `${websiteUrl}${atlasShelfPath(category.slug, undefined, page)}`,
          chrome: await chromeOf(),
          worked,
          page,
        }),
        'text/html; charset=utf-8',
      )
    },
  )

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
      atlasSitemap({
        entries: await listEntries(),
        categories: await recipes.categories(),
        websiteUrl,
      }),
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

    const catalogue = await listEntries()
    const entry = catalogue.find((one) => one.provider === asked.data)

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
         * What an account here is used for (`kolonie-website#116`). Read here
         * for the same reason as the quests above: no other Atlas surface names
         * a playbook, and a per-provider question asked while walking the whole
         * catalogue is four hundred queries for one page's paragraph.
         */
        playbooks: await atlasPlaybooks?.naming(asked.data),
        /**
         * What the Colony wrote up from this provider's walks (`#831`). Read
         * here for the reason directly above: the index and the catalogue
         * document show no briefing, and neither should pay for one.
         */
        briefings: await recipes.briefings(asked.data),
        /**
         * The shelf this entry sits on, so the page can end with somewhere to
         * go (`kolonie-website#113`). Free: it is the list the entry was just
         * found in, and `atlasNeighbours` takes three out of it.
         */
        catalogue,
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
