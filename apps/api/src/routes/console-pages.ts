import { randomUUID } from 'node:crypto'
import {
  ERROR_STATUS,
  reportAudience,
  type AgentId,
  type ApiError,
  type Task,
  type Timestamp,
} from '@kolonie-ai/core'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { authenticate } from '../authentication.js'
import {
  CHECK_YOUR_MAIL,
  KEY_MINT_CONFIRM_PATH,
  RequestLinkSchema,
  SIGN_IN_CALLBACK_PATH,
  SIGN_IN_REDEEM_PATH,
  SignUpSchema,
  redeemKeyMint,
  redeemSignIn,
  requestKeyMint,
  requestSignIn,
  signUp,
} from '../console.js'
import {
  CONSOLE_HEADERS,
  accountOpenedPage,
  errorPage,
  keyMintedPage,
  keyPage,
  notFoundPage,
  sessionsPage,
  signInPage,
  signedInPage,
} from '../console/html.js'
import { numbersPage, reviewQueuePage } from '../console/steward.js'
import { questDraftPage, questFormPage, questResultsPage, questsPage } from '../console/sponsor.js'
import {
  AUDIENCE_CHOICES,
  PROOF_CHOICES,
  QUEST_FORM_FIELDS,
  SKILL_CHOICES,
  affordability,
  parseQuestForm,
  proofNote,
} from '../console/quest-form.js'
import {
  exportQuestResults,
  publishQuest,
  readQuest,
  readQuestResults,
  refuseQuest,
  submitQuest,
  withdrawQuest,
  writeQuestDraft,
} from '../quests.js'
import { stewardFor } from './privileged.js'
import { clientIp } from '../client-ip.js'
import { cookieValue, sessionCookie } from './authenticated.js'
import { SESSION_COOKIE } from './console.js'
import { mintOauthState } from '../humans/auth0.js'
import {
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
export function registerConsolePages(app: FastifyInstance, deps: RouteDependencies): void {
  const host = consoleHost(deps.console.consoleUrl)
  if (host === undefined) return

  /**
   * Everything below is scoped to the console host.
   *
   * A prefix would have been simpler and wrong: `/console/...` on the API host
   * is a second name for the same pages, and a session cookie set with
   * `__Host-` there would travel to every API route.
   */
  const onConsoleHost = (request: FastifyRequest): boolean =>
    (request.headers.host ?? '').split(':')[0]?.toLowerCase() === host

  const guard = async (request: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
    if (!onConsoleHost(request)) {
      /**
       * **Handed to the app's own not-found handler rather than answered
       * here.** These paths are registered on every host — Fastify routes on
       * the path — so `/` on the API host must answer exactly what it answered
       * before this file existed, which is the 404 that names the REST prefix
       * and the MCP path. A second 404 with a different sentence would be this
       * feature quietly changing an answer agents already read.
       */
      reply.callNotFound()
      return false
    }

    for (const [header, value] of Object.entries(CONSOLE_HEADERS)) reply.header(header, value)
    return true
  }

  /**
   * The provider doors this deployment can actually offer (`#425`).
   *
   * Read once, from whether a tenant was configured — not from a list in the
   * page. A button that leads to a 404 is worse than no button, and the only
   * thing that knows whether the redirect has anywhere to go is the dependency.
   */
  const providers = deps.humans.tenant === undefined ? [] : OFFERED_PROVIDERS

  /**
   * The person signed in to this browser, or `null` (`#431`).
   *
   * **Resolved separately from {@link caller}, and never folded into it.** That
   * one returns an `Agent` with its skills, and this one returns somebody who
   * has none — a helper that returned *either* would push the difference into
   * every call site, where it would eventually be forgotten once.
   */
  const person = async (request: FastifyRequest) => {
    const cookie = sessionCookie(request.headers.cookie)
    if (cookie === undefined) return null

    const authenticated = await deps.humans.store.authenticate(cookie)
    return authenticated.outcome === 'authenticated' ? authenticated : null
  }

  /** Whoever this is, or `null` — without sending a refusal, which the pages own. */
  const caller = async (request: FastifyRequest) => {
    const authenticated = await authenticate(
      request.headers.authorization,
      deps.store,
      sessionCookie(request.headers.cookie),
    )
    return authenticated.outcome === 'rejected' ? null : authenticated.agent
  }

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
      return wantsHtml(request)
        ? html(reply, signedInPage())
        : reply.send({ signedIn: true, agents: [] })
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
      rejectionReason: quest.rejectionReason,
    }))

    return wantsHtml(request)
      ? html(reply, questsPage({ name: agent.profile.name, quests: listed }))
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
   * Open an account, from an address alone (`#266`).
   *
   * **The same `signUp` the JSON route calls**, for the reason the sign-in route
   * above gives: a second implementation of the front door is a second place its
   * brake could be missing, and this one is a step *earlier* on the surface those
   * two limiters protect.
   *
   * **It answers exactly as `/sign-in` does, and that is the whole shape of it.**
   * A taken address renders *check your mail* and creates nothing, a fresh one
   * renders *check your mail* and creates an identity — so a stranger cannot use
   * this form to learn whether an address is registered here. The `name-taken`
   * branch is unreachable from a browser, because the browser sends no name and
   * the Colony generates one it retries on collision; it is answered all the same,
   * because the route is the same route to an agent posting JSON.
   */
  app.post('/sign-up', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const parsed = SignUpSchema.safeParse(request.body)
    if (!parsed.success) {
      return wantsHtml(request)
        ? html(reply.status(ERROR_STATUS.validation_failed), signInPage({ providers }))
        : reply.status(ERROR_STATUS.validation_failed).send({
            code: 'validation_failed',
            message: 'A sign-up carries one field, `email`, and may carry a `name`.',
          })
    }

    const result = await signUp(
      parsed.data,
      clientIp(request.headers, request.socket.remoteAddress ?? ''),
      deps.console,
    )

    if (result.outcome === 'name-taken') {
      return wantsHtml(request)
        ? html(reply.status(ERROR_STATUS.conflict), signInPage({ providers }))
        : reply.status(ERROR_STATUS.conflict).send({
            code: 'conflict',
            message: `The name "${result.name}" is taken.`,
          })
    }

    if (result.outcome === 'rejected') {
      return wantsHtml(request)
        ? html(reply.status(ERROR_STATUS[result.error.code]), signInPage({ providers }))
        : reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    /**
     * **The browser's answer is the sign-up route's own, and the JSON answer is
     * still `CHECK_YOUR_MAIL`** (`#398`).
     *
     * The two differ because their readers do. A browser posting this form is a
     * person who just asked to open an account and is owed a straight answer;
     * the JSON shape is a contract an agent may already have built against, and
     * its ambiguity costs an agent nothing — it knows what it asked for.
     */
    return wantsHtml(request)
      ? html(reply.status(200), accountOpenedPage())
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

    reply.header('set-cookie', clearedOauthStateCookie())

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

    if (!stateMatches(cookieValue(request.headers.cookie, OAUTH_STATE_COOKIE), query.state)) {
      return refuse('That sign-in did not start in this browser, or it took too long. Try again.')
    }

    if (typeof query.code !== 'string' || query.code === '') {
      return refuse('The provider sent us back without a sign-in. Nothing was changed.')
    }

    const identity = await tenant.exchangeCode(query.code)
    if (identity === undefined) {
      return refuse('The provider could not confirm that sign-in. Nothing was changed.')
    }

    const { human } = await deps.humans.store.findOrCreate(identity)
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
      `${SESSION_COOKIE}=${session.session}; Max-Age=${session.maxAgeSeconds}; Path=/; Secure; HttpOnly; SameSite=Lax`,
    ])

    // Redirected rather than rendered, for the reason the mail link is: the code
    // leaves the address bar, and history holds a page rather than a credential.
    return wantsHtml(request)
      ? reply.status(303).header('location', '/').send()
      : reply.status(200).send({ signedIn: true })
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

    return wantsHtml(request) ? html(reply, sessionsPage({ sessions })) : reply.send({ sessions })
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

  /**
   * What a page behind a session says to somebody who has none.
   *
   * The sign-in page rather than a bare 401: the reader's next move is to sign
   * in, and a status code is not a next move. The status is still a refusal, so
   * an agent reading JSON is told plainly.
   */
  const signInRequired = (request: FastifyRequest, reply: FastifyReply): FastifyReply =>
    wantsHtml(request)
      ? html(reply.status(ERROR_STATUS.unauthorized), signInPage({ providers }))
      : reply.status(ERROR_STATUS.unauthorized).send({
          code: 'unauthorized',
          message: 'This page is for a signed-in person.',
        })

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
      ? html(reply, keyPage())
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
            keyPage({ notice: result.error.message }),
          )
        : reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return wantsHtml(request)
      ? html(reply.status(200), keyPage({ sent: true }))
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
            keyPage({ notice: result.error.message }),
          )
        : reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return wantsHtml(request)
      ? html(reply.status(200), keyMintedPage(result.apiKey))
      : reply.status(200).send({ apiKey: result.apiKey })
  })

  registerSponsorPages(app, deps, { guard, caller })
}

/**
 * The sponsor's own pages (`#180`).
 *
 * Registered from the same file and behind the same guard, so there is one
 * answer to *is this the console host* and one place a session is read.
 *
 * **Every one of them answers JSON to an API key.** `kolonie-docs#108` promises
 * that an agent may be a sponsor without driving a browser, and the way that
 * promise is kept is that no route here has an HTML-only branch — `wantsHtml`
 * chooses a representation of the same answer, never a different answer.
 */
function registerSponsorPages(
  app: FastifyInstance,
  deps: RouteDependencies,
  ctx: {
    readonly guard: (request: FastifyRequest, reply: FastifyReply) => Promise<boolean>
    readonly caller: (request: FastifyRequest) => Promise<{ readonly id: AgentId } | null>
  },
): void {
  /**
   * Signed in, or nothing — the check every sponsor route begins with.
   *
   * **A signed-out browser is handed to the not-found handler rather than
   * refused**, which looks like a status-code detail and is the rule this file
   * already states one function up: *"a 404 listing what exists would be an
   * oracle for pages a signed-out caller cannot reach anyway."* Answering `401`
   * here would tell an unauthenticated stranger which console paths are real —
   * `/quests/new` refusing and `/quests/nonsense` not existing are two different
   * answers, and the difference is the map.
   *
   * **An agent gets `401`**, because it is the answer an agent can act on: it
   * holds a credential, it may have sent the wrong one, and a `404` would send
   * it looking for a route rather than for its key. The two representations
   * differ here precisely because the readers differ — one is a stranger with a
   * browser and the other is a caller with a key.
   */
  const sponsor = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await ctx.guard(request, reply))) return null

    const agent = await ctx.caller(request)
    if (agent === null) {
      if (wantsHtml(request)) reply.callNotFound()
      else reply.status(ERROR_STATUS.unauthorized).send({ signedIn: false, signIn: '/sign-in' })
      return null
    }

    return agent
  }

  /** The form, with what the sponsor may still commit shown on it. */
  app.get('/quests/new', async (request, reply) => {
    const agent = await sponsor(request, reply)
    if (agent === null) return reply

    const { available } = await deps.quests.balance(agent.id)

    return wantsHtml(request)
      ? html(reply, questFormPage({ available }))
      : reply.send({
          available,
          fields: QUEST_FORM_FIELDS,
          skills: SKILL_CHOICES,
          audiences: AUDIENCE_CHOICES,
          proofVerifiers: PROOF_CHOICES,
          proofNote: proofNote(null),
        })
  })

  /** Save a draft. */
  app.post('/quests', async (request, reply) => {
    const agent = await sponsor(request, reply)
    if (agent === null) return reply

    const parsed = parseQuestForm(request.body)
    if (parsed.outcome === 'rejected') {
      const { available } = await deps.quests.balance(agent.id)
      return wantsHtml(request)
        ? html(
            reply.status(ERROR_STATUS.validation_failed),
            questFormPage({ available, problems: parsed.problems }),
          )
        : reply.status(ERROR_STATUS.validation_failed).send({
            code: 'validation_failed',
            message: parsed.problems.join(' '),
            problems: parsed.problems,
          })
    }

    const written = await writeQuestDraft({ authorId: agent.id, body: parsed.draft }, deps.quests)
    if (written.outcome === 'rejected') {
      const { available } = await deps.quests.balance(agent.id)
      return wantsHtml(request)
        ? html(
            reply.status(ERROR_STATUS[written.error.code]),
            questFormPage({ available, problems: [written.error.message] }),
          )
        : reply.status(ERROR_STATUS[written.error.code]).send(written.error)
    }

    return wantsHtml(request)
      ? reply.status(303).header('location', `/quests/${written.response.quest.id}`).send()
      : reply.status(201).send(written.response)
  })

  /** One quest: what it costs, what a citizen will read, and what to do next. */
  app.get('/quests/:questId', async (request, reply) => {
    const agent = await sponsor(request, reply)
    if (agent === null) return reply

    const own = await readQuest(
      { authorId: agent.id, questId: (request.params as { questId?: string }).questId },
      deps.quests,
    )
    if (own.outcome === 'rejected') return refuse(request, reply, own.error)

    const money = affordabilityOf(
      own.response.quest,
      (await deps.quests.balance(agent.id)).available,
    )

    /**
     * What this quest's targeting reaches today (`#227`).
     *
     * Computed here rather than on the form, because this console carries no
     * script and the criteria only exist once a draft holds them — and this is
     * still before the sponsor submits anything or commits a credit. It rides on
     * the JSON answer as well, so an agent sponsor sees the same number a person
     * does without a browser.
     */
    const audience = await deps.quests.audience(audienceOf(own.response.quest))

    return wantsHtml(request)
      ? html(
          reply,
          questDraftPage({
            quest: own.response.quest,
            money,
            audience,
            rejectionReason: own.response.rejectionReason,
            awaitingModeration: own.response.awaitingModeration,
          }),
        )
      : /**
         * The JSON answer carries the reported reach and not the raw count
         * (`#350`): the floor that keeps a small audience from naming a citizen
         * is a property of what leaves the Colony, and a route that skipped it
         * because it happens to serve a console would be the one hole in it.
         */
        reply.send({ ...own.response, money, audience: reportAudience(audience) })
  })

  /**
   * Take a quest back out of the review queue (`#323`).
   *
   * A form post rather than a link, for the reason every other state change on
   * this console is: a browser prefetching a link must not be able to change
   * anything.
   */
  app.post('/quests/:questId/withdraw', async (request, reply) => {
    const agent = await sponsor(request, reply)
    if (agent === null) return reply

    const questId = (request.params as { questId?: string }).questId
    const withdrawn = await withdrawQuest(
      { authorId: agent.id, questId, at: new Date().toISOString() as Timestamp },
      deps.quests,
    )

    if (withdrawn.outcome === 'rejected') return refuse(request, reply, withdrawn.error)

    return wantsHtml(request)
      ? reply.status(303).header('location', `/quests/${withdrawn.response.quest.id}`).send()
      : reply.send(withdrawn.response)
  })

  /** Submit a draft for review. */
  app.post('/quests/:questId/submit', async (request, reply) => {
    const agent = await sponsor(request, reply)
    if (agent === null) return reply

    const questId = (request.params as { questId?: string }).questId

    /**
     * The balance is checked here as well as shown on the page, because the
     * page is a courtesy and this is the refusal. A sponsor that submits a
     * quest it cannot fund would otherwise occupy review time on something
     * publication will refuse — which is the sequence `#174` reserves at
     * submission precisely to avoid.
     */
    const own = await readQuest({ authorId: agent.id, questId }, deps.quests)
    if (own.outcome === 'rejected') return refuse(request, reply, own.error)

    const money = affordabilityOf(
      own.response.quest,
      (await deps.quests.balance(agent.id)).available,
    )
    if (!money.affordable) {
      const error = {
        code: 'validation_failed' as const,
        message:
          `This quest costs ${money.total} credit(s) and you may commit ${money.available}. ` +
          `You are ${money.shortfall} short. A quest that cannot be paid for never reaches a steward.`,
      }
      return wantsHtml(request)
        ? html(
            reply.status(ERROR_STATUS.validation_failed),
            questDraftPage({
              quest: own.response.quest,
              money,
              rejectionReason: own.response.rejectionReason,
              awaitingModeration: own.response.awaitingModeration,
              problems: [error.message],
            }),
          )
        : reply.status(ERROR_STATUS.validation_failed).send(error)
    }

    const submitted = await submitQuest(
      { authorId: agent.id, questId, at: new Date().toISOString() as Timestamp },
      deps.quests,
    )
    if (submitted.outcome === 'rejected') return refuse(request, reply, submitted.error)

    return wantsHtml(request)
      ? reply.status(303).header('location', `/quests/${submitted.response.quest.id}`).send()
      : reply.send(submitted.response)
  })

  /**
   * Copy a refused quest into a new draft.
   *
   * **The refused row is not touched.** `#180` is explicit that a refused quest
   * keeps its refusal — it is the record of what a steward decided — so this
   * hands back a *form* filled with the old words rather than writing anything.
   * Nothing is created until the sponsor submits the copy, which also means a
   * sponsor that opens this and changes its mind has created no clutter.
   */
  app.post('/quests/:questId/copy', async (request, reply) => {
    const agent = await sponsor(request, reply)
    if (agent === null) return reply

    const own = await readQuest(
      { authorId: agent.id, questId: (request.params as { questId?: string }).questId },
      deps.quests,
    )
    if (own.outcome === 'rejected') return refuse(request, reply, own.error)

    const quest = own.response.quest
    const prefill: Record<string, string> = {
      title: quest.title,
      description: quest.description,
      instructions: quest.instructions,
      questions: JSON.stringify(quest.questions ?? []),
      slots: String(quest.slots ?? ''),
      rewardCredits: String(quest.reward.credits),
      minReputation: String(quest.minReputation),
    }

    const { available } = await deps.quests.balance(agent.id)
    const copiedFrom =
      own.response.rejectionReason === null
        ? undefined
        : { title: quest.title, reason: own.response.rejectionReason }

    return wantsHtml(request)
      ? html(reply, questFormPage({ available, prefill, copiedFrom }))
      : reply.send({ prefill, available, copiedFrom: copiedFrom ?? null })
  })

  /** The answers as they arrive, with the counts. */
  app.get('/quests/:questId/results', async (request, reply) => {
    const agent = await sponsor(request, reply)
    if (agent === null) return reply

    const results = await readQuestResults(
      { authorId: agent.id, questId: (request.params as { questId?: string }).questId },
      deps.quests,
    )
    if (results.outcome === 'rejected') return refuse(request, reply, results.error)

    return wantsHtml(request)
      ? html(reply, questResultsPage(results.response))
      : reply.send(results.response)
  })

  /**
   * The same set as a file.
   *
   * Always the file, whatever the `Accept` header says: a caller that asked for
   * a download asked for a download, and answering it with a page would be this
   * route being clever about something the query string already settled.
   */
  app.get('/quests/:questId/results/export', async (request, reply) => {
    const agent = await sponsor(request, reply)
    if (agent === null) return reply

    const exported = await exportQuestResults(
      {
        authorId: agent.id,
        questId: (request.params as { questId?: string }).questId,
        format: (request.query as { format?: string }).format,
      },
      deps.quests,
    )
    if (exported.outcome === 'rejected') return refuse(request, reply, exported.error)

    return reply.type(exported.contentType).send(exported.body)
  })

  /** One refusal, in whichever representation the caller reads. */
  const refuse = (request: FastifyRequest, reply: FastifyReply, error: ApiError): FastifyReply =>
    wantsHtml(request)
      ? html(reply.status(ERROR_STATUS[error.code]), errorPage(error.message))
      : reply.status(ERROR_STATUS[error.code]).send(error)
}

/**
 * The three targeting axes of a quest, in the shape the audience count takes
 * (`#227`).
 *
 * One function rather than an object literal at each call site: a fourth
 * criterion added to a quest and forgotten here would make the count quietly
 * wider than the listing, and a number that overstates the audience is worse
 * than none — it is the sponsor's decision, made on a figure nothing supports.
 */
function audienceOf(quest: Task) {
  return {
    audience: quest.audience,
    requires: quest.requires,
    minReputation: quest.minReputation,
    minActivityDays: quest.minActivityDays,
  }
}

/** Capacity × price against what this sponsor may still commit. */
function affordabilityOf(quest: Task, available: number) {
  return affordability({
    slots: quest.slots ?? 0,
    credits: quest.reward.credits,
    available,
  })
}

/**
 * Everything else on the console host is the sign-in page.
 *
 * A 404 listing the API's routes would be an oracle for which console pages
 * exist, and there is nothing here to find while signed out — so an unknown
 * path answers exactly as the front door does.
 *
 * Called from `app.ts`'s single not-found handler rather than registered as a
 * second one: Fastify allows one per context, and the API's own answer names
 * the REST prefix and the MCP path, which is the wrong thing to say to a
 * browser.
 */
/**
 * The steward's two pages (`#181`).
 *
 * **Behind `stewardFor`, which is the same guard the `/v1/quests/review` route
 * uses** — one definition of *who may do this*, and `#173` is explicit that the
 * role is the only permission axis. A second check written here would be a
 * second answer.
 *
 * **A browser that is not a steward gets the not-found handler**, exactly as a
 * signed-out browser does on a sponsor's page and for the reason that file
 * argues: answering `403` to a browser would tell a stranger which console paths
 * are real. An agent, which holds a credential and can act on the answer, gets
 * the ordinary `403` from `stewardFor`.
 */
export function registerStewardPages(app: FastifyInstance, deps: RouteDependencies): void {
  const host = consoleHost(deps.console.consoleUrl)
  if (host === undefined) return

  const onConsoleHost = (request: FastifyRequest): boolean =>
    (request.headers.host ?? '').split(':')[0]?.toLowerCase() === host

  /** The steward reading this, or nothing — without sending a refusal to a browser. */
  const steward = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!onConsoleHost(request)) {
      reply.callNotFound()
      return null
    }

    for (const [header, value] of Object.entries(CONSOLE_HEADERS)) reply.header(header, value)

    if (wantsHtml(request)) {
      const authenticated = await authenticate(
        request.headers.authorization,
        deps.store,
        sessionCookie(request.headers.cookie),
      )
      if (authenticated.outcome === 'rejected' || !authenticated.agent.roles.includes('steward')) {
        reply.callNotFound()
        return null
      }
      return authenticated.agent
    }

    return await stewardFor(request, reply, deps.store)
  }

  app.get('/review', async (request, reply) => {
    const caller = await steward(request, reply)
    if (caller === null) return reply

    const queue = await deps.quests.stewardQueue(caller.id)

    return wantsHtml(request)
      ? html(reply, reviewQueuePage({ steward: caller.profile.name, queue }))
      : reply.send({ queue })
  })

  app.post('/review/:questId/publish', async (request, reply) => {
    const caller = await steward(request, reply)
    if (caller === null) return reply

    const { questId } = request.params as { questId?: string }
    const result = await publishQuest(
      { stewardId: caller.id, questId, at: new Date().toISOString() as Timestamp },
      deps.quests,
    )

    if (result.outcome === 'rejected') {
      return wantsHtml(request)
        ? html(reply.status(ERROR_STATUS[result.error.code]), errorPage(consoleErrorId()))
        : reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return wantsHtml(request) ? reply.redirect('/review', 303) : reply.send(result.response)
  })

  app.post('/review/:questId/refuse', async (request, reply) => {
    const caller = await steward(request, reply)
    if (caller === null) return reply

    const { questId } = request.params as { questId?: string }
    const result = await refuseQuest(
      {
        stewardId: caller.id,
        questId,
        body: request.body,
        at: new Date().toISOString() as Timestamp,
      },
      deps.quests,
    )

    if (result.outcome === 'rejected') {
      return wantsHtml(request)
        ? html(reply.status(ERROR_STATUS[result.error.code]), errorPage(consoleErrorId()))
        : reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return wantsHtml(request) ? reply.redirect('/review', 303) : reply.send(result.response)
  })

  app.get('/numbers', async (request, reply) => {
    const caller = await steward(request, reply)
    if (caller === null) return reply

    const numbers = await deps.quests.numbers()

    return wantsHtml(request) ? html(reply, numbersPage(numbers)) : reply.send(numbers)
  })
}

/**
 * The console's 404, and it stopped being the sign-in page in `#396`.
 *
 * **Rendering the front door for a wrong URL is what hid that defect for the
 * whole of its life.** The mailed link pointed at a route nobody had registered;
 * every reader who followed one got a 200-shaped page with a form on it, read it
 * as *the link expired*, asked for another and arrived back here. A status code
 * no browser displays was the only thing saying otherwise.
 */
export function consoleNotFound(reply: FastifyReply, request: FastifyRequest): FastifyReply {
  for (const [header, value] of Object.entries(CONSOLE_HEADERS)) reply.header(header, value)

  return wantsHtml(request)
    ? reply.status(404).type('text/html; charset=utf-8').send(notFoundPage())
    : reply.status(404).send({ code: 'not_found', message: 'No such route.' })
}

/** Whether this request arrived on the console's host, as `app.ts` asks it. */
export function isConsoleRequest(
  request: { readonly headers: { host?: string } },
  consoleUrl: string,
): boolean {
  const host = consoleHost(consoleUrl)
  if (host === undefined) return false

  return (request.headers.host ?? '').split(':')[0]?.toLowerCase() === host
}

/**
 * Which representation this caller wants.
 *
 * **JSON is the default and HTML is the exception**, which is the opposite of
 * what a browser-first surface would do and is deliberate: an agent that sends
 * no `Accept` at all must never be handed a page. Only a caller that explicitly
 * prefers HTML gets one, and a browser always does.
 */
export function wantsHtml(request: { readonly headers: { accept?: string } }): boolean {
  const accept = request.headers.accept ?? ''
  if (accept === '') return false
  if (accept.includes('application/json')) return false
  return accept.includes('text/html') || accept.includes('*/*')
}

const html = (reply: FastifyReply, body: string): FastifyReply =>
  reply.type('text/html; charset=utf-8').send(body)

/**
 * The host the console answers on, from `CONSOLE_URL`, or nothing.
 *
 * A malformed URL is the same as an absent one: the console does not serve. A
 * process that cannot tell where its console lives must not guess, because the
 * guess would be the API's own host.
 */
export function consoleHost(consoleUrl: string): string | undefined {
  if (consoleUrl.trim() === '') return undefined

  try {
    return new URL(consoleUrl).hostname.toLowerCase()
  } catch {
    return undefined
  }
}

/**
 * The error id a console failure carries.
 *
 * Exported so the error handler and its test name the same thing. It is a uuid
 * and not a message: an id can be found in a log, and a message is the thing
 * `#171` is about.
 */
export function consoleErrorId(): string {
  return randomUUID()
}

/** The console's own error rendering. See {@link errorPage} for why it takes an id. */
export function consoleError(reply: FastifyReply, request: FastifyRequest): FastifyReply {
  const errorId = consoleErrorId()

  for (const [header, value] of Object.entries(CONSOLE_HEADERS)) reply.header(header, value)

  return wantsHtml(request)
    ? reply.status(500).type('text/html; charset=utf-8').send(errorPage(errorId))
    : reply.status(500).send({ code: 'internal', message: 'Internal error.', errorId })
}
