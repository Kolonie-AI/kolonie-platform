import { ERROR_STATUS, SubmitDropSchema } from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import { BEARER_SCHEME, bearerToken } from '../authentication.js'
import { CONSOLE_HEADERS } from '../console/html.js'
import { createDrop, readDrop } from '../operator-drops.js'
import { dropClosedPage, dropDonePage, dropFormPage } from '../operator-drop-page.js'
import { callerFor } from './authenticated.js'
import type { RouteDependencies } from './dependencies.js'

/**
 * The third channel (`#410`): where an operator puts something secret.
 *
 * Two doors, and they are deliberately not the same kind of thing.
 *
 * **The host routes** are for a person with a link and no account, and they live
 * outside `/v1/` for the reason `registerAutonomyPageRoutes` records: a URL with
 * an API version in it breaks when the API's version moves for reasons that have
 * nothing to do with the person holding it.
 *
 * **The `/v1` routes** are the citizen's, authenticated as every other one is —
 * and the read is authenticated *twice over by the same header*, exactly as the
 * vault's write is, because the plaintext key is what a credential ends up sealed
 * under. See the comment at the top of `routes/vault.ts`; the reasoning is
 * identical and is not restated here.
 */
export function registerOperatorDropPageRoutes(
  app: FastifyInstance,
  deps: RouteDependencies,
): void {
  const { drops } = deps

  /**
   * **`GET` shows the ask and an empty field, and shows nothing about the
   * citizen beyond its name.** A leaked link is an embarrassment rather than a
   * disclosure — `#146`'s standard for the autonomy form, held here.
   *
   * Every closed state answers 404 with the same page. The channel is only worth
   * having if a guessed link cannot be used to find out that somebody's agent
   * exists.
   */
  app.get('/operator/drop/:token', async (request, reply) => {
    const { token } = request.params as { token?: string }
    const view = token === undefined || drops === undefined ? null : await drops.view(token)

    if (view === null) {
      return reply.status(404).headers(CONSOLE_HEADERS).type('text/html').send(dropClosedPage())
    }

    return reply
      .headers(CONSOLE_HEADERS)
      .type('text/html')
      .send(dropFormPage({ ...view, token: token as string }))
  })

  app.post('/operator/drop/:token', async (request, reply) => {
    const { token } = request.params as { token?: string }

    if (token === undefined || drops === undefined) {
      return reply.status(404).headers(CONSOLE_HEADERS).type('text/html').send(dropClosedPage())
    }

    /**
     * The view is taken **before** the submission, so a refusal can come back as
     * the same form with an explanation rather than as a dead end. The person
     * filling this in has no account to return through, and a dead end costs the
     * citizen the thing it asked for.
     */
    const view = await drops.view(token)
    if (view === null) {
      return reply.status(404).headers(CONSOLE_HEADERS).type('text/html').send(dropClosedPage())
    }

    const parsed = SubmitDropSchema.safeParse(request.body ?? {})

    if (!parsed.success) {
      return reply
        .status(422)
        .headers(CONSOLE_HEADERS)
        .type('text/html')
        .send(
          dropFormPage({
            ...view,
            token,
            error: 'That box needs something in it, and not more than a few kilobytes of it.',
          }),
        )
    }

    const result = await drops.submit(token, parsed.data.value)

    if (result.outcome === 'accepted') {
      return reply.headers(CONSOLE_HEADERS).type('text/html').send(dropDonePage(view.agentName))
    }

    if (result.outcome === 'closed') {
      return reply.status(404).headers(CONSOLE_HEADERS).type('text/html').send(dropClosedPage())
    }

    /**
     * The two vault refusals are told to the operator **before** anything is
     * kept, and they are told in terms a person can act on: neither is their
     * fault and both are things only the citizen can clear.
     */
    const error =
      result.outcome === 'key-taken'
        ? `${view.agentName} already keeps something under that name, and the Colony will not ` +
          'write over it. Nothing has been stored. Your agent has to clear it or ask again under ' +
          'another name.'
        : `${view.agentName} has no room left in its own store. Nothing has been stored, and ` +
          'this is something only your agent can fix.'

    return reply
      .status(409)
      .headers(CONSOLE_HEADERS)
      .type('text/html')
      .send(dropFormPage({ ...view, token, error }))
  })
}

export function registerOperatorDropRoutes(v1: FastifyInstance, deps: RouteDependencies): void {
  const { store, drops } = deps

  v1.post('/operator/drops', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const result = await createDrop(caller.id, request.body, deps)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.status(201).send(result.response)
  })

  /**
   * What is waiting, never with a value.
   *
   * **Reading is a separate call because reading is destructive.** A listing that
   * spent every drop it named would make *is anything waiting for me* an act with
   * a consequence, and an agent that looked twice would lose what it found.
   */
  v1.get('/operator/drops', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    if (drops === undefined) return reply.send({ drops: [] })

    return reply.send({ drops: await drops.list(caller.id) })
  })

  v1.post('/operator/drops/:dropId/read', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    const token = bearerToken(request.headers.authorization)
    if (token === undefined) {
      return reply
        .status(ERROR_STATUS.unauthorized)
        .header('www-authenticate', BEARER_SCHEME)
        .send({ code: 'unauthorized', message: 'Present your API key as a Bearer token.' })
    }

    const { dropId } = request.params as { dropId?: string }
    const result = await readDrop(caller.id, dropId, token, deps)

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.send(result.response)
  })
}
