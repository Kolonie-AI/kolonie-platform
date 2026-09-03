import { capabilitiesFromForm, type AgentId } from '@kolonie-ai/core'
import type { OperatorPageView } from '@kolonie-ai/db'
import type { FastifyInstance } from 'fastify'
import { answerAutonomyForm } from '../autonomy.js'
import {
  autonomyClosedPage,
  autonomyDonePage,
  autonomyFormPage,
  operatorAgentsPage,
} from '../autonomy-page.js'
import { operatorPageBody } from '../operator-page-body.js'
import { zoneFrom } from '../console/time.js'
import { shareAdditionError } from '../operator-shares.js'
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
   * what the write can reach: words on one thread the citizen itself opened,
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
      declaredRhythmMinutes: OperatorPageView['declaredRhythmMinutes']
    },
    /**
     * The reader's clock, for a share's expiry (`#1634`).
     *
     * **A parameter rather than a read in here**, because this helper is closed
     * over the route and not over one request. Every caller has its own, and
     * `zoneFrom` answers `UTC` where a door cannot tell.
     */
    zone: string,
    errors: { readonly shareError?: string } = {},
  ): Promise<string> =>
    operatorPageBody(deps, token, `/operator/page/${token}`, view, {
      zone,
      ...errors,
      /**
       * Where this door's threads are (`#1547`).
       *
       * **The token's own inbox**, which is the whole of the issue: the mailed
       * link and the console are two ways onto one renderer, and the only thing
       * that differs is the root the forms post to.
       */
      inboxBase: `/operator/page/${token}/inbox`,
      /**
       * The index, on this door only (`#1577`). The console has a navigation and
       * the person's own list of agents; a mailed link has neither.
       */
      agentsIndex: `/operator/page/${token}/agents`,
      /**
       * The share's forms post to this same route (`#1440`).
       *
       * **On the durable page and not only in the console**, which is `#1437`
       * frozen decision 1 in one line: the link that was refused a secret is now
       * the one that carries it, because the refusal is what nothing ever got
       * past.
       */
      ...(deps.operatorShares === undefined ? {} : { shareAction: `/operator/page/${token}` }),
    })

  /**
   * One address's agents, from any page it holds (`#1577`).
   *
   * **Before `/operator/page/:token` in the file and after it in the router's
   * matching**, which is the same thing said twice: Fastify prefers the static
   * segment, so `agents` cannot be mistaken for a token however a token is
   * shaped.
   *
   * A token that names no live page answers exactly as the per-agent page does
   * for one, so a stranger who guessed one learns nothing from the difference.
   */
  app.get('/operator/page/:token/agents', async (request, reply) => {
    const { token } = request.params as { token?: string }
    const held = token === undefined ? undefined : await autonomy.pages.agentsForToken?.(token)

    if (held === undefined || held.length === 0) {
      return reply.status(404).headers(CONSOLE_HEADERS).type('text/html').send(autonomyClosedPage())
    }

    return reply
      .headers(CONSOLE_HEADERS)
      .type('text/html')
      .send(
        operatorAgentsPage({
          agents: held.map((one) => ({
            agentName: one.agentName,
            token: one.token,
            issuedAt: one.issuedAt,
            lastOpenedAt: one.lastOpenedAt,
            waiting: one.waiting,
            shares: one.shares,
          })),
        }),
      )
  })

  app.get('/operator/page/:token', async (request, reply) => {
    const { token } = request.params as { token?: string }
    const view = token === undefined ? null : await autonomy.pages.open(token)

    if (view === null) {
      return reply.status(404).headers(CONSOLE_HEADERS).type('text/html').send(autonomyClosedPage())
    }

    return reply
      .headers(CONSOLE_HEADERS)
      .type('text/html')
      .send(await pageFor(token as string, view, zoneFrom(request.headers)))
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
   * branches. `answerOperatorThread` resolves the token and the thread id
   * together; `writeOperatorMessage` takes no id at all. A valid token cannot be
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
     * The operator writes into a shared entry, or hands it back (`#1440`).
     *
     * **`act` rather than a fourth `intent`**, because the two buttons are one
     * form: it is the same share and the same authorisation, and the difference
     * is only which of two things the person pressed. Guessing from whether the
     * box was filled would make *hand it back* mean *save an empty value* the
     * first time somebody clicked the wrong button.
     *
     * The token is what says whose citizen this is, on both branches — the store
     * resolves it together with the share id, so a valid token cannot be aimed
     * at another citizen's share.
     */
    if (submitted['act'] === 'write' || submitted['act'] === 'hand-back') {
      const shares = deps.operatorShares
      const shareId = typeof submitted['shareId'] === 'string' ? submitted['shareId'] : ''

      if (shares === undefined || shareId === '') {
        return reply
          .headers(CONSOLE_HEADERS)
          .type('text/html')
          .send(
            await pageFor(token as string, view, zoneFrom(request.headers), {
              shareError: 'That share is not one this page can reach any more.',
            }),
          )
      }

      if (submitted['act'] === 'hand-back') {
        await shares.handBack({ pageToken: token as string }, shareId)
        return reply
          .headers(CONSOLE_HEADERS)
          .type('text/html')
          .send(await pageFor(token as string, view, zoneFrom(request.headers)))
      }

      const addition = typeof submitted['addition'] === 'string' ? submitted['addition'] : ''
      const refusal = shareAdditionError(addition)

      if (refusal !== undefined) {
        return reply
          .headers(CONSOLE_HEADERS)
          .type('text/html')
          .send(
            await pageFor(token as string, view, zoneFrom(request.headers), {
              shareError: refusal,
            }),
          )
      }

      const written = await shares.write({ pageToken: token as string }, shareId, addition.trim())

      return reply
        .headers(CONSOLE_HEADERS)
        .type('text/html')
        .send(
          await pageFor(
            token as string,
            view,
            zoneFrom(request.headers),
            written.outcome === 'closed'
              ? { shareError: 'That share ended before this was saved. Nothing was written.' }
              : {},
          ),
        )
    }

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
          .send(await pageFor(token as string, view, zoneFrom(request.headers)))
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

    /*
     * `intent === 'note'` and the `answerOperatorThread` fallthrough stood here
     * until `#1547`. They were the two message forms the durable page used to
     * render — the note box (`#239`) and the three declarations with their
     * *Explain instead* field (`#1093`) — and the page renders neither now.
     *
     * Both acts survive at this token's own inbox, which is the one place an
     * operator writes: the note is the inbox's compose, and the declarations are
     * the buttons beside the reply box. One writer, reached two ways, which is
     * what `#1547` is for.
     *
     * **What is left on this route is what is not a message**: a shared entry
     * written into or handed back, and the Telegram binding. Both are above.
     */
    return reply
      .headers(CONSOLE_HEADERS)
      .type('text/html')
      .send(await pageFor(token as string, view, zoneFrom(request.headers)))
  })
}
