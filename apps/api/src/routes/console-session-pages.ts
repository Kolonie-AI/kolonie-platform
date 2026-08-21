import { handoverNotice } from '@kolonie-ai/core'
import { ERROR_STATUS, AccountSlotIdSchema } from '@kolonie-ai/core'
import type { FastifyInstance, FastifyReply } from 'fastify'
import {
  CHECK_YOUR_MAIL,
  KEY_MINT_CONFIRM_PATH,
  RequestLinkSchema,
  SIGN_IN_CALLBACK_PATH,
  SIGN_IN_REDEEM_PATH,
  redeemKeyMint,
  redeemSignIn,
  requestKeyMint,
  requestSignIn,
} from '../console.js'
import {
  keyMintedPage,
  keyPage,
  notFoundPage,
  dashboardPage,
  handoverPage,
  sessionsPage,
  signInPage,
} from '../console/html.js'
import { zoneFrom } from '../console/time.js'
import { questsPage } from '../console/sponsor.js'
import { clientIp } from '../client-ip.js'
import { cookieValue, sessionCookie } from './authenticated.js'

import { SESSION_COOKIE } from './console.js'
import { mintOauthState } from '../humans/auth0.js'
import {
  OAUTH_CONNECT_COOKIE,
  OAUTH_STATE_COOKIE,
  OFFERED_PROVIDERS,
  browserFamily,
  clearedOauthStateCookie,
  clearedSessionCookie,
  coarseLocation,
  oauthStateCookie,
  stateMatches,
} from '../humans/humans.js'
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
import { html, navFor, wantsHtml } from './console-shared.js'
import { FILL_NOTICE, SLOT_CLOSED_NOTICE, SLOT_NOTICE } from './console-shared.js'

import type { ConsolePageContext } from './console-page-context.js'

/**
 * Split out of `console-pages.ts` by `#1500`'s sibling `#1498`, which is a move
 * and not a rewrite — every route body below is the bytes that were in that
 * file. The closures they capture arrive as `ctx`, which is the shape
 * `registerSponsorPages` in that file already used for the quest routes.
 */
export function registerConsoleSessionPages(
  app: FastifyInstance,
  deps: RouteDependencies,
  ctx: ConsolePageContext,
): void {
  const { guard, providers, person, caller, signInRequired } = ctx

  /**
   * The console, whole.
   *
   * Signed out it is the sign-in page and nothing else — no public listing of
   * quests, no sponsor directory, no statistics. Signed in it is what this
   * identity has written.
   */
  app.get('/', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    /**
     * A person before a citizen, because only one of the two can be true and
     * this is the cheaper question (`#425`).
     *
     * Without this branch somebody who had just signed in with a provider would
     * be shown the sign-in page again — `caller` resolves an agent, a person is
     * not one, and a successful sign-in would read as a failed one. `#427`
     * turns this page into the dashboard.
     */
    const signedIn = await person(request)
    if (signedIn !== null) {
      const operated = await deps.humans.store.operated(signedIn.human.id)
      const code = await deps.humans.store.liveCode(signedIn.human.id)
      /**
       * **No row is *the person themselves* any more** (`#578`).
       *
       * This marked the `sponsor-*` identity the console minted, which arrived
       * in `operated` with the rest and would otherwise have sat there under a
       * generated name with nothing saying it was them. Nothing mints one now:
       * every row here is an agent the person paired deliberately and already
       * knows the name of, so the column had nothing left to disclose.
       */
      /**
       * **What each of them is waiting on** (`#512`).
       *
       * *Which of my twelve is stuck on something I can fix* is the question
       * this page could not answer at all, and the one that makes it worth
       * opening twice. It is the agent's **own** standing hint, computed by the
       * one function that computes it — never a second answer — and asking for
       * it spends nothing: `facing` claims no slot, marks no badge told and uses
       * up no general sentence.
       *
       * One call per agent, in parallel. It is a page load rather than a hot
       * path, and the alternative — a single query reimplementing fourteen
       * conditions — is the second implementation this is written to avoid.
       */
      const waiting = await Promise.all(
        operated.map(async (agent) => (await deps.hints.facing(agent.id))?.code ?? null),
      )
      const agents = operated.map((agent, index) => ({
        id: String(agent.id),
        name: agent.name,
        citizenship: agent.citizenship,
        skillsHeld: agent.skillsHeld,
        lastSeenAt: agent.lastSeenAt,
        platform: agent.platform,
        model: agent.model,
        lastEarned: agent.lastEarned ?? null,
        waitingOn: waiting[index] ?? null,
      }))

      /**
       * The maintainer's link, and **absent rather than disabled** (`#486`).
       *
       * A greyed-out link tells a person a surface exists that they may not
       * have, which is a fact about the Colony's shape that a stranger who
       * signed in with GitHub has no reason to be given.
       */
      const maintains = signedIn.human.roles.includes('maintainer')

      /**
       * **How many conversations are unread** (`#1453`), where the queue was.
       *
       * `waitingForOperator` asked *is there a message from an operator in this
       * thread* and answered *no* exactly once per thread ever, which hid 46 of
       * 52 conversations in production — sixteen of them while genuinely
       * waiting. Repairing it would have meant a second definition of *waiting*
       * beside the read cursor, and two definitions disagree within a week.
       *
       * **The same read the inbox does**, narrowed to unread and counted. A
       * dashboard number that disagreed with the page it links to would be
       * worse than no number, and one query cannot disagree with itself.
       */
      const unreadThreads =
        deps.operatorMessaging?.inbox === undefined
          ? 0
          : (await deps.operatorMessaging.inbox(signedIn.human.id, { unreadOnly: true })).length

      /**
       * What just happened to a drop, carried across the redirect (`#570`).
       *
       * **A code from a closed set and never a sentence in the URL.** The
       * value is looked up here, so a link somebody was sent cannot put words
       * on this page in the Colony's voice — and the wording stays in one
       * place when it is edited.
       */
      /**
       * The secrets sitting in an account conversation (`#931`).
       *
       * Its own read and not folded into the count above: that one answers
       * *how much is unread*, and half of these are the other direction — a
       * value the agent left for the person, which stops nothing and is not a
       * message. An empty list on a Colony with no sealing key, and no section
       * on the page.
       */
      const slots = (await deps.accountThreads?.waitingFor(signedIn.human.id)) ?? []

      const query = request.query as { filled?: unknown; slot?: unknown }
      const filled =
        FILL_NOTICE[String(query.filled ?? '')] ?? SLOT_NOTICE[String(query.slot ?? '')]

      return wantsHtml(request)
        ? html(
            reply,
            dashboardPage({
              nav: navFor(request, signedIn.human.roles),
              zone: zoneFrom(request.headers),
              agents,
              unreadThreads,
              slots,
              code,
              maintains,
              ...(filled === undefined ? {} : { notice: filled }),
            }),
          )
        : reply.send({
            signedIn: true,
            agents,
            unreadThreads,
            slots,
            ...(maintains && { maintains: true }),
          })
    }

    const agent = await caller(request)
    if (agent === null) {
      return wantsHtml(request)
        ? html(reply, signInPage({ providers }))
        : reply.send({ signedIn: false, signIn: '/sign-in' })
    }

    const quests = await deps.quests.listOwn(agent.id)
    const listed = quests.map((quest) => ({
      id: quest.task.id,
      title: quest.task.title,
      status: quest.task.status,
      awaitingModeration: quest.awaitingModeration,
      heldSince: quest.heldSince,
      rejectionReason: quest.rejectionReason,
    }))

    return wantsHtml(request)
      ? html(reply, questsPage({ nav: navFor(request), name: agent.profile.name, quests: listed }))
      : reply.send({ signedIn: true, name: agent.profile.name, quests: listed })
  })

  /**
   * Ask for a link.
   *
   * The same `requestSignIn` the JSON route calls, with the same two limiters —
   * per address and per IP (`#172`). A second implementation of the front door
   * is a second place its brake could be missing.
   */
  app.post('/sign-in', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const parsed = RequestLinkSchema.safeParse(request.body)
    if (!parsed.success) {
      return wantsHtml(request)
        ? html(reply.status(ERROR_STATUS.validation_failed), signInPage({ providers }))
        : reply.status(ERROR_STATUS.validation_failed).send({
            code: 'validation_failed',
            message: 'A sign-in request carries one field: `email`.',
          })
    }

    const result = await requestSignIn(
      parsed.data.email,
      clientIp(request.headers, request.socket.remoteAddress ?? ''),
      deps.console,
    )

    if (result.outcome === 'rejected') {
      return wantsHtml(request)
        ? html(reply.status(ERROR_STATUS[result.error.code]), signInPage({ providers }))
        : reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return wantsHtml(request)
      ? html(reply.status(200), signInPage({ sent: true, providers }))
      : reply.status(202).send(CHECK_YOUR_MAIL)
  })

  /**
   * Where the mail lands, at the one path {@link SIGN_IN_REDEEM_PATH} names.
   *
   * A `GET`, because a link in an email is a `GET` and nothing else. The token
   * is single-use and expires (`#172`), which is what makes that acceptable —
   * and the session leaves in `Set-Cookie` rather than in the body, so no bearer
   * secret reaches a proxy log or the rendered page.
   *
   * **A refused link renders the reason above the form** (`#396`). The form is
   * still there, because asking for another link is exactly what the reader
   * should do next; what changed is that the page now says why they are looking
   * at it. A bare form was indistinguishable from the 404 this route never
   * received.
   */
  app.get(SIGN_IN_REDEEM_PATH, async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const { token } = request.query as { token?: string }
    const result = await redeemSignIn(
      token ?? '',
      clientIp(request.headers, request.socket.remoteAddress ?? ''),
      deps.console,
    )

    if (result.outcome === 'rejected') {
      return wantsHtml(request)
        ? html(
            reply.status(ERROR_STATUS[result.error.code]),
            signInPage({ notice: result.error.message, providers }),
          )
        : reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    reply.header(
      'set-cookie',
      `${SESSION_COOKIE}=${result.session}; Max-Age=${result.maxAgeSeconds}; Path=/; Secure; HttpOnly; SameSite=Lax`,
    )

    // Redirected rather than rendered, so the token leaves the address bar and
    // the browser's history holds a page rather than a credential.
    return wantsHtml(request)
      ? reply.status(303).header('location', '/').send()
      : reply.status(200).send({ agentId: result.agentId })
  })

  /**
   * The way out to the provider (`#425`).
   *
   * A `GET` and a redirect, so the page that offers it needs no form, no
   * JavaScript and no change to `form-action`. The `state` is minted here, put
   * in a `__Host-` cookie, and checked when it comes back — without it, a
   * callback prepared by somebody else and delivered to this browser signs this
   * person into that person's account.
   *
   * **404 when no tenant is configured**, which is the same answer the path gave
   * before this feature existed. A route that answered *not configured* would
   * tell a stranger what the deployment is missing, and a person who never saw
   * the button has no reason to be here.
   */
  app.get('/sign-in/:provider', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const { provider } = request.params as { provider?: string }
    const tenant = deps.humans.tenant
    const offered = OFFERED_PROVIDERS.find((known) => known === provider)

    if (tenant === undefined || offered === undefined) {
      return wantsHtml(request)
        ? html(reply.status(404), notFoundPage())
        : reply.status(404).send({ code: 'not_found', message: 'No such sign-in route.' })
    }

    const state = mintOauthState()

    return reply
      .status(303)
      .header('set-cookie', oauthStateCookie(state))
      .header('location', tenant.authorizeUrl({ connection: offered, state }))
      .send()
  })

  /**
   * Attach a second door to the account already signed in (`#574`).
   *
   * **A `POST` and not a `GET`, which is the one way this differs from
   * `/sign-in/:provider` in shape.** That route starts a handover for a stranger
   * and changes nothing until the callback; this one acts on behalf of a person
   * who is signed in, so a `GET` would be a state change any third-party page
   * could trigger by embedding a link. Signing in cannot be done to somebody;
   * attaching an identity to their account can.
   *
   * The state goes in {@link OAUTH_CONNECT_COOKIE} rather than the sign-in
   * cookie, and the callback tells the two apart by which one came back. That
   * distinction is the whole of what stops a prepared callback from attaching an
   * identity to whoever is holding this browser.
   *
   * The same 404 as `/sign-in/:provider` when no tenant is configured, for the
   * same reason: a route that answered *not configured* would tell a stranger
   * what the deployment is missing.
   */
  app.post('/account/connect/:provider', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const { provider } = request.params as { provider?: string }
    const tenant = deps.humans.tenant
    const offered = OFFERED_PROVIDERS.find((known) => known === provider)

    if (tenant === undefined || offered === undefined) {
      return wantsHtml(request)
        ? html(reply.status(404), notFoundPage())
        : reply.status(404).send({ code: 'not_found', message: 'No such sign-in route.' })
    }

    // Before the redirect, not after: a person who is not signed in must not be
    // sent to a provider at all. Coming back with an identity and no session is
    // a refusal either way, but it is a refusal after they have handed a third
    // party a consent screen for nothing.
    const signedIn = await person(request)
    if (signedIn === null) return signInRequired(request, reply)

    const state = mintOauthState()

    return reply
      .status(303)
      .header('set-cookie', oauthStateCookie(state, OAUTH_CONNECT_COOKIE))
      .header('location', tenant.authorizeUrl({ connection: offered, state }))
      .send()
  })

  /**
   * And the way back (`#425`).
   *
   * Three things have to be true before a session is issued, and each of them is
   * a different attack if it is not: the browser presents the state it was
   * given, the tenant recognises the code, and the profile carries a subject.
   * Any of them missing renders the sign-in page with a plain sentence — never
   * with the provider's own error text, which is somebody else's wording
   * arriving through the query string.
   *
   * **The state cookie is cleared on every path out of here**, including the
   * failures. A one-time value that survives its use is not one-time.
   */
  app.get(SIGN_IN_CALLBACK_PATH, async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    // Both handovers end here, so both are cleared on every path out — a
    // one-time value that survives its use is not one-time.
    reply.header('set-cookie', [
      clearedOauthStateCookie(),
      clearedOauthStateCookie(OAUTH_CONNECT_COOKIE),
    ])

    const tenant = deps.humans.tenant
    if (tenant === undefined) {
      return wantsHtml(request)
        ? html(reply.status(404), notFoundPage())
        : reply.status(404).send({ code: 'not_found', message: 'No such sign-in route.' })
    }

    const query = request.query as { code?: unknown; state?: unknown }
    const refuse = (notice: string): FastifyReply =>
      wantsHtml(request)
        ? html(reply.status(ERROR_STATUS.validation_failed), signInPage({ notice, providers }))
        : reply.status(ERROR_STATUS.validation_failed).send({
            code: 'validation_failed',
            message: notice,
          })

    /**
     * **Which handover is coming back** (`#574`).
     *
     * One callback path serves both, because a second registered callback URL is
     * a change in the Auth0 tenant and this needs none. What tells them apart is
     * which `__Host-` cookie the browser presents, and nothing outside this
     * origin can write either.
     *
     * **Connect is checked first and the two are never both accepted.** A
     * request presenting both cookies is a request that started two handovers;
     * treating it as a sign-in would let a connect handover be laundered into a
     * session, so the narrower reading wins and the other cookie is cleared
     * unused.
     */
    const connecting = stateMatches(
      cookieValue(request.headers.cookie, OAUTH_CONNECT_COOKIE),
      query.state,
    )

    if (
      !connecting &&
      !stateMatches(cookieValue(request.headers.cookie, OAUTH_STATE_COOKIE), query.state)
    ) {
      return refuse('That sign-in did not start in this browser, or it took too long. Try again.')
    }

    if (typeof query.code !== 'string' || query.code === '') {
      return refuse('The provider sent us back without a sign-in. Nothing was changed.')
    }

    const identity = await tenant.exchangeCode(query.code)
    if (identity === undefined) {
      return refuse('The provider could not confirm that sign-in. Nothing was changed.')
    }

    if (connecting) {
      /**
       * **Re-read the session here rather than trusting the one that started
       * the handover.** A person may have signed out, or the session may have
       * expired, between the redirect out and the redirect back. `#574` names
       * that case and requires it to attach nothing.
       */
      const signedIn = await person(request)
      if (signedIn === null) {
        return refuse('That connection was not made: the sign-in ended before you came back.')
      }

      const attached = await deps.humans.store.connect(signedIn.human.id, identity)

      if (attached.outcome === 'taken') {
        // Somebody else's identity. Nothing on either account was touched, and
        // this session is deliberately left alone — the person did nothing wrong
        // and signing them out would read as a punishment for a typo.
        return wantsHtml(request)
          ? reply.status(303).header('location', `/account?connected=taken`).send()
          : reply.status(ERROR_STATUS.validation_failed).send({
              code: 'validation_failed',
              message: 'That account is already attached to somebody else.',
            })
      }

      return wantsHtml(request)
        ? reply.status(303).header('location', `/account?connected=${attached.outcome}`).send()
        : reply.status(200).send({ connected: attached.outcome })
    }

    const arrival = await deps.humans.store.findOrCreate(identity)

    if (arrival.outcome === 'ambiguous') {
      /**
       * **More than one person already holds this address** (`#574`).
       *
       * Nothing was written and nobody is signed in. The sentence says what to
       * do and deliberately not how many matched: the number is a fact about
       * other people's accounts, and a stranger who reached this page should
       * learn nothing from it.
       */
      return refuse(
        'That address already reaches more than one account here, so we did not guess. ' +
          'Sign in with a provider you have used before, then attach this one from your account.',
      )
    }

    const { human } = arrival
    const session = await deps.humans.store.openSession(human.id, {
      browser: browserFamily(request.headers['user-agent']),
      location: coarseLocation(request.headers as Record<string, unknown>),
    })

    /**
     * Both cookies in one reply: the state is cleared and the session is set.
     * `reply.header` replaces, so they are appended as an array — a second
     * `set-cookie` written the obvious way silently drops the first, and the
     * symptom is a state cookie that outlives its handover.
     */
    reply.header('set-cookie', [
      clearedOauthStateCookie(),
      clearedOauthStateCookie(OAUTH_CONNECT_COOKIE),
      `${SESSION_COOKIE}=${session.session}; Max-Age=${session.maxAgeSeconds}; Path=/; Secure; HttpOnly; SameSite=Lax`,
    ])

    // Redirected rather than rendered, for the reason the mail link is: the code
    // leaves the address bar, and history holds a page rather than a credential.
    return wantsHtml(request)
      ? reply.status(303).header('location', '/').send()
      : reply.status(200).send({ signedIn: true })
  })

  /**
   * Issue a link code for this person to hand to an agent (`#426`).
   *
   * A `POST` and not a side effect of loading the dashboard: a page view that
   * minted a code would leave a person holding a value their agent was never
   * given, and the one before it dead. Asking again replaces the previous one,
   * so *the* code on the page is always the one that works.
   */
  app.post('/link/code', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const signedIn = await person(request)
    if (signedIn === null) return signInRequired(request, reply)

    const issued = await deps.humans.store.issueCodeForHuman(signedIn.human.id)

    return wantsHtml(request)
      ? reply.status(303).header('location', '/').send()
      : reply.status(200).send(issued)
  })

  /**
   * And redeem one an agent handed to this person (`#426`).
   *
   * **Every refusal renders the dashboard with a sentence, and none of them says
   * whether the code exists.** *Unknown* is the answer for a value nobody issued
   * and for one issued to somebody else alike, which is what stops this form
   * being a way to find out whether a guessed code is real.
   */
  app.post('/link', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const signedIn = await person(request)
    if (signedIn === null) return signInRequired(request, reply)

    const { code } = (request.body ?? {}) as { code?: unknown }
    const result =
      typeof code === 'string' && code !== ''
        ? await deps.humans.store.redeemAsHuman(code, signedIn.human.id)
        : ({ outcome: 'refused', reason: 'unknown' } as const)

    const notice =
      result.outcome === 'linked'
        ? 'Linked. The agent is in your list.'
        : {
            unknown: 'That code is not one the Colony is holding. Check it with your agent.',
            spent: 'That code has already been used. Your agent can ask for another.',
            expired: 'That code has expired. Your agent can ask for another.',
            'wrong-side':
              'That is the code you generated for your agent to redeem — it is theirs to use, ' +
              'not yours. If your agent asked the Colony for one of its own, enter that.',
            'already-linked':
              'Somebody already operates that agent, and one citizen has one operator.',
          }[result.reason]

    if (!wantsHtml(request)) {
      return result.outcome === 'linked'
        ? reply.status(200).send({ linked: true })
        : reply.status(ERROR_STATUS.validation_failed).send({
            code: 'validation_failed',
            message: notice,
          })
    }

    const operated = await deps.humans.store.operated(signedIn.human.id)
    const live = await deps.humans.store.liveCode(signedIn.human.id)

    return html(
      reply.status(result.outcome === 'linked' ? 200 : ERROR_STATUS.validation_failed),
      dashboardPage({
        nav: navFor(request, signedIn.human.roles),
        zone: zoneFrom(request.headers),
        agents: operated.map((agent) => ({
          id: String(agent.id),
          name: agent.name,
          citizenship: agent.citizenship,
          skillsHeld: agent.skillsHeld,
          lastSeenAt: agent.lastSeenAt,
        })),
        code: live,
        notice,
      }),
    )
  })

  /**
   * `POST /drops/:dropId` is gone (`#1444`).
   *
   * It let a signed-in operator fill a sealed box from the queue rather than
   * hunting a three-day-old mail — a real repair when `#570` made it, and it did
   * not change the outcome: over the whole lifetime of the channel **7 drops
   * were opened and none was ever filled**, from either door. What replaces it
   * is a shared vault entry, which the operator writes into from the durable
   * page they already hold.
   *
   * The slot's route below is **not** the same thing and stays.
   */

  /**
   * `POST /handovers/:handoverId` is gone (`#1443`).
   *
   * It read a secret an agent had sealed for its operator, from a signed-in
   * console. Over the whole lifetime of that channel it was reached **zero
   * times** against 42 sealed values — operators hold the durable page rather
   * than a console account, which is the constraint `#1437` frozen decision 1
   * reverses. `kolonie.vault.share` replaces it and is read from the page.
   *
   * The slot's route below is **not** the same thing and stays: a slot is filled
   * by a person and claimed by the agent, which is the other direction.
   */
  /**
   * Fill a secret slot an agent left waiting for its operator (`#931`).
   *
   * The drop's route one screen up, against the conversation instead of a
   * separate channel — same session, same join, same one sentence for every dead
   * state. What is different is only where the value lands: an agent-named vault
   * key it claims for itself, rather than a box the agent opened for one value.
   *
   * **The plaintext is sealed above the storage and never below it.** The port
   * takes what the operator typed and hands the storage a ciphertext; the
   * console holds no key and this route names none.
   */
  app.post('/account-slots/:slotId/fill', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const signedIn = await person(request)
    if (signedIn === null) return signInRequired(request, reply)

    const { slotId } = request.params as { slotId: string }
    const { value } = (request.body ?? {}) as { value?: unknown }

    // A malformed id is `closed` and not a 400: it is the shape a stranger's
    // guess arrives in, and answering it differently would say that the ids
    // this console accepts are worth guessing at.
    const slot = AccountSlotIdSchema.safeParse(slotId)

    /**
     * `closed` when the surface is not configured, which is the same answer a
     * stranger's slot id gets — for the reason the drop's route sets out, and
     * with the same consequence: a person cannot be holding a form for a slot on
     * a Colony that could not have opened one.
     */
    const result =
      deps.accountThreads === undefined ||
      !slot.success ||
      typeof value !== 'string' ||
      value === ''
        ? ({ outcome: 'closed' } as const)
        : await deps.accountThreads.fillAsOperator({
            slotId: slot.data,
            humanId: signedIn.human.id,
            value,
          })

    if (!wantsHtml(request)) {
      return result.outcome === 'filled'
        ? reply.status(200).send({ filled: true })
        : reply.status(ERROR_STATUS.conflict).send({
            code: 'conflict',
            message: SLOT_CLOSED_NOTICE,
          })
    }

    return reply.status(303).header('location', `/?slot=${result.outcome}`).send()
  })

  /**
   * Read a secret an agent sealed into a slot for its operator (`#931`).
   *
   * The handover's route, against the conversation. All three of its arguments
   * hold here unchanged: the signed-in session is the only thing that authorises
   * it, it is a `POST` because reading it spends one of three, and the value is
   * in the response body and nowhere else.
   */
  app.post('/account-slots/:slotId', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const signedIn = await person(request)
    if (signedIn === null) return signInRequired(request, reply)

    const { slotId } = request.params as { slotId: string }
    const slot = AccountSlotIdSchema.safeParse(slotId)

    const result =
      deps.accountThreads === undefined || !slot.success
        ? ({ outcome: 'closed' } as const)
        : await deps.accountThreads.readAsOperator(slot.data, signedIn.human.id)

    if (result.outcome !== 'read') {
      return wantsHtml(request)
        ? reply.status(303).header('location', '/?slot=closed').send()
        : reply.status(ERROR_STATUS.conflict).send({
            code: 'conflict',
            message: SLOT_CLOSED_NOTICE,
          })
    }

    return wantsHtml(request)
      ? html(
          reply,
          // The handover's page, because it is the same page: a warning that
          // says how long and how many, the value, and nothing to click.
          handoverPage({
            nav: navFor(request, signedIn.human.roles),
            provider: result.provider ?? 'your agent’s account',
            prompt: result.label,
            value: result.value,
            readsLeft: result.readsLeft,
          }),
        )
      : reply.send({
          provider: result.provider,
          value: result.value,
          readsLeft: result.readsLeft,
          notice: handoverNotice(result.readsLeft),
        })
  })

  /**
   * Sign out (`#431`).
   *
   * **A `POST`, and the session is ended server-side.** Clearing the cookie
   * alone would leave a value that still authenticates in the hands of whoever
   * else has it, which is precisely the case a sign-out exists for. The cookie
   * is cleared as well, because a browser holding a dead session would keep
   * presenting it.
   *
   * Answers the same way whether or not there was a session to end: a person
   * who is already signed out asked for the state they are in, and telling them
   * otherwise would be a refusal with nothing behind it.
   */
  app.post('/sign-out', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const cookie = sessionCookie(request.headers.cookie)
    if (cookie !== undefined) await deps.humans.store.endSession(cookie)

    reply.header('set-cookie', clearedSessionCookie())

    return wantsHtml(request)
      ? reply.status(303).header('location', '/').send()
      : reply.status(200).send({ signedIn: false })
  })

  /**
   * The sessions a person holds (`#431`).
   *
   * Not a list of credentials — a list a person can act on. The current session
   * is marked, because a reader who cannot tell which row is the browser in
   * front of them cannot answer the question the page exists to ask.
   */
  app.get('/sessions', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const signedIn = await person(request)
    if (signedIn === null) return signInRequired(request, reply)

    const sessions = (await deps.humans.store.listSessions(signedIn.human.id)).map((session) => ({
      id: String(session.id),
      startedAt: session.startedAt,
      lastUsedAt: session.lastUsedAt,
      browser: session.browser,
      location: session.location,
      current: String(session.id) === signedIn.sessionId,
    }))

    return wantsHtml(request)
      ? html(
          reply,
          sessionsPage({
            nav: navFor(request, signedIn.human.roles),
            zone: zoneFrom(request.headers),
            sessions,
          }),
        )
      : reply.send({ sessions })
  })

  /**
   * End one of them.
   *
   * **The id is checked against the person, in the same statement that ends the
   * row.** Reading it first and ending it second would be the same check with a
   * gap in the middle; as one `where` clause, somebody naming a session that is
   * not theirs ends nothing and is told the same thing they would be told about
   * a session that never existed.
   */
  app.post('/sessions/:id/end', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const signedIn = await person(request)
    if (signedIn === null) return signInRequired(request, reply)

    const { id } = request.params as { id: string }
    const ended = await deps.humans.store.endSessionById(signedIn.human.id, id)

    // Ending the session doing the asking is allowed and ordinary — it is what
    // a person does after signing in somewhere they should not have.
    if (ended && id === signedIn.sessionId) reply.header('set-cookie', clearedSessionCookie())

    return wantsHtml(request)
      ? reply
          .status(303)
          .header('location', ended && id === signedIn.sessionId ? '/' : '/sessions')
          .send()
      : reply.status(200).send({ ended })
  })

  /**
   * End all of them, including this one.
   *
   * Deliberately including it: *sign out everywhere* that left the current
   * browser signed in would be a promise the next page visibly breaks.
   */
  app.post('/sessions/end-all', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const signedIn = await person(request)
    if (signedIn === null) return signInRequired(request, reply)

    const ended = await deps.humans.store.endAllSessions(signedIn.human.id)
    reply.header('set-cookie', clearedSessionCookie())

    return wantsHtml(request)
      ? reply.status(303).header('location', '/').send()
      : reply.status(200).send({ ended })
  })

  /*
   * `/browser/share/:shareId` was here (`#738`): the third operator channel's
   * window onto an agent's live tab, and the one console page that carried
   * script. It is gone (`#912`) along with the channel — `#894` measured that
   * the challenge it existed for reads the browser as driven and closes before
   * the operator arrives, so the window opened onto nothing to clear. No route
   * is registered for the path, so it answers with whatever an unknown path
   * answers, which is what a withdrawn page should look like from outside.
   */

  /**
   * The route out of the browser (`#400`).
   *
   * **Three steps, and the middle one is the point.** The page offers, the
   * `POST` mails a fresh confirmation, and the link mints. Minting a credential
   * that lasts until it is replaced, from a session that may have been open for
   * twelve hours, is the one place in the console worth an extra mail.
   *
   * **The identity is the session's and there is no parameter that could be
   * another's.** `sponsor` resolves the caller, `requestKeyMint` takes only that
   * id, and the address is read from storage — the same shape sign-in has, and
   * for the same reason.
   *
   * **JSON as well as HTML, like every route in this file.** An agent has no use
   * for this — it holds a key already — but a route with an HTML-only branch is
   * how `kolonie-docs#108`'s promise gets broken by accident.
   */
  app.get('/key', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const agent = await caller(request)
    if (agent === null) {
      if (wantsHtml(request)) {
        reply.callNotFound()
        return reply
      }
      return reply.status(ERROR_STATUS.unauthorized).send({ signedIn: false, signIn: '/sign-in' })
    }

    return wantsHtml(request)
      ? html(reply, keyPage({ nav: navFor(request) }))
      : reply.send({ mint: '/key', confirmedBy: 'a link mailed to the account address' })
  })

  app.post('/key', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const agent = await caller(request)
    if (agent === null) {
      if (wantsHtml(request)) {
        reply.callNotFound()
        return reply
      }
      return reply.status(ERROR_STATUS.unauthorized).send({ signedIn: false, signIn: '/sign-in' })
    }

    const result = await requestKeyMint(agent.id, deps.console)

    if (result.outcome === 'rejected') {
      return wantsHtml(request)
        ? html(
            reply.status(ERROR_STATUS[result.error.code]),
            keyPage({ nav: navFor(request), notice: result.error.message }),
          )
        : reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return wantsHtml(request)
      ? html(reply.status(200), keyPage({ nav: navFor(request), sent: true }))
      : reply.status(202).send({ sent: true, message: 'A confirmation link is on its way.' })
  })

  /**
   * Follow the confirmation and take the key.
   *
   * **The token is the whole credential and it is spent here**, so this is the
   * one route in the console that answers a `GET` by writing. That is what a
   * mailed link can do, and it is the same shape `SIGN_IN_REDEEM_PATH` has.
   *
   * **Not redirected afterwards, unlike sign-in.** That one redirects so the
   * token leaves the address bar; here the response body is the one copy of the
   * key that will ever exist, and a redirect would throw it away. The token in
   * the history is already spent by the time the page renders.
   */
  app.get(KEY_MINT_CONFIRM_PATH, async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const { token } = request.query as { token?: string }
    const result = await redeemKeyMint(token ?? '', deps.console)

    if (result.outcome === 'rejected') {
      return wantsHtml(request)
        ? html(
            reply.status(ERROR_STATUS[result.error.code]),
            keyPage({ nav: navFor(request), notice: result.error.message }),
          )
        : reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    // The JSON form carries the count too (`#1127`): a caller scripting this has
    // exactly the same thing to learn as a reader of the page, and learning it from
    // a rendered paragraph is not something a script can do.
    return wantsHtml(request)
      ? html(
          reply.status(200),
          keyMintedPage(result.apiKey, navFor(request), result.strandedVaultEntries),
        )
      : reply
          .status(200)
          .send({ apiKey: result.apiKey, strandedVaultEntries: result.strandedVaultEntries })
  })
}
