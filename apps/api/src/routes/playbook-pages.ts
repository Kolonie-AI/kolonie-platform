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
import {
  PLAYBOOK_NOTES_SHOWN,
  playbookEntryPage,
  playbookIndexPage,
  type PlaybookPageLife,
  type PlaybookPageRuns,
} from '../playbooks/html.js'
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

  /**
   * The run log behind the living half of these pages (`#1257`).
   *
   * **Optional exactly as the catalogue is**, and for the same reason: a
   * deployment that wires no playbook dependencies serves the pages `#1220`
   * served — steps, slots and no counts — rather than failing to start. What it
   * must never do is serve a page that *looks* as though nobody has run a
   * pipeline because the port was missing, which is why the sections are absent
   * rather than zeroed when this is undefined.
   */
  const life = deps.playbooks

  /**
   * Run counts for the whole index, in one call (`#1257`).
   *
   * Not `runs.activity` per row: this page is served to strangers and the
   * catalogue grows, so a query per entry is a cost the listing does not need.
   */
  const countsFor = async (
    playbooks: readonly Playbook[],
  ): Promise<ReadonlyMap<string, PlaybookPageRuns> | undefined> =>
    life === undefined || playbooks.length === 0
      ? undefined
      : life.runs.counts(playbooks.map((playbook) => playbook.id))

  /**
   * Everything about one playbook that is not the playbook.
   *
   * **`briefing.split(...).current` and never the demoted half** (`#1257`): a
   * public page shows what the Colony currently supports, and a claim the decay
   * rule has taken out of the foreground stays on `kolonie.playbooks.reports`
   * with its age. The page filters again on `current`, so this is the second of
   * two guards rather than the only one.
   *
   * A cursor is never passed to `notes`, so `'invalid-cursor'` is unreachable
   * here; it is handled rather than asserted away, because an unreachable branch
   * that throws on a public route is a 500 waiting for a refactor.
   */
  const lifeOf = async (playbook: Playbook): Promise<PlaybookPageLife | undefined> => {
    if (life === undefined) return undefined

    const [briefing, activity, signals, contributors, notes, history] = await Promise.all([
      life.briefing.split(playbook.id),
      life.runs.activity(playbook.id),
      life.runs.signals(playbook.id),
      life.revisions.contributors(playbook.id),
      life.runs.notes({ playbookId: playbook.id, limit: PLAYBOOK_NOTES_SHOWN }),
      life.revisions.history(playbook.id),
    ])

    const cut = history.find((one) => one.revision === playbook.version) ?? history[0]

    return {
      claims: briefing.current,
      runs: { total: activity.total, byOutcome: activity.byOutcome },
      signals,
      contributors: contributors.map((one) => ({
        handle: one.handle,
        contributions: one.contributions,
        isCreator: one.isCreator,
      })),
      notes: notes === 'invalid-cursor' ? [] : notes.notes,
      revision: { revision: playbook.version, cutAt: cut?.cutAt ?? null },
    }
  }

  /**
   * `/playbooks/` and `/playbooks/<slug>/` are the same pages at one more
   * character, and they answer `301` rather than `404`.
   *
   * **Because the slashed form is the one already published.** `#124` shipped
   * this address with a trailing slash — Astro's own convention — so the site
   * footer, `/llms.txt` and whatever a reader bookmarked all say `/playbooks/`.
   * The API registers the unslashed form (Fastify is built without
   * `ignoreTrailingSlash`, and turning that on would serve every route here at
   * two addresses instead of moving readers to one), so without this the move
   * would break every link that already exists.
   *
   * **In the application and not in Traefik**, which is `#319`'s rule as
   * recorded in `kolonie-infra/traefik/dynamic/routes.yml`: a redirect is a
   * property of the application, and two layers both owning one is a loop no
   * test catches. The proxy routes the prefix; what happens inside it is here.
   *
   * `301` and not `308`, matching the Atlas's renames: the method is `GET`
   * either way, and `301` is the answer every crawler already understands.
   */
  const canonical = (path: string) => `${PLAYBOOKS_PATH}${path}`

  app.get(`${PLAYBOOKS_PATH}/`, async (request, reply) => {
    if (wrongHost(request) || catalogue === undefined) return reply.callNotFound()

    return reply.redirect(canonical(''), 301)
  })

  app.get<{ Params: { slug: string } }>(`${PLAYBOOKS_PATH}/:slug/`, async (request, reply) => {
    if (wrongHost(request) || catalogue === undefined) return reply.callNotFound()

    /**
     * The shape is checked before the `location` is built, so that header is
     * only ever assembled from a string a schema accepted — a decoded
     * parameter echoed into a redirect is how a same-origin path becomes
     * something else. `sitemap.xml` is not a slug and is named separately for
     * exactly that reason: it is a real address here, and the shape test
     * would otherwise 404 it.
     */
    const slug = request.params.slug
    if (slug !== 'sitemap.xml' && !PlaybookSlugSchema.safeParse(slug).success) {
      return reply.callNotFound()
    }

    return reply.redirect(canonical(`/${slug}`), 301)
  })

  app.get(PLAYBOOKS_PATH, async (request, reply) => {
    if (wrongHost(request) || catalogue === undefined) return reply.callNotFound()

    const playbooks = await listed()

    return send(
      reply,
      playbookIndexPage({
        playbooks,
        canonical: `${websiteUrl}${PLAYBOOKS_PATH}`,
        chrome: await chromeOf(),
        runs: await countsFor(playbooks),
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
        life: await lifeOf(playbook),
      }),
      'text/html; charset=utf-8',
    )
  })
}
