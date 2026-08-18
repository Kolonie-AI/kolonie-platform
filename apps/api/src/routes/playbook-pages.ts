import {
  PLAYBOOK_CACHE_SECONDS,
  PLAYBOOK_PUBLIC_STATUSES,
  PLAYBOOKS_PATH,
  PlaybookSlugSchema,
  type Playbook,
} from '@kolonie-ai/core'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ATLAS_HEADERS } from '../atlas/html.js'
import { siteChromeFrom } from '../atlas/site-chrome.js'
import { playbookEntryPage, playbookIndexPage } from '../playbooks/html.js'
import { playbookSitemap } from '../playbooks/sitemap.js'
import { PLAYBOOK_LISTED_STATUSES } from '../playbooks.js'
import { isAtlasRequest } from './atlas-pages.js'
import type { RouteDependencies } from './dependencies.js'

/**
 * The playbook catalogue, served by the API on the website's host (`#1220`).
 *
 * ## Why this is not a build
 *
 * `kolonie-website#124` shipped `/playbooks/` as one built page saying what a
 * playbook is. It could not list them: playbooks are citizen-authored and arrive
 * continuously, so a build-time index is a deploy per playbook — the arrangement
 * `#546` considered and rejected for the Atlas on 2026-08-07, for a catalogue
 * that grows far more slowly than this one will.
 *
 * **So the whole prefix moves rather than splitting.** `#1220` names both ways:
 * the website keeps `/playbooks/` and the API takes `/playbooks/<slug>`, or the
 * route moves whole and `#124`'s page comes with it. The index decides — a
 * rendered index cannot sit under a built parent — and the address a reader
 * already has is unchanged either way, which is why the story page's prose is
 * transplanted into {@link playbookIndexPage} rather than deleted.
 *
 * ## One source, not a copy
 *
 * Every route here reads `deps.playbooks.catalogue`, which is the port
 * `kolonie.playbooks.list` and `kolonie.playbooks.read` read. There is no second
 * store, no second projection and no second scrubber: credentials are refused at
 * write time by `PlaybookDraftSchema` (D-430 freeze I), so this surface inherits
 * the scrubbing the MCP surface has instead of reimplementing it — which is what
 * `#1220`'s *scrubbed exactly as the MCP surface scrubs them* asks for.
 *
 * ## The risk this route introduces, stated as the rule it is enforced by
 *
 * These pages are **anonymous and public**, and the catalogue they read is the
 * one an authenticated tool reads. So: the index lists `open` only, an entry
 * answers for `open` and `blocked` and for nothing else, and no route here ever
 * looks at a credential — an unauthenticated reader and a citizen get the same
 * bytes, which is the property the test pins first.
 *
 * ## Registered on the app, not under `/v1`
 *
 * For `#546`'s reason: an API version in a public URL is a URL that breaks for a
 * reason nothing to do with the page.
 */
export function registerPlaybookPages(app: FastifyInstance, deps: RouteDependencies): void {
  const { websiteUrl } = deps

  /**
   * The catalogue port, or nothing.
   *
   * **A deployment that wires no catalogue serves no pages**, which is the same
   * shape `dependencies.ts` gives the MCP tools: the port is optional there, so a
   * route that assumed it would be the one thing in the process that could not
   * start.
   */
  const catalogue = deps.playbooks?.catalogue

  /** The site's own header and footer, on the terms `atlas-pages.ts` sets out. */
  const chromeOf = deps.siteChrome ?? siteChromeFrom({ websiteUrl, log: deps.log })

  /**
   * Every request here first asks *is this the website's host*.
   *
   * The API answers on five hostnames from one process, and the guard is
   * `isAtlasRequest` rather than a second copy of it: this surface and the Atlas
   * answer on exactly the same host for exactly the same reason, and two
   * predicates would be two things to keep in step.
   */
  const wrongHost = (request: FastifyRequest): boolean => !isAtlasRequest(request, websiteUrl)

  const send = (reply: FastifyReply, body: string, type: string): FastifyReply => {
    for (const [header, value] of Object.entries(ATLAS_HEADERS)) reply.header(header, value)

    return reply
      .header(
        'cache-control',
        `public, max-age=${PLAYBOOK_CACHE_SECONDS}, s-maxage=${PLAYBOOK_CACHE_SECONDS}, stale-while-revalidate=${PLAYBOOK_CACHE_SECONDS * 4}`,
      )
      .type(type)
      .send(body)
  }

  /**
   * What the catalogue shows a stranger.
   *
   * **{@link PLAYBOOK_PUBLIC_STATUSES}, which is `open` only**, and the same
   * constant `kolonie.playbooks.list` narrows to rather than a second literal.
   * `blocked` is readable at its own address — freeze B makes it content — but a
   * list is a recommendation, and a shelf mixing what works with what broke
   * recommends both.
   */
  const listed = async (): Promise<readonly Playbook[]> =>
    catalogue === undefined ? [] : catalogue.byStatus({ statuses: [...PLAYBOOK_PUBLIC_STATUSES] })

  app.get(PLAYBOOKS_PATH, async (request, reply) => {
    if (wrongHost(request) || catalogue === undefined) return reply.callNotFound()

    return send(
      reply,
      playbookIndexPage({
        playbooks: await listed(),
        canonical: `${websiteUrl}${PLAYBOOKS_PATH}`,
        chrome: await chromeOf(),
      }),
      'text/html; charset=utf-8',
    )
  })

  /**
   * Registered above `/:slug` for readability only — Fastify matches a static
   * segment before a parametric one whatever the order, and `sitemap.xml` could
   * not be a slug anyway.
   */
  app.get(`${PLAYBOOKS_PATH}/sitemap.xml`, async (request, reply) => {
    if (wrongHost(request) || catalogue === undefined) return reply.callNotFound()

    return send(
      reply,
      playbookSitemap({ playbooks: await listed(), websiteUrl }),
      'application/xml; charset=utf-8',
    )
  })

  app.get<{ Params: { slug: string } }>(`${PLAYBOOKS_PATH}/:slug`, async (request, reply) => {
    if (wrongHost(request) || catalogue === undefined) return reply.callNotFound()

    /**
     * Shape first, so a string that could not be a slug never reaches the
     * query — and so the 404 for `/playbooks/Some%20Thing` costs no database.
     */
    const asked = PlaybookSlugSchema.safeParse(request.params.slug)
    if (!asked.success) return reply.callNotFound()

    const playbook = await catalogue.bySlug(asked.data)

    /**
     * **By slug and never by id, which is the opposite of what the MCP read
     * does** (`kolonie.playbooks.read` takes either). An id is not a public
     * name: serving one here would give every playbook two addresses, which is
     * the duplicate a canonical then has to argue with, and it would leak the
     * id of a draft as a 404-versus-403 difference.
     *
     * **`draft`, `review` and `retired` answer exactly as a slug nobody holds**
     * — they belong to their author (`#1178`), and a 404 that is different from
     * *not found* is an existence oracle.
     */
    if (
      playbook === null ||
      !(PLAYBOOK_LISTED_STATUSES as readonly string[]).includes(playbook.status)
    ) {
      return reply.callNotFound()
    }

    return send(
      reply,
      playbookEntryPage({
        playbook,
        canonical: `${websiteUrl}${PLAYBOOKS_PATH}/${playbook.slug}`,
        chrome: await chromeOf(),
      }),
      'text/html; charset=utf-8',
    )
  })
}
