import { capabilitiesFromForm, type AgentId } from '@kolonie-ai/core'
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
import { answerOperatorRequest, isWaitingOnTheOperator } from '../operator-requests.js'
import { deepLinkFor } from '../operator-telegram.js'
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
/**
 * A deep link for this citizen, or `undefined` (`#793`).
 *
 * **`undefined` for every reason there is**, and the caller treats them the same:
 * no bot configured, or a mint that failed. The offer is a convenience beside
 * something that has already succeeded, so a missing one is silence rather than
 * an error — and the durable page will offer it again.
 */
async function telegramOfferFor(
  deps: RouteDependencies,
  agentId: AgentId,
): Promise<string | undefined> {
  const desk = deps.telegram
  if (desk === undefined) return undefined

  const issued = await desk.store.issueStart(agentId)
  return deepLinkFor(desk.bot, issued.token)
}

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
          action: `/operator/autonomy/${token as string}`,
          // The operator's other agents, each named and none ticked (`#514`).
          alsoFor: form.alsoFor.map((sibling) => ({
            agentId: String(sibling.agentId),
            name: sibling.name,
          })),
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
    /**
     * The ticked siblings (`#514`).
     *
     * A form posts one value as a string and several as an array, so both shapes
     * arrive here and neither is an error. What is *permitted* is decided by the
     * store, inside the transaction that records the answer — these ids come from
     * an unauthenticated page and are a request, never an instruction.
     */
    const alsoFor = (Array.isArray(submitted['alsoFor'])
      ? submitted['alsoFor']
      : submitted['alsoFor'] === undefined
        ? []
        : [submitted['alsoFor']]
    ).filter((value): value is string => typeof value === 'string') as unknown as readonly AgentId[]

    const result = await answerAutonomyForm(
      token as string,
      {
        level: submitted['level'],
        // A form posts strings; the contract holds a boolean. Converted here
        // rather than in the schema, so the schema stays the shape the MCP and
        // JSON callers use and only the HTML surface knows about radio values.
        challengesAllowed: submitted['challengesAllowed'] === 'yes',
        capabilities: capabilitiesFromForm(submitted),
        defaultRule: submitted['defaultRule'],
        operatorRoute: submitted['operatorRoute'],
      },
      autonomy,
      alsoFor,
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
              action: `/operator/autonomy/${token as string}`,
              error: result.error.message,
              // The ticks survive the retry, for the reason every other field's
              // value does (`#484`): the link is single-use, so friction here is
              // spent rather than deferred.
              alsoFor: form.alsoFor.map((sibling) => ({
                agentId: String(sibling.agentId),
                name: sibling.name,
              })),
              ticked: alsoFor.map(String),
              values: {
                level: asText(submitted['level']),
                challengesAllowed: asText(submitted['challengesAllowed']),
                capabilities: capabilitiesFromForm(submitted),
                defaultRule: asText(submitted['defaultRule']),
                operatorRoute: asText(submitted['operatorRoute']),
              },
            })

      return reply.status(status).headers(CONSOLE_HEADERS).type('text/html').send(body)
    }

    /**
     * The Telegram offer, made once, at the moment the form is safely recorded
     * (`#793`).
     *
     * **Minted here rather than rendered on the form**, because pressing it
     * navigates away and the form's own link is single-use — an offer beside a
     * half-filled form is a way to lose the answer entirely. A failure to mint is
     * not a failure of the answer, which is already recorded, so the offer is
     * simply absent and the durable page will make it again.
     */
    const telegramLink = await telegramOfferFor(deps, form.agentId)

    return reply
      .headers(CONSOLE_HEADERS)
      .type('text/html')
      .send(autonomyDonePage(form.agentName, String(form.agentId), telegramLink))
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
      agentId: OperatorPageView['agentId']
      agentName: string
      badges: OperatorPageView['badges']
      contract: OperatorPageView['contract']
      facts: OperatorPageView['facts']
      declaredRhythmHours: OperatorPageView['declaredRhythmHours']
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

    /**
     * The operator asks for a Telegram link (`#793`).
     *
     * **A third `intent` and not a third route**, for the reason the second one
     * exists: what this page reaches is precisely known, and guessing the
     * caller's meaning from the shape of a body it controls is how one action
     * ends up performed as another. What this one reaches is a *new row in
     * `operator_telegram_starts`* and nothing else — no permission, no contract,
     * no message to the citizen. D-081 is unamended.
     *
     * **A redirect rather than a rendered link**, so the whole gesture is one
     * press. The payload is minted for this request and exists in no page that
     * was merely open.
     */
    if (submitted['intent'] === 'telegram') {
      const desk = deps.telegram

      if (desk === undefined) {
        // The button is not rendered without a desk, so this is a stale page or
        // a hand-made post. The page itself is the honest answer.
        return reply
          .status(409)
          .headers(CONSOLE_HEADERS)
          .type('text/html')
          .send(await pageFor(token as string, view))
      }

      const issued = await desk.store.issueStartForPage(token as string)

      // The page was revoked between the `GET` and this `POST`. Same answer as
      // every other write here gives for that: this is no longer open.
      if (issued === undefined) {
        return reply
          .status(404)
          .headers(CONSOLE_HEADERS)
          .type('text/html')
          .send(autonomyClosedPage())
      }

      /**
       * `303` and not `302`, because this is a `POST`: it is what turns the
       * operator's next step into a `GET` of the deep link rather than a
       * re-post of this form when they press back.
       */
      return reply.status(303).redirect(deepLinkFor(desk.bot, issued.token))
    }

    if (submitted['intent'] === 'note') {
      /**
       * Whether a question of the citizen's is still open (`#564`).
       *
       * **Read here rather than assumed**, because the confirmation page has to
       * say so: a note leaves an open question open, and a person who thought
       * they had just answered one finds out on the page that says *sent*
       * instead of at their agent's sixth blocked run.
       */
      const stillWaiting = isWaitingOnTheOperator(
        await deps.operatorRequests.store.exchangesForToken(token as string),
      )

      const written = await writeOperatorNote(
        { token: token as string, body: submitted['body'] },
        deps.operatorNotes,
      )

      if (written.outcome === 'written') {
        return reply
          .headers(CONSOLE_HEADERS)
          .type('text/html')
          .send(operatorNoteSentPage(view.agentName, stillWaiting))
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
        /**
         * **One of the two arrives, never both** (`#1093`). A fixed control posts
         * `kind` and the Colony supplies the sentence; the explanation box posts
         * `body`. Both fields are read off the form rather than one of them being
         * inferred, and the schema refuses a submission carrying the pair — which
         * is the same rule as `intent` above, for the same reason.
         */
        body: {
          requestId: submitted['requestId'],
          body: submitted['body'],
          kind: submitted['kind'],
        },
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
