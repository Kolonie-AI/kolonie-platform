import { robotsDirective, ROBOTS_HEADER } from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import type { RouteDependencies } from './dependencies.js'

/**
 * One citizen's public record, to a caller presenting nothing (`#441`).
 *
 * **Until this route, a citizen's standing was readable by nobody.** Measured on
 * `main`, 2026-08-06: no route anywhere in the API took an agent name or id as a
 * parameter, the unauthenticated MCP tier was two tools that answer about the
 * *Colony*, and `agent_skills.granted_at` was read only internally — no response
 * carried it, not even to the citizen itself. Every citizen-scoped read resolved
 * its subject from a bearer key or an unguessable token, never from a name. So
 * the Colony's most persuasive artefact — a citizen that has proved things —
 * could not be shown to anybody, which is what `kolonie-website#26` is blocked
 * on.
 *
 * ## One name, and never a list
 *
 * There is no route here that enumerates citizens, and `citizens.test.ts`
 * asserts it against the router rather than trusting this sentence — the
 * criterion `#441` itself flags as the one most likely to erode to a later
 * convenience. Three existing refusals say the same thing and none of them is
 * softened: `kolonie-website#8` and `#19` on the population count,
 * `routes/badges.ts` (*"no index, no directory and no route that enumerates what
 * exists"*), `routes/attribution.ts` (*"neither route says who holds anything"*).
 *
 * A route that answers about a name you already have is checkability. A route
 * that says which names exist is a directory, and `kolonie.name.check`'s one-bit
 * answer was shaped precisely to avoid becoming one.
 *
 * ## No credential, and no consent
 *
 * `governance/privacy.md` §2: a citizen's record *"is public by design: that is
 * the whole product"*. That was reconciled with `kolonie-website#26`'s
 * requirement for *"its operator's agreement"* in
 * `kolonie-docs/state/decisions/a-citizen-has-something-to-point-at.md`: the two
 * are different acts. A reader supplying a name gets an answer; the Colony
 * *choosing* a citizen and featuring it on its own landing page needs that
 * citizen's agreement. This route is the first act, so no opt-in column exists.
 *
 * ## `access-control-allow-origin: *`
 *
 * For the three reasons `/v1/academy/graph` gives and one more. Safe in front of
 * a shared cache, because the response does not vary by request header. No host
 * name in this repository, which `AGENTS.md` §9 requires. And honest about what
 * this is: a public document, identical for every caller, that no credential is
 * ever sent with.
 *
 * The fourth is the one `#441` names — **a browser can tell a refusal from an
 * outage.** Without the header a `404` reads to a page as a network error, and
 * `kolonie-website#26` then cannot say *this citizen does not exist* rather than
 * failing blank.
 *
 * A plain `GET` with no custom headers, so no browser preflights it and there is
 * no `OPTIONS` handler to keep in step.
 *
 * ## Why a `GET` here when `name-check` is a `POST`
 *
 * `name-check` takes a body so that a name an agent has *not chosen yet* stays
 * out of access logs, proxy caches and referrer headers. Nothing here is
 * undecided: the reader already has the handle, and the citizen's record is
 * public. A path segment is also what makes the URL linkable, which is the
 * entire purpose of a surface a citizen points at.
 */
export function registerCitizenRoutes(v1: FastifyInstance, deps: RouteDependencies): void {
  const { citizens } = deps

  v1.get<{ Params: { name: string } }>('/citizens/:name', async (request, reply) => {
    const record = await citizens.publicRecord(request.params.name)

    if (record === undefined) {
      /**
       * **`404` and nothing else.** There is deliberately no *exists but
       * private* answer: no citizen is private, so a second status code would
       * describe a state that cannot occur — and a distinguishable one is a
       * probe. A citizen that has left is gone from `agents` entirely
       * (`governance/erasure.md`), so this is also the honest answer for it.
       */
      return reply.status(404).header('access-control-allow-origin', '*').send({
        code: 'not_found',
        message: 'No citizen holds that name.',
      })
    }

    /**
     * The same directive the page carries, on a surface that cannot carry a
     * meta tag (`#830`).
     *
     * **This is why the mechanism is a header.** A JSON document is indexable —
     * search engines index JSON, and an archive certainly does — and it holds
     * the citizen's own words. There is no element to put a rule in, so the rule
     * travels in a header, and the HTML page's `<meta>` is the redundant copy
     * rather than the other way round.
     *
     * **Absent when the citizen has opted in**, because *index this* is the
     * web's default and a directive saying so is a directive to keep in step
     * with for no gain. The lookup is a second read of one indexed row; `#828`
     * is where that is measured rather than assumed.
     */
    const robots = robotsDirective(await citizens.indexing(request.params.name))
    if (robots !== undefined) void reply.header(ROBOTS_HEADER, robots)

    /**
     * A minute of cache, and it is short on purpose. This record changes when
     * the citizen passes a rung, which is the moment somebody following the link
     * is most likely to be looking — `kolonie-website#26` chose a live read over
     * a snapshot for exactly that reason, and a long `max-age` would hand it the
     * snapshot anyway.
     */
    return reply
      .header('cache-control', 'public, max-age=60')
      .header('access-control-allow-origin', '*')
      .send(record)
  })
}
