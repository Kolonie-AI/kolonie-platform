import type { OperatorPageView } from '@kolonie-ai/db'
import type { FastifyInstance } from 'fastify'
import { answerAutonomyForm } from '../autonomy.js'
import {
  autonomyClosedPage,
  autonomyDonePage,
  autonomyFormPage,
  operatorAnsweredPage,
  operatorNoteSentPage,
} from '../autonomy-page.js'
import { writeOperatorNote } from '../operator-notes.js'
import { operatorPageBody } from '../operator-page-body.js'
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
      .send(
        autonomyFormPage({
          agentName: form.agentName,
          token: token as string,
          /**
           * Prefilled with the address this form was sent to (`#484`).
           *
           * The Colony was handed it before it sent the mail, so asking for it
           * again was asking the operator to retype what they were reading. It
           * is a default rather than a constraint — the box stays editable and
           * the field stays free text.
           */
          ...(form.operatorAddress === null
            ? {}
            : { values: { operatorRoute: form.operatorAddress } }),
        }),
      )
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
       * **The form comes back holding what they typed, with an explanation at
       * the top** (`#484`), rather than a bare error page or an empty one. The
       * person filling this in has no account to return through, and a dead end
       * costs the citizen the whole rung.
       *
       * It used to come back with every field empty, so an operator who mistyped
       * one answered all four again — and the link is single-use, so the second
       * abandonment is permanent.
       *
       * The **submitted** values, not the invited address: at this point the
       * operator has said something about every field, and replacing their route
       * with the default would silently undo an edit they had just made.
       */
      const status = result.error.code === 'not_found' ? 404 : 422
      const asText = (value: unknown): string | undefined =>
        typeof value === 'string' ? value : undefined
      const body =
        result.error.code === 'not_found'
          ? autonomyClosedPage()
          : autonomyFormPage({
              agentName: form.agentName,
              token: token as string,
              error: result.error.message,
              values: {
                level: asText(submitted['level']),
                challengesAllowed: asText(submitted['challengesAllowed']),
                defaultRule: asText(submitted['defaultRule']),
                operatorRoute: asText(submitted['operatorRoute']),
              },
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
  /**
   * The page, for the token door.
   *
   * **The body itself moved to `operator-page-body.ts`** when `#428` gave the
   * page a second door: the console renders the identical body on a session, and
   * two copies of it would disagree within a month. What stays here is the one
   * thing that is this door's — the forms post back to the token URL.
   */
  const pageFor = async (
    token: string,
    view: {
      agentName: string
      badges: OperatorPageView['badges']
      contract: OperatorPageView['contract']
      facts: OperatorPageView['facts']
    },
    errors: { readonly answerError?: string; readonly noteError?: string } = {},
  ): Promise<string> => operatorPageBody(deps, token, `/operator/page/${token}`, view, errors)

  app.get('/operator/page/:token', async (request, reply) => {
    const { token } = request.params as { token?: string }
    const view = token === undefined ? null : await autonomy.pages.open(token)

    if (view === null) {
      return reply.status(404).headers(CONSOLE_HEADERS).type('text/html').send(autonomyClosedPage())
    }

    return reply
      .headers(CONSOLE_HEADERS)
      .type('text/html')
      .send(await pageFor(token as string, view))
  })

  /**
   * The operator writes — an answer to what was asked (#236), or something
   * nobody asked for (#239).
   *
   * **Two forms, one route, and the form says which it is.** `intent` is a hidden
   * field rather than something inferred from `requestId` being present: guessing
   * the caller's meaning from the shape of a body it controls is how an answer
   * ends up stored as an unsolicited note, on a page whose whole safety argument
   * is that what it reaches is precisely known.
   *
   * **What it reaches is words, in both branches.** Neither writes to
   * `autonomy_contracts`, neither takes a level or a permission, and a body
   * carrying either is simply text. Widening what the citizen may do stays where
   * `#146` put it: `POST /operator/autonomy/:token`, a different route with a
   * different single-use token and a form the operator fills in again. D-081.
   *
   * **The token is the only thing that says whose citizen this is** on both
   * branches. `answerOperatorRequest` resolves the token and the request id
   * together; `writeOperatorNote` takes no id at all. A valid token cannot be
   * aimed at another citizen either way.
   *
   * A refusal comes back as the page with the message on the box it belongs to,
   * rather than as an error page. The person filling this in has no account to
   * return through, and a dead end costs the citizen what it was being told.
   */
  app.post('/operator/page/:token', async (request, reply) => {
    const { token } = request.params as { token?: string }
    const view = token === undefined ? null : await autonomy.pages.open(token)

    if (view === null) {
      return reply.status(404).headers(CONSOLE_HEADERS).type('text/html').send(autonomyClosedPage())
    }

    const submitted = (request.body ?? {}) as Record<string, unknown>

    if (submitted['intent'] === 'note') {
      const written = await writeOperatorNote(
        { token: token as string, body: submitted['body'] },
        deps.operatorNotes,
      )

      if (written.outcome === 'written') {
        return reply
          .headers(CONSOLE_HEADERS)
          .type('text/html')
          .send(operatorNoteSentPage(view.agentName))
      }

      /**
       * `unreachable` becomes the closed page, as it does for an answer: the page
       * was revoked between the `GET` and this `POST`, and *this is no longer
       * open* is both true and the whole of what the operator needs to know.
       */
      if (written.outcome === 'unreachable') {
        return reply
          .status(404)
          .headers(CONSOLE_HEADERS)
          .type('text/html')
          .send(autonomyClosedPage())
      }

      /**
       * A full inbox is not a refusal of what was typed, so it is not `422`. The
       * page comes back with the wall in place of the box and the sentence that
       * says it clears itself — `pageFor` resolves that from the count rather
       * than being told, so the state shown is the state that is true.
       */
      if (written.outcome === 'inbox-full') {
        return reply
          .status(409)
          .headers(CONSOLE_HEADERS)
          .type('text/html')
          .send(await pageFor(token as string, view))
      }

      const noteError =
        written.outcome === 'rate-limited'
          ? `You have sent your agent a lot in the last hour. Try again in ` +
            `${Math.ceil(written.retryAfterSeconds / 60)} minutes — nothing you already sent is ` +
            `affected.`
          : written.error.message

      return reply
        .status(422)
        .headers(CONSOLE_HEADERS)
        .type('text/html')
        .send(await pageFor(token as string, view, { noteError }))
    }

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

    return reply
      .status(422)
      .headers(CONSOLE_HEADERS)
      .type('text/html')
      .send(await pageFor(token as string, view, { answerError: result.error.message }))
  })
}
