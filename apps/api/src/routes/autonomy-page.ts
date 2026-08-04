import type { FastifyInstance } from 'fastify'
import { answerAutonomyForm } from '../autonomy.js'
import {
  autonomyClosedPage,
  autonomyDonePage,
  autonomyFormPage,
  operatorAnsweredPage,
  operatorDurablePage,
} from '../autonomy-page.js'
import { answerOperatorRequest } from '../operator-requests.js'
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

  /**
   * The durable page (#257), and since `#236` the one write it accepts.
   *
   * **`GET` shows, `POST` answers one open question, and there is no third thing.**
   * `#146`'s argument — a leaked link is an embarrassment rather than a compromise —
   * used to rest on there being nothing behind the link to *do*. It now rests on
   * what the write can reach: words on one exchange the citizen itself opened,
   * never a permission. See the comment on `operatorDurablePage` and D-081.
   *
   * A revoked, unknown or never-issued token answers identically on both methods,
   * so a stranger who guessed one cannot tell that a citizen took a real page away.
   */
  app.get('/operator/page/:token', async (request, reply) => {
    const { token } = request.params as { token?: string }
    const view = token === undefined ? null : await autonomy.pages.open(token)

    if (view === null) {
      return reply.status(404).headers(CONSOLE_HEADERS).type('text/html').send(autonomyClosedPage())
    }

    const exchange = await deps.operatorRequests.store.openExchangeForToken(token as string)

    return reply
      .headers(CONSOLE_HEADERS)
      .type('text/html')
      .send(
        operatorDurablePage({
          agentName: view.agentName,
          // The wall (`#241`), resolved with the page's own subject: the token
          // names the agent, and nothing here takes an id from the caller.
          badges: view.badges,
          contract: view.contract,
          token: token as string,
          ...(exchange === undefined
            ? {}
            : {
                exchange: {
                  requestId: String(exchange.requestId),
                  taskTitle: exchange.taskTitle,
                  messages: exchange.messages,
                },
              }),
        }),
      )
  })

  /**
   * The operator answers (#236).
   *
   * **The token is the only thing that says whose exchange this is.** Nothing here
   * takes an agent id or trusts the `requestId` on its own: `answerOperatorRequest`
   * resolves both together, so a valid token cannot be pointed at another citizen's
   * exchange.
   *
   * A refusal — an empty box, or a credential — comes back as the page with the
   * message at the top and the exchange still there, rather than as an error page.
   * The person filling this in has no account to return through, and a dead end
   * costs the citizen its answer.
   */
  app.post('/operator/page/:token', async (request, reply) => {
    const { token } = request.params as { token?: string }
    const view = token === undefined ? null : await autonomy.pages.open(token)

    if (view === null) {
      return reply.status(404).headers(CONSOLE_HEADERS).type('text/html').send(autonomyClosedPage())
    }

    const submitted = (request.body ?? {}) as Record<string, unknown>
    const result = await answerOperatorRequest(
      {
        token: token as string,
        body: { requestId: submitted['requestId'], body: submitted['body'] },
      },
      deps.operatorRequests,
    )

    if (result.outcome === 'answered') {
      return reply
        .headers(CONSOLE_HEADERS)
        .type('text/html')
        .send(operatorAnsweredPage(view.agentName))
    }

    /**
     * `unreachable` becomes the closed page and not a refusal, deliberately: the
     * exchange being gone means the citizen closed it or took the page away, and
     * *"this is no longer open"* is both true and the whole of what the operator
     * needs to know.
     */
    if (result.outcome === 'unreachable') {
      return reply.status(404).headers(CONSOLE_HEADERS).type('text/html').send(autonomyClosedPage())
    }

    const exchange = await deps.operatorRequests.store.openExchangeForToken(token as string)

    return reply
      .status(422)
      .headers(CONSOLE_HEADERS)
      .type('text/html')
      .send(
        operatorDurablePage({
          agentName: view.agentName,
          badges: view.badges,
          contract: view.contract,
          token: token as string,
          answerError: result.error.message,
          ...(exchange === undefined
            ? {}
            : {
                exchange: {
                  requestId: String(exchange.requestId),
                  taskTitle: exchange.taskTitle,
                  messages: exchange.messages,
                },
              }),
        }),
      )
  })
}
