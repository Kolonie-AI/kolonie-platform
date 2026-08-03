import type { FastifyInstance } from 'fastify'
import { answerAutonomyForm } from '../autonomy.js'
import { autonomyClosedPage, autonomyDonePage, autonomyFormPage } from '../autonomy-page.js'
import { CONSOLE_HEADERS } from '../console/html.js'
import type { RouteDependencies } from './dependencies.js'

/**
 * The operator's form (#146).
 *
 * **Host routes, not under `/v1/`.** `AGENTS.md` §3 says every public *endpoint*
 * lives under the version prefix, and these are pages rather than endpoints: a
 * person clicks them out of a mail, and a URL with an API version in it is a URL
 * that breaks when the API's version moves for reasons that have nothing to do
 * with this form. The console made the same call for the same reason.
 *
 * **Unauthenticated by design, and the link is the whole credential.** There is
 * no account to have. What keeps that safe is that the link is single-use,
 * expiring, scoped to one agent, and — the load-bearing part — that **nothing
 * behind it can be read**: the page shows the citizen's name and a blank form,
 * never the contract, never the address, never anything about the citizen's
 * standing. A leaked link lets a stranger answer one form once, which the
 * operator would then see was wrong and could replace.
 */
export function registerAutonomyPageRoutes(app: FastifyInstance, deps: RouteDependencies): void {
  const { autonomy } = deps

  app.get('/operator/autonomy/:token', async (request, reply) => {
    const { token } = request.params as { token?: string }
    const form = token === undefined ? null : await autonomy.store.openForm(token)

    if (form === null) {
      // 404 for all three closed states. See `autonomyClosedPage`.
      return reply.status(404).headers(CONSOLE_HEADERS).type('text/html').send(autonomyClosedPage())
    }

    return reply
      .headers(CONSOLE_HEADERS)
      .type('text/html')
      .send(autonomyFormPage({ agentName: form.agentName, token: token as string }))
  })

  app.post('/operator/autonomy/:token', async (request, reply) => {
    const { token } = request.params as { token?: string }
    const form = token === undefined ? null : await autonomy.store.openForm(token)

    if (form === null) {
      return reply.status(404).headers(CONSOLE_HEADERS).type('text/html').send(autonomyClosedPage())
    }

    const submitted = (request.body ?? {}) as Record<string, unknown>
    const result = await answerAutonomyForm(
      token as string,
      {
        level: submitted['level'],
        // A form posts strings; the contract holds a boolean. Converted here
        // rather than in the schema, so the schema stays the shape the MCP and
        // JSON callers use and only the HTML surface knows about radio values.
        challengesAllowed: submitted['challengesAllowed'] === 'yes',
        defaultRule: submitted['defaultRule'],
        operatorRoute: submitted['operatorRoute'],
      },
      autonomy,
    )

    if (result.outcome === 'rejected') {
      /**
       * **The form comes back filled with nothing and an explanation at the top**,
       * rather than a bare error page. The person filling this in has no account
       * to return through, and a dead end costs the citizen the whole rung.
       */
      const status = result.error.code === 'not_found' ? 404 : 422
      const body =
        result.error.code === 'not_found'
          ? autonomyClosedPage()
          : autonomyFormPage({
              agentName: form.agentName,
              token: token as string,
              error: result.error.message,
            })

      return reply.status(status).headers(CONSOLE_HEADERS).type('text/html').send(body)
    }

    return reply.headers(CONSOLE_HEADERS).type('text/html').send(autonomyDonePage(form.agentName))
  })
}
