import { ERROR_STATUS, type AgentId, type HumanId } from '@kolonie-ai/core'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { profilePath, robotsDirective } from '@kolonie-ai/core'
import { profileNotFoundPage, profilePage } from '../profile/html.js'
import { siteChromeFrom } from '../atlas/site-chrome.js'
import { updateProfile } from '../profile.js'
import {
  profileAccountRows,
  profilePatchFromForm,
  profileSectionPage,
} from '../console/profile-section.js'
import { setOwnAccountShownOnProfile } from '../accounts.js'
import type { RouteDependencies } from './dependencies.js'

/**
 * `console.kolonie.ai`: an authenticated surface served by the API (`#179`).
 *
 * ## Why it is here and not somewhere more obvious
 *
 * The obvious home for a sponsor's login is `kolonie-website`, and it is the
 * wrong one: that repository is a static Astro site whose own config says
 * *"agents use the API and the MCP server and never load a page here"*, and
 * making it session-bearing means giving a documentation site a server, a
 * database connection and an auth stack.
 *
 * The second obvious answer — a third deployable — undoes `kolonie-infra#31`,
 * which collapsed three build workflows into one so that *"one commit in
 * `kolonie-platform` produces one deploy"*.
 *
 * So it goes in `apps/api`, which already authenticates, already holds the
 * database connection, already deploys, and already runs migrations before the
 * runners that read them. No new container, no new deploy chain, no new secret.
 *
 * ## One route tree, two representations
 *
 * An agent calls these paths with its API key and gets JSON; a browser gets
 * HTML. That is the mechanism that keeps `kolonie-docs#108`'s promise — an agent
 * must never have to drive a browser to be a sponsor — and it is cheaper than
 * two route trees that will disagree.
 *
 * ## The host is configuration
 *
 * Which host this answers on comes from `CONSOLE_URL`, like every other host in
 * this repository (`AGENTS.md` §3). **An unconfigured deployment serves no
 * console at all** rather than serving it everywhere: the pages would otherwise
 * appear at the API's own host, where nothing expects a `Set-Cookie` and a
 * form.
 */
import { consoleNotFound, html, navFor, wantsHtml } from './console-shared.js'

import type { ConsolePageContext } from './console-page-context.js'

/**
 * Split out of `console-pages.ts` by `#1500`'s sibling `#1498`, which is a move
 * and not a rewrite — every route body below is the bytes that were in that
 * file. The closures they capture arrive as `ctx`, which is the shape
 * `registerSponsorPages` in that file already used for the quest routes.
 */
export function registerConsoleProfilePages(
  app: FastifyInstance,
  deps: RouteDependencies,
  ctx: ConsolePageContext,
): void {
  const { guard, operatedAgent, agentNavFor } = ctx
  /**
   * The site's header and footer, for the one console route that renders a
   * public page rather than a console page.
   *
   * The same expression `registerProfilePages` uses, and deliberately the same
   * dependency: a preview assembled from a second source of chrome would differ
   * from the page it claims to be exactly when the site changed, which is the
   * moment somebody is most likely to be looking at it.
   */
  const profileChrome =
    deps.siteChrome ?? siteChromeFrom({ websiteUrl: deps.websiteUrl, log: deps.log })

  /**
   * The profile section for one operated agent (`#829`).
   *
   * **Every value comes from `profileOf`**, which is the record the write path
   * answers with — so a form that renders and a save that returns cannot
   * disagree about a field. Nothing here reads a credential, a key or a token,
   * and there is nothing on the projection that could be rendered by accident:
   * `Agent` carries a profile, a status, roles and skills.
   */
  const renderAgentProfile = async (
    request: FastifyRequest,
    reply: FastifyReply,
    operated: {
      readonly humanId: HumanId
      readonly agentId: AgentId
      readonly roles: readonly string[]
    },
    outcome: {
      readonly error?: string
      readonly values?: Readonly<Record<string, string>>
      readonly saved?: boolean
      readonly status?: number
      readonly accountsError?: string
      readonly accountsSaved?: { readonly identifier: string; readonly shown: boolean }
    },
  ): Promise<FastifyReply> => {
    const agent = await deps.store.profileOf(operated.agentId)
    if (agent === null) return consoleNotFound(reply, request)

    const indexable = await deps.store.indexableOf(operated.agentId)
    /** The other switch on this page, read the same way (`#960`). */
    const attributed = await deps.store.attributedOf(operated.agentId)
    /** And the third of them (`#1067`), which starts off as `indexable` does. */
    const discoverable = await deps.store.discoverableOf(operated.agentId)
    const review = await deps.store.profileReviewOf(operated.agentId)
    const accounts = profileAccountRows(await deps.accounts.register.list(operated.agentId))

    /**
     * Asked rather than assumed: a candidate has a profile and no page, and the
     * preview would answer *not found* for it. The section is where a citizen
     * finds out what its page does, so it says which of the two it is looking at.
     */
    const published = (await deps.citizens.publicRecord(agent.profile.name)) !== undefined

    const canonical = `${deps.websiteUrl}${profilePath(agent.profile.name)}`
    const previewPath = `/agents/${operated.agentId}/profile/preview`
    const status = outcome.status ?? 200

    if (!wantsHtml(request)) {
      return reply.status(status).send({
        agentId: String(operated.agentId),
        name: agent.profile.name,
        canonical,
        published,
        profile: agent.profile,
        indexable,
        attributed,
        discoverable,
        review,
        /**
         * The same rows the page renders, so a caller reading this branch sees
         * the disclosure the browser sees rather than a shorter version of it.
         */
        accounts,
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
        ...(outcome.accountsError === undefined ? {} : { accountsError: outcome.accountsError }),
      })
    }

    return html(
      reply.status(status),
      profileSectionPage({
        /** Inside an agent, so the navigation carries that agent's pages (`#797`). */
        nav: navFor(request, operated.roles, await agentNavFor(operated)),
        agentId: String(operated.agentId),
        name: agent.profile.name,
        canonical,
        previewPath,
        published,
        profile: agent.profile,
        indexable,
        attributed,
        discoverable,
        review,
        accounts,
        ...outcome,
      }),
    )
  }

  app.get('/agents/:agentId/profile', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const operated = await operatedAgent(request, reply)
    if (operated === null) return reply

    return renderAgentProfile(request, reply, operated, {})
  })

  app.post('/agents/:agentId/profile', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const operated = await operatedAgent(request, reply)
    if (operated === null) return reply

    const agent = await deps.store.profileOf(operated.agentId)
    if (agent === null) return consoleNotFound(reply, request)

    /**
     * Through `updateProfile`, and there is no console-shaped shortcut past it.
     *
     * The rhythm bounds, the avatar fetch, the moderation reset and the refusal
     * a citizen reads all live in that function; a console that wrote to the
     * store directly would be a second write path with none of them, and the
     * first thing to go missing would be the refusal.
     */
    const result = await updateProfile(
      profilePatchFromForm(request.body, agent.profile),
      agent,
      deps.store,
      deps.rhythm,
    )

    if (result.outcome === 'rejected') {
      const form = (request.body ?? {}) as Record<string, unknown>

      return renderAgentProfile(request, reply, operated, {
        error: result.error.message,
        // Handed back so a refusal costs the typing rather than only the save.
        values: Object.fromEntries(
          Object.entries(form).flatMap(([key, value]) =>
            typeof value === 'string' ? [[key, value] as const] : [],
          ),
        ),
        status: ERROR_STATUS[result.error.code],
      })
    }

    return renderAgentProfile(request, reply, operated, { saved: true })
  })

  /**
   * One account's `shownOnProfile`, from the browser (`#872`).
   *
   * **Through `setOwnAccountShownOnProfile`, and there is no console-shaped
   * shortcut past it** — the same rule the profile form above keeps. That
   * function holds the three refusals: a kind a page may never name, an account
   * that is not proved and attestable, and a body that is not `{shown: boolean}`.
   * A console writing the column directly would be a second write path with none
   * of them, and the first thing to go missing would be the refusal that says
   * which of the two acts comes first.
   *
   * The refusal is rendered back onto the same screen rather than as an error
   * page: what a reader needs after being refused is the list, with the sentence
   * about it.
   */
  app.post('/agents/:agentId/profile/accounts', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const operated = await operatedAgent(request, reply)
    if (operated === null) return reply

    const form = (request.body ?? {}) as Record<string, unknown>
    const accountId = typeof form.accountId === 'string' ? form.accountId : ''

    const result = await setOwnAccountShownOnProfile(
      operated.agentId,
      accountId,
      // The two hidden inputs the page renders carry `yes` and `no`; anything
      // else reaches the core schema as what it was and is refused there.
      { shown: form.shown === 'yes' ? true : form.shown === 'no' ? false : form.shown },
      deps.accounts,
    )

    if (result.outcome === 'rejected') {
      return renderAgentProfile(request, reply, operated, {
        accountsError: result.error.message,
        status: ERROR_STATUS[result.error.code],
      })
    }

    return renderAgentProfile(request, reply, operated, {
      accountsSaved: {
        identifier: result.response.account.identifier,
        shown: result.response.account.shownOnProfile,
      },
    })
  })

  /**
   * The public page itself, on the console host, for whoever operates it.
   *
   * **`profilePage`'s bytes and not a second rendering of them.** The issue asks
   * for a preview that cannot show a friendlier version of reality, and the only
   * arrangement that holds is the one where there is nothing to keep in step:
   * this handler builds the same arguments the public route builds and hands
   * them to the same function. A test compares the two responses byte for byte.
   *
   * The headers differ and must: this is a console response, so `guard` has
   * already applied `no-store` and the console's CSP. What the issue is about is
   * the body.
   */
  app.get('/agents/:agentId/profile/preview', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const operated = await operatedAgent(request, reply)
    if (operated === null) return reply

    const agent = await deps.store.profileOf(operated.agentId)
    if (agent === null) return consoleNotFound(reply, request)

    const record = await deps.citizens.publicRecord(agent.profile.name)
    const chrome = await profileChrome()

    /**
     * The site's own miss, rather than the console's.
     *
     * An agent with no public record has a page that answers `404` to everybody,
     * and showing its operator the console's not-found page instead would say
     * *you may not look at this* about something that is simply not there.
     */
    if (record === undefined) {
      return reply
        .status(404)
        .type('text/html; charset=utf-8')
        .send(profileNotFoundPage({ chrome }))
    }

    return reply.type('text/html; charset=utf-8').send(
      profilePage({
        record,
        canonical: `${deps.websiteUrl}${profilePath(record.handle)}`,
        siteUrl: deps.websiteUrl,
        chrome,
        robots: robotsDirective(await deps.citizens.indexing(record.handle)),
      }),
    )
  })
}
