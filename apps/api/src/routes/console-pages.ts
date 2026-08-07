import { randomUUID } from 'node:crypto'
import {
  ERROR_STATUS,
  platformFeePercentFromEnv,
  reportAudience,
  type AgentId,
  type ApiError,
  type HumanId,
  type Log,
  type Task,
  type TaskId,
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
  accountDeletedPage,
  accountPage,
  dashboardPage,
  sessionsPage,
  signInPage,
} from '../console/html.js'
import { zoneFrom } from '../console/time.js'
import { agentPage } from '../console/agent-page.js'
import { fundingPage } from '../console/funding.js'
import { numbersPage, reviewQueuePage } from '../console/steward.js'
import { backendPage } from '../console/backend.js'
import {
  operatedQuestsPage,
  questDraftPage,
  questFormPage,
  questResultsPage,
  questsPage,
} from '../console/sponsor.js'
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
import { readDepositAddress, readDepositHistory } from '../deposits.js'
import { stewardFor } from './privileged.js'
import { clientIp } from '../client-ip.js'
import { cookieValue, sessionCookie } from './authenticated.js'
import { consoleOperatorPath, operatorPageBody } from '../operator-page-body.js'
import type { OperatorPageView } from '@kolonie-ai/db'
import { operatorAnsweredPage, operatorNoteSentPage } from '../autonomy-page.js'
import { writeOperatorNote } from '../operator-notes.js'
import { answerOperatorRequest } from '../operator-requests.js'
import { generatedSponsorName, SESSION_COOKIE } from './console.js'
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
      const operated = await deps.humans.store.operated(signedIn.human.id)
      const code = await deps.humans.store.liveCode(signedIn.human.id)
      /**
       * **Which of these rows is the person themselves** (`#455`).
       *
       * The identity somebody writes quests through is an ordinary linked agent
       * and arrives in `operated` with the rest — so without this it would sit
       * in the table under a generated name, holding a balance and owning
       * quests, and nothing would say it was them. `governance/red-lines.md`
       * refuses *"accounts created to deceive about who is behind them"*, and
       * while nobody here intends that, an unlisted account holding money is the
       * shape that rule describes.
       */
      const you = await deps.humans.store.sponsorAgent(signedIn.human.id)
      const agents = operated.map((agent) => ({
        id: String(agent.id),
        name: agent.name,
        citizenship: agent.citizenship,
        skillsHeld: agent.skillsHeld,
        lastSeenAt: agent.lastSeenAt,
        you: you !== undefined && String(you.id) === String(agent.id),
      }))

      /**
       * The maintainer's link, and **absent rather than disabled** (`#486`).
       *
       * A greyed-out link tells a person a surface exists that they may not
       * have, which is a fact about the Colony's shape that a stranger who
       * signed in with GitHub has no reason to be given.
       */
      const maintains = signedIn.human.roles.includes('maintainer')

      return wantsHtml(request)
        ? html(reply, dashboardPage({ zone: zoneFrom(request.headers), agents, code, maintains }))
        : reply.send({ signedIn: true, agents, ...(maintains && { maintains: true }) })
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
    /** Same row, same label, on the render that follows a link attempt (`#455`). */
    const you = await deps.humans.store.sponsorAgent(signedIn.human.id)

    return html(
      reply.status(result.outcome === 'linked' ? 200 : ERROR_STATUS.validation_failed),
      dashboardPage({
        zone: zoneFrom(request.headers),
        agents: operated.map((agent) => ({
          id: String(agent.id),
          name: agent.name,
          citizenship: agent.citizenship,
          skillsHeld: agent.skillsHeld,
          lastSeenAt: agent.lastSeenAt,
          you: you !== undefined && String(you.id) === String(agent.id),
        })),
        code: live,
        notice,
      }),
    )
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
      ? html(reply, sessionsPage({ zone: zoneFrom(request.headers), sessions }))
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

  /**
   * The maintainer's gate (`#486`).
   *
   * **Registered here, in the human-facing registration, and not beside
   * `steward` in `registerStewardPages`.** That is the separation the issue
   * asks for made structural: this function is the one that can resolve a
   * person, and `registerStewardPages` is the one that can resolve an agent.
   * Neither can reach the other's resolver, so *shares no code path that
   * resolves an identity* is a fact about the scopes rather than a discipline.
   *
   * **That separation is a security property rather than tidiness.** The two
   * roles open pages on the same host and authenticate through different tables:
   * `credentials` for an agent, `human_sessions` for a person. `humans.ts`
   * states what is at stake — *"A bug there does not render a wrong page; it
   * hands somebody a citizen's authority."*
   *
   * So this reaches for {@link person} and never for {@link caller}, and the
   * compile is what stops the substitution: `person` resolves to a `Human`,
   * whose `roles` are `HumanRole[]`, and there is no value of that type an
   * `Agent` could be mistaken for — `HumanId` is branded apart from `AgentId` in
   * core precisely so this is a type error rather than a review comment.
   *
   * A caller without the role gets `callNotFound()`, exactly as the steward gate
   * does: the page does not announce itself to somebody who cannot have it.
   * That covers all three refusals in one branch — no session at all, a person's
   * session without the role, and an agent's session, which `person` cannot
   * resolve in the first place.
   */
  const maintainer = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!onConsoleHost(request)) {
      reply.callNotFound()
      return null
    }

    for (const [header, value] of Object.entries(CONSOLE_HEADERS)) reply.header(header, value)

    const signedIn = await person(request)
    if (signedIn === null || !signedIn.human.roles.includes('maintainer')) {
      reply.callNotFound()
      return null
    }

    return signedIn.human
  }

  /**
   * *How is the Colony doing*, answered to the person running it (`#486`).
   *
   * Reads the same `colonyNumbers()` the steward's page reads — one function,
   * two pages, so the two cannot disagree about the same figure.
   */
  app.get('/backend', async (request, reply) => {
    const held = await maintainer(request, reply)
    if (held === null) return reply

    const numbers = await deps.quests.numbers()
    // Two live queries beside the aggregates, each carrying its own moment
    // (`#487`). Not folded into `ColonyNumbers`: that object is aggregates
    // entirely, and showing individuals is a change of kind rather than one
    // more figure.
    const sections = await deps.quests.backendSections()

    return wantsHtml(request)
      ? html(reply, backendPage({ numbers, sections }))
      : reply.send({ numbers, ...sections })
  })

  /**
   * The account page, and the deletion it exists for (`#429`).
   *
   * **Deleting the human deletes the human and touches no agent**, which is the
   * whole shape of the feature. Nothing here reaches an agent's row: the store
   * removes the person, the schema cascades their identities, sessions and join
   * rows, and every agent survives with its name, skills, rungs, balance and
   * standing.
   */
  app.get('/account', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const signedIn = await person(request)
    if (signedIn === null) return signInRequired(request, reply)

    const [exported, unreachable] = await Promise.all([
      deps.humans.store.exportOf(signedIn.human.id),
      deps.humans.store.unreachableIdentities(signedIn.human.id),
    ])

    const agents = exported.agents.map((agent) => ({
      name: agent.name,
      linkedAt: agent.linkedAt,
    }))

    return wantsHtml(request)
      ? html(reply, accountPage({ zone: zoneFrom(request.headers), agents, unreachable }))
      : reply.send({ agents: exported.agents, unreachable })
  })

  /**
   * Delete it.
   *
   * **No grace period, matching the citizen's** — a deletion a confused person
   * can trigger and then wait out is a deletion nobody trusts. The page says so
   * before the button.
   *
   * **The session cookie is cleared whatever happens next**, because the session
   * it named has been deleted by the same statement that deleted the person. A
   * browser holding a dead session would keep presenting it.
   *
   * **One mail, at deletion, and never again**, which is the rule
   * `operator_addresses` already states. It is sent after the transaction
   * commits and its failure is not the person's problem: the account is already
   * gone, and answering an error would say otherwise.
   */
  app.post('/account/delete', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const signedIn = await person(request)
    if (signedIn === null) return signInRequired(request, reply)

    const result = await deps.humans.store.deleteAccount(signedIn.human.id)

    if (result.outcome === 'holds-unreachable-identity') {
      const exported = await deps.humans.store.exportOf(signedIn.human.id)

      return wantsHtml(request)
        ? html(
            reply.status(ERROR_STATUS.conflict),
            accountPage({
              zone: zoneFrom(request.headers),
              agents: exported.agents.map((agent) => ({
                name: agent.name,
                linkedAt: agent.linkedAt,
              })),
              unreachable: result.unreachable,
            }),
          )
        : reply.status(ERROR_STATUS.conflict).send({
            code: 'conflict',
            message:
              `This login is the only way to reach ${result.unreachable.join(', ')}, which has ` +
              `quests, a balance and reports already delivered. Delete it, transfer it, or hand ` +
              `it to an agent that holds its own key first.`,
          })
    }

    /**
     * `not-found` is answered as success, deliberately. The person's session
     * resolved a moment ago and their row is gone now — by another tab, or by
     * their own second click — and *your account is deleted* is both true and
     * the whole of what they need.
     */
    reply.header('set-cookie', clearedSessionCookie())

    if (result.outcome === 'deleted') {
      await Promise.all(
        result.notify.map(async (address) => {
          try {
            await deps.console.mailer?.send({
              to: address,
              subject: 'Your Kolonie account is deleted',
              text:
                'Your sign-in, your sessions and the record of which agents you operated have ' +
                'been deleted.\n\n' +
                'Your agents were not deleted and could not be. They keep their names, their ' +
                'skills, their rungs, their balances and their standing. Each has been told ' +
                'once that it no longer has an operator.\n\n' +
                'This is the only mail you will receive about it.',
            })
          } catch {
            /**
             * Swallowed on purpose. The transaction has committed; the account
             * is gone whatever the mail did, and turning a mail failure into an
             * error page would tell somebody their deletion had failed when it
             * had not.
             */
          }
        }),
      )
    }

    return wantsHtml(request)
      ? html(reply, accountDeletedPage())
      : reply.status(200).send({ deleted: true })
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

  registerSponsorPages(app, deps, { guard, caller, person })

  /**
   * The operator page, on a session — the second door (`#428`).
   *
   * **A second door to one page, not a second page.** The body is
   * `operatorPageBody`, the same function the mailed link renders through, so the
   * two cannot drift: `#428` names two renderings of an operator's view
   * disagreeing within a month as the thing this design is against, and a test
   * asserts both produce the same body for the same agent.
   *
   * **The token link is not replaced and its model is not weakened.** An agent
   * whose human never signs in stays reachable exactly as before, which is what
   * keeps *an agent may have no operator at all* true.
   *
   * ## The authorisation check is the whole security surface
   *
   * The agent is resolved from the **join table** and from nothing in the
   * request. The id in the path is a claim; `operates` is what turns it into a
   * subject, and a human that does not operate this agent gets the console's
   * ordinary 404 — the same answer as an agent that does not exist, so a signed-in
   * stranger cannot enumerate which ids are real.
   *
   * ## Why the live token, and why it never reaches the page
   *
   * Everything the page reads is keyed by the token, and that is the property
   * `#241` and `#399` rest on: nothing downstream takes an id from the caller.
   * Rather than build a second set of agent-keyed readers that could answer
   * differently, this door authorises first and then reaches the *same* readers.
   *
   * **Revocation therefore closes both doors, by construction rather than by a
   * second rule.** No live page means no token, which means this route answers
   * 404 — and `#428` is explicit that a door surviving revocation would make
   * revocation a thing the citizen only thinks it did.
   *
   * The token stays on the server: the forms post to this route's own path.
   * Showing the durable link on a page behind a login is *a credential leaking
   * downward for no gain*, which `#428` refused.
   *
   * **`lastOpenedAt` moves on the same field**, because `pages.open` is what
   * reads the view here as everywhere. `#381` found that timestamp already
   * ambiguous, and two fields would settle nothing and add a second thing to be
   * wrong.
   */
  const operatorDoor = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<{ token: string; view: OperatorPageView } | null> => {
    const signedIn = await person(request)
    if (signedIn === null) {
      consoleNotFound(reply, request)
      return null
    }

    /**
     * **The id in the path is a claim; `operates` is what turns it into a
     * subject.** Branded here and nowhere else, so the cast is next to the check
     * that earns it rather than somewhere a later reader would have to trust.
     */
    const { agentId } = request.params as { agentId?: string }
    const subject = agentId === undefined ? undefined : (agentId as AgentId)
    if (subject === undefined || !(await deps.humans.store.operates(signedIn.human.id, subject))) {
      consoleNotFound(reply, request)
      return null
    }

    const token = await deps.autonomy.pages.liveToken(subject)
    const view = token === undefined ? null : await deps.autonomy.pages.open(token)

    if (token === undefined || view === null) {
      consoleNotFound(reply, request)
      return null
    }

    return { token, view }
  }

  /**
   * **The agent this person operates, or nothing** (`#452`).
   *
   * The same two checks `operatorDoor` makes, without the third: a live operator
   * page is what the *mailed* door needs, and an agent whose citizen never
   * issued one still has a page here. That third check is why `#451`'s link
   * could land on a 404, and removing it is half of what this issue is for.
   *
   * A person who does not operate this agent gets exactly what they get for an
   * id that names nothing, so the page cannot be used to test for agents.
   */
  const operatedAgent = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<{ readonly humanId: HumanId; readonly agentId: AgentId } | null> => {
    const signedIn = await person(request)
    if (signedIn === null) {
      consoleNotFound(reply, request)
      return null
    }

    const { agentId } = request.params as { agentId?: string }
    const subject = agentId === undefined ? undefined : (agentId as AgentId)
    if (subject === undefined || !(await deps.humans.store.operates(signedIn.human.id, subject))) {
      consoleNotFound(reply, request)
      return null
    }

    return { humanId: signedIn.human.id, agentId: subject }
  }

  /**
   * One agent, as the person paying for the runtime reads it (`#452`).
   *
   * **Assembly, not new modelling.** Every figure comes from the source that
   * already owns it: the facts from `operatorPageFacts` — the same function the
   * mailed page reads, so the two cannot disagree about one agent — the balance
   * from the ledger through the quest desk, and what the skills open next from
   * the Academy's own frontier. Nothing is copied into a second table and
   * nothing is cached.
   *
   * **Nothing here writes to the agent.** The only write that may ever appear on
   * this page is the operator note `#453` folds in.
   */
  /**
   * One agent's page, built once and reachable from two routes (`#459`).
   *
   * The hand-over code is shown exactly once, so the `POST` that mints it has to
   * render this page directly rather than redirect to it. Two assemblies of the
   * same page would be two answers to *what does an operator see*, and the one
   * that drifted would be the one nobody loads by hand.
   */
  const renderAgentPage = async (
    request: FastifyRequest,
    reply: FastifyReply,
    operated: { readonly agentId: AgentId; readonly humanId: HumanId },
    issued?: { readonly code: string; readonly expiresAt: string },
  ) => {
    const held = await deps.autonomy.pages.factsOf(operated.agentId)
    if (held === null) return consoleNotFound(reply, request)

    /**
     * The operator's view, folded in as a section (`#453`).
     *
     * `undefined` when the citizen has issued no page — `#428` decided that no
     * live page means no door, and this side of the door is not an exception.
     * Read through `pages.open`, exactly as the standalone route reads it, so
     * `lastOpenedAt` moves for the same reason on both.
     */
    const token = await deps.autonomy.pages.liveToken(operated.agentId)
    const door = token === undefined ? null : await deps.autonomy.pages.open(token)

    const [balance, open, own, quests, written, depositAddress] = await Promise.all([
      deps.quests.balance(operated.agentId),
      /**
       * **`availableOnly`, not the frontier**, and `openTasksFor` in `tasks.ts`
       * already argues this exact point for a different reader: the frontier
       * answers *what is one skill out of reach*, and somebody wondering whether
       * to keep paying for a runtime needs *what can it start right now*. Those
       * are opposite answers for an agent that has stalled.
       *
       * Five, bounded here rather than in the page: *how many is too many* is a
       * question about this surface, and the catalogue's answer is general.
       */
      deps.catalogue.list({
        agentId: operated.agentId,
        availableOnly: true,
        limit: 5,
        hints: false,
      }),
      deps.humans.store.sponsorAgent(operated.humanId),
      /**
       * Quests this agent took part in (`#454`), from the store the console's
       * own quest pages read rather than a query written for this page.
       */
      deps.quests.takenPartIn(operated.agentId),
      /**
       * Quests this agent wrote (`#466`), from `listOwn` — the same store the
       * person's own `/quests` page reads, keyed on `createdBy`. One store, two
       * readers, and the separation from `takenPartIn` above is the store's
       * rather than this route's.
       */
      deps.quests.listOwn(operated.agentId),
      /**
       * The agent's deposit address, if it has asked for one (`#470`).
       *
       * **`existing` and never `address`.** The second generates a keypair when
       * there is none, and this is a `GET` read by somebody who operates the
       * agent rather than by the agent itself — `#457` lets them read it and not
       * act for it, and creating a key on a page load is acting for it.
       */
      deps.deposits.desk.existing(operated.agentId),
    ])

    const view = {
      zone: zoneFrom(request.headers),
      agentId: String(operated.agentId),
      name: held.name,
      runtime: held.runtime,
      citizenship: held.citizenship,
      arrivedOn: held.arrivedOn,
      facts: held.facts,
      balance: { available: balance.available, reserved: balance.reserved },
      /**
       * Bounded here rather than in the page, because *how many is too many* is
       * a question about this surface and the frontier is a general answer. Five
       * is what fits above the fold at 375px.
       */
      opensNext:
        open.outcome === 'listed'
          ? open.page.items.map((task) => ({ title: task.title, requires: [...task.requires] }))
          : [],
      you: own !== undefined && String(own.id) === String(operated.agentId),
      /**
       * Absent rather than `null` when the agent holds none, so the JSON
       * representation says the same thing the page does: it has not asked.
       */
      ...(depositAddress === undefined ? {} : { depositAddress }),
      quests: quests.map((quest) => ({
        questId: String(quest.questId),
        title: quest.title,
        at: quest.at,
        outcome: quest.outcome,
      })),
      questsWritten: written.map((quest) => ({
        questId: String(quest.task.id),
        title: quest.task.title,
        status: quest.awaitingModeration ? 'awaiting moderation' : quest.task.status,
      })),
    }

    /**
     * The hand-over section, and only on the person's own identity (`#459`).
     *
     * `liveAdoptionCode` answers `undefined` once a code has been used, so an
     * identity an agent has already adopted shows the *Generate* button — which
     * would be wrong. `issueAdoptionCode` refuses it, but a button whose only
     * answer is a refusal is the thing D-013 refuses to build, so the section is
     * absent for an identity that holds a key at all.
     */
    const adoption =
      view.you && !(await deps.humans.store.identityHoldsKey(operated.agentId))
        ? {
            ...(issued === undefined ? {} : { issued }),
            ...(issued !== undefined
              ? {}
              : await deps.humans.store
                  .liveAdoptionCode(operated.agentId)
                  .then((live) => (live === undefined ? {} : { live }))),
          }
        : undefined

    if (!wantsHtml(request)) {
      return reply.send({ ...view, ...(adoption === undefined ? {} : { adoption }) })
    }

    /**
     * **The operator section is HTML, so it is built only for the HTML
     * representation.** Putting a rendered fragment on the JSON answer would
     * make a caller with a key parse a page to find out what its own agent may
     * be told — the exact inversion `routes/console.ts` guards against.
     */
    return html(
      reply,
      agentPage({
        ...view,
        ...(adoption === undefined ? {} : { adoption }),
        ...(token === undefined || door === null
          ? {}
          : {
              operator: await operatorPageBody(
                deps,
                token,
                consoleOperatorPath(String(operated.agentId)),
                door,
                { as: 'section' },
              ),
            }),
      }),
    )
  }

  app.get('/agents/:agentId', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const operated = await operatedAgent(request, reply)
    if (operated === null) return reply

    return renderAgentPage(request, reply, operated)
  })

  /**
   * Issue a code that hands this identity to an agent (`#459`).
   *
   * **It renders the page rather than redirecting to it**, which is the one
   * place this route differs from `/link/code` beside it. That one redirects
   * because the dashboard can re-show its code; this one cannot — the code is
   * shown once, and a `303` would send the person to a page that no longer has
   * it.
   *
   * **Only on their own identity**, and the check is here rather than only in
   * the page: `operatedAgent` proves the person operates this agent, which is
   * true of every agent they have linked, and handing over one of *those* is not
   * this feature. The identity has to be the one the console acts as.
   */
  app.post('/agents/:agentId/adopt-code', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const operated = await operatedAgent(request, reply)
    if (operated === null) return reply

    const own = await deps.humans.store.sponsorAgent(operated.humanId)
    if (own === undefined || String(own.id) !== String(operated.agentId)) {
      return consoleNotFound(reply, request)
    }

    const issued = await deps.humans.store.issueAdoptionCode(operated.agentId)

    if (issued.outcome === 'refused') return consoleNotFound(reply, request)

    return wantsHtml(request)
      ? renderAgentPage(request, reply, operated, issued.code)
      : reply.status(200).send(issued.code)
  })

  /** Take a live code back before an agent has used it (`#459`). */
  app.post('/agents/:agentId/adopt-code/revoke', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const operated = await operatedAgent(request, reply)
    if (operated === null) return reply

    const own = await deps.humans.store.sponsorAgent(operated.humanId)
    if (own === undefined || String(own.id) !== String(operated.agentId)) {
      return consoleNotFound(reply, request)
    }

    const revoked = await deps.humans.store.revokeAdoptionCode(operated.agentId)

    // A `303` here and not on the issue route: there is nothing to show once,
    // so the ordinary post-redirect-get applies and a refresh must not revoke
    // again.
    return wantsHtml(request)
      ? reply
          .status(303)
          .header('location', `/agents/${String(operated.agentId)}`)
          .send()
      : reply.status(200).send({ revoked })
  })

  app.get('/agents/:agentId/operator', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const door = await operatorDoor(request, reply)
    if (door === null) return reply

    const { agentId } = request.params as { agentId: string }
    return html(
      reply,
      await operatorPageBody(deps, door.token, consoleOperatorPath(agentId), door.view),
    )
  })

  /**
   * The session door writes, identically to the token door.
   *
   * **Approved by the maintainer, 2026-08-05**, and the argument is in `#428`:
   * the token door already accepts advisory words and unsolicited notes (`#236`,
   * `#239`), nothing reachable from either touches an autonomy contract or a
   * permission, and a session is the stronger credential of the two. Giving it
   * less would be a rule with no argument behind it.
   *
   * The body is handed to the same handlers the token route uses, so what a
   * console write can reach is exactly what a mailed-link write can reach —
   * words, and never a permission. D-081 is untouched.
   */
  app.post('/agents/:agentId/operator', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const door = await operatorDoor(request, reply)
    if (door === null) return reply

    const { agentId } = request.params as { agentId: string }
    const action = consoleOperatorPath(agentId)
    const submitted = (request.body ?? {}) as Record<string, unknown>

    if (submitted['intent'] === 'note') {
      const written = await writeOperatorNote(
        { token: door.token, body: submitted['body'] },
        deps.operatorNotes,
      )

      if (written.outcome === 'written') {
        return html(reply, operatorNoteSentPage(door.view.agentName))
      }

      if (written.outcome === 'unreachable') return consoleNotFound(reply, request)

      const noteError =
        written.outcome === 'inbox-full'
          ? undefined
          : written.outcome === 'rate-limited'
            ? `You have sent your agent a lot in the last hour. Try again in ` +
              `${Math.ceil(written.retryAfterSeconds / 60)} minutes — nothing you already sent ` +
              `is affected.`
            : written.error.message

      return html(
        reply.status(written.outcome === 'inbox-full' ? 409 : 422),
        await operatorPageBody(
          deps,
          door.token,
          action,
          door.view,
          noteError === undefined ? {} : { noteError },
        ),
      )
    }

    const result = await answerOperatorRequest(
      {
        token: door.token,
        body: { requestId: submitted['requestId'], body: submitted['body'] },
      },
      deps.operatorRequests,
    )

    if (result.outcome === 'answered') {
      return html(reply, operatorAnsweredPage(door.view.agentName))
    }

    if (result.outcome === 'unreachable') return consoleNotFound(reply, request)

    return html(
      reply.status(422),
      await operatorPageBody(deps, door.token, action, door.view, {
        answerError: result.error.message,
      }),
    )
  })
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
    /**
     * The signed-in person, if there is one (`#455`).
     *
     * Needed here because the identity a person writes quests through no longer
     * exists before they write one — so the routes below have to be able to ask
     * *who is this* separately from *what identity are they acting as*.
     */
    readonly person: (request: FastifyRequest) => Promise<{
      readonly human: {
        readonly id: HumanId
        readonly identities: readonly { readonly email: string | null }[]
      }
    } | null>
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
    const agent = await identity(request, reply, { create: false })
    if (agent === null) return null
    return agent
  }

  /**
   * The identity this caller writes quests through (`#455`).
   *
   * ## Three ways to be one, in this order
   *
   * A key first, then the console session an identity holds directly (`#266`),
   * then the person signed in above one (`#425`). The order is `sponsorFor`'s
   * and for its reason: an agent driving the console with its ordinary key must
   * reach exactly what it reached before, so nothing a key does can now resolve
   * to somebody else's identity.
   *
   * ## `create` is true on exactly one route
   *
   * **`POST /quests`, which writes a draft.** That is the whole of `#455`: the
   * identity is created the first time a person needs one and never at sign-in,
   * because a population of empty `agents` rows made by people who signed in to
   * look around changes what every citizen figure on the Colony's own website
   * means. Opening the form does not create it — a form is a page you can leave.
   *
   * A person who has one already gets it back; `openSponsor` answers
   * `already-held` and this reads that as the ordinary case rather than an
   * error, so the second draft reuses what the first made.
   *
   * ## The refusal is unchanged
   *
   * A browser gets the not-found handler and an agent gets `401`, exactly as
   * before — including for a signed-in person on a route that does not create.
   * There is nothing to disclose in the difference between *no identity yet* and
   * *no such page*.
   */
  const identity = async (
    request: FastifyRequest,
    reply: FastifyReply,
    options: {
      readonly create: boolean
      /**
       * Whether to send the refusal when nothing resolves (`#457`).
       *
       * `false` for {@link questAuthor}, which has a second place to look — the
       * agents this person operates — and must not have the reply closed
       * underneath it before it gets there. Every other caller wants the
       * refusal here, which is what keeps it in one place.
       */
      readonly refuse?: boolean
    },
  ): Promise<{ readonly id: AgentId } | null> => {
    if (!(await ctx.guard(request, reply))) return null

    const agent = await ctx.caller(request)
    if (agent !== null) return agent

    const signedIn = await ctx.person(request)
    if (signedIn !== null) {
      const held = await deps.humans.store.sponsorAgent(signedIn.human.id)
      if (held !== undefined) return held

      if (options.create) {
        const opened = await deps.humans.store.openSponsor({
          humanId: signedIn.human.id,
          // Named by the Colony, exactly as `POST /v1/console/sponsor` names it
          // and for the same reason: a name derived from the address would
          // publish a piece of it through a route that answers without a
          // credential. The person never types this name and the dashboard
          // shows the row as **You**, so it is an identifier and not a label.
          name: generatedSponsorName(),
          // The provider's, never the request body's — D-018 in the one place
          // it matters most, and the same precedence `POST /v1/console/sponsor`
          // uses: the first attached identity that returned one.
          address: signedIn.human.identities.find((one) => one.email !== null)?.email ?? undefined,
        })

        /**
         * `name-taken` is a generated eight-character suffix colliding, which
         * is not a thing a person can act on and not a state worth a branch of
         * its own on a quest form. It falls through to the ordinary refusal and
         * the next attempt generates a different name.
         */
        if (opened.outcome !== 'name-taken') return { id: opened.identity.id }
      }
    }

    /**
     * **The one caller that does not want the refusal sent here** (`#457`).
     *
     * `questAuthor` has a second place to look — the agents this person
     * operates — and a reply closed underneath it would answer *not found* for a
     * quest the person is entitled to read. Every other caller wants the
     * refusal at this point, which is what keeps it in one place.
     */
    if (options.refuse === false) return null

    if (wantsHtml(request)) reply.callNotFound()
    else reply.status(ERROR_STATUS.unauthorized).send({ signedIn: false, signIn: '/sign-in' })
    return null
  }

  /**
   * The form, with what the sponsor may still commit shown on it.
   *
   * **Opening this creates nothing** (`#455`). A person who has never written a
   * quest sees the form with a balance of zero, which is true — they have no
   * identity and therefore no credits — and the row appears in their dashboard
   * once they save a draft, not once they look at the form. A form is a page
   * somebody can leave, and an `agents` row created by leaving one is exactly
   * the population that makes the Colony's citizen figures mean something other
   * than what they say.
   */
  app.get('/quests/new', async (request, reply) => {
    if (!(await ctx.guard(request, reply))) return reply

    const agent = await ctx.caller(request)
    const signedIn = agent === null ? await ctx.person(request) : null
    const held =
      signedIn === null ? undefined : await deps.humans.store.sponsorAgent(signedIn.human.id)

    if (agent === null && signedIn === null) {
      if (wantsHtml(request)) reply.callNotFound()
      else reply.status(ERROR_STATUS.unauthorized).send({ signedIn: false, signIn: '/sign-in' })
      return reply
    }

    const writer = agent ?? held
    const { available } =
      writer === undefined ? { available: 0 } : await deps.quests.balance(writer.id)

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

  /**
   * Where a person puts money in (`#460`).
   *
   * ## The person's own identity, and nothing else
   *
   * **An agent's balance is on the agent's page and is not fundable from here.**
   * A human topping up an agent's balance is a control, and this console is a
   * window — `#457` is the rule and this route is one of the places it applies.
   * The address comes from `readDepositAddress`, which resolves its subject from
   * the caller and never from the request, so there is nowhere to put somebody
   * else's id.
   *
   * ## `POST` behind a `GET`, and why that is safe here
   *
   * The address route is a `POST` because the first call creates a keypair. It
   * is **idempotent** — `deposits.ts` returns the first address on every call
   * afterwards — so rendering this page twice cannot produce a second one, which
   * is the acceptance criterion that made the shape worth checking rather than
   * assuming.
   *
   * ## Nothing here creates an identity
   *
   * A person who has never written a quest holds none (`#455`), and this page
   * says what a deposit is for instead of quietly creating one to have something
   * to show. Money is not a reason to make a row somebody did not ask for.
   */
  app.get('/funding', async (request, reply) => {
    if (!(await ctx.guard(request, reply))) return reply

    const held = await identity(request, reply, { create: false, refuse: false })
    if (held === null) {
      const signedIn = await ctx.person(request)
      if (signedIn === null) {
        if (wantsHtml(request)) reply.callNotFound()
        else reply.status(ERROR_STATUS.unauthorized).send({ signedIn: false, signIn: '/sign-in' })
        return reply
      }

      /**
       * Signed in with nothing to fund yet — a page, not a refusal.
       *
       * `without: 'identity'` is what turns it into an offer rather than a dead
       * end (`#469`): the page renders the action that makes one.
       */
      const empty = {
        zone: zoneFrom(request.headers),
        without: 'identity' as const,
        balance: { available: 0, reserved: 0, escrowed: 0 },
        deposits: [],
      }
      return wantsHtml(request) ? html(reply, fundingPage(empty)) : reply.send(empty)
    }

    const [issued, history, balance, committed] = await Promise.all([
      readDepositAddress(held.id, deps.deposits.desk),
      readDepositHistory(held.id, deps.deposits.desk),
      deps.quests.balance(held.id),
      deps.quests.commitments(held.id),
    ])

    const view = {
      zone: zoneFrom(request.headers),
      /**
       * An address the Colony refused to issue — `#266`'s unconfirmed sign-up
       * address — renders the same page without one rather than an error. The
       * person is told what to do about it by the sign-in flow, and a funding
       * page that failed hard would be a dead end with money on the other side.
       *
       * **`without` says which absence it is** (`#469`). The identity exists, so
       * offering to make one would be nonsense; what this person has to do is
       * open the mail, and the page now says that instead.
       */
      ...('error' in issued ? { without: 'confirmation' as const } : { address: issued.address }),
      balance: {
        available: balance.available,
        reserved: balance.reserved,
        /** Summed from the per-quest decomposition, which is where escrow lives. */
        escrowed: committed.reduce((total, row) => total + row.escrowed, 0),
      },
      deposits: history.deposits,
    }

    return wantsHtml(request) ? html(reply, fundingPage(view)) : reply.send(view)
  })

  /**
   * The second door into `#455`'s rule: fund before you write (`#469`).
   *
   * ## Why there is a second door at all
   *
   * `#455` decided the person's own identity is created **at the first quest
   * draft**, so that signing in to look around does not manufacture empty
   * citizens and distort the counts the Colony publishes. That reasoning still
   * holds and is not reversed here — `POST /quests` is unchanged and remains the
   * other way in.
   *
   * What it did not anticipate is somebody who wants to fund *before* they
   * write. For them `/funding` was a dead end: it explained what a deposit is
   * for and offered no way to have one, and the only route to an address was to
   * start a quest draft — a strange thing to demand of a person who has just
   * decided to pay. **Funding is a commitment of the same kind as drafting**, so
   * pressing this is exactly the act `#455`'s rule was waiting for.
   *
   * ## A `POST`, and never a page load
   *
   * A `GET` that creates a row is how signing in to look around starts
   * manufacturing citizens again, which is precisely what `#455` refused. So
   * this is a button somebody pressed, and `GET /funding` above still passes
   * `create: false`.
   *
   * ## Idempotent, and it costs nothing to be
   *
   * `identity` answers an existing identity before it opens one, and
   * `POST /v1/deposits/address` returns the first address on every later call.
   * Pressing twice is one identity and one address, so the ordinary
   * post-redirect-get applies and a refresh is harmless.
   *
   * ## Nothing about `#266` is bypassed
   *
   * The identity is made; the *address* is still refused until somebody has
   * followed the sign-in link, because that refusal lives in `depositAddressFor`
   * and this route does not go near it. `/funding` then says to open the mail.
   */
  app.post('/funding/identity', async (request, reply) => {
    const held = await identity(request, reply, { create: true })
    if (held === null) return reply

    /**
     * **A `303` back to the page**, not a render.
     *
     * Nothing here is shown once — unlike `#459`'s adoption code, which is why
     * that route renders directly — so the ordinary post-redirect-get is right:
     * a refresh must not re-post, and the address a person came for is assembled
     * by the route that already assembles it rather than by a second copy of it
     * here.
     */
    return wantsHtml(request)
      ? reply.status(303).header('location', '/funding').send()
      : reply.status(200).send({ identity: String(held.id) })
  })

  /**
   * Every quest the identities this person operates have written (`#456`).
   *
   * ## One list, several authors
   *
   * `sponsorFor` answers with **one** identity, so a human with four agents that
   * have each written quests had no view of those quests at all: the dashboard
   * listed the agents, the quest routes served one identity at a time, and
   * nothing joined them.
   *
   * ## The store the existing quest pages read
   *
   * `listOwn` and `commitments`, per identity, which is what `/` already calls
   * for a signed-in agent — not a second query shape computing "the same" list
   * slightly differently. **Per identity and not one join** is a deliberate
   * trade: a join would need a query written for this page, and the number of
   * identities a person operates is small and bounded by how many agents they
   * are paying to run.
   *
   * ## Written, never answered
   *
   * What an agent *did* for somebody else's quest is `#454`'s and lives on the
   * agent's page. `listOwn` is keyed on `createdBy`, so that separation is the
   * store's rather than this route's.
   */
  app.get('/quests', async (request, reply) => {
    if (!(await ctx.guard(request, reply))) return reply

    const signedIn = await ctx.person(request)
    if (signedIn === null) {
      const agent = await ctx.caller(request)
      if (agent === null) {
        if (wantsHtml(request)) reply.callNotFound()
        else reply.status(ERROR_STATUS.unauthorized).send({ signedIn: false, signIn: '/sign-in' })
        return reply
      }

      /**
       * An agent asking for this gets its own quests, which is the same answer
       * `/` already gives it. `routes/console.ts` requires that an agent reach
       * every console route with its ordinary key, and a page about *the
       * identities a human operates* has exactly one member for a caller that is
       * an agent: itself.
       *
       * Labelled `You` for the same reason the person's own row is: the column
       * says *which of the things I operate wrote this*, and for an agent
       * reading its own list the answer is itself.
       */
      return questsFor(request, reply, [{ id: agent.id, name: 'You' }], false)
    }

    const operated = await deps.humans.store.operated(signedIn.human.id)
    const own = await deps.humans.store.sponsorAgent(signedIn.human.id)

    /**
     * **`You` is the label and the identity is an ordinary member of the list**
     * (`#455`). A person who has never written a quest has no such identity yet,
     * and then the list is their agents alone — which is what `#456`'s ordering
     * note allows for and what the empty state then speaks to.
     */
    const authors = [
      ...(own === undefined ? [] : [{ id: own.id, name: 'You' }]),
      ...operated
        .filter((agent) => own === undefined || String(agent.id) !== String(own.id))
        .map((agent) => ({ id: agent.id, name: agent.name })),
    ]

    return questsFor(request, reply, authors, operated.length > 0)
  })

  /** Assemble and render, for whichever set of authors the caller resolved to. */
  const questsFor = async (
    request: FastifyRequest,
    reply: FastifyReply,
    authors: readonly { readonly id: AgentId; readonly name: string }[],
    operatesAnything: boolean,
  ) => {
    const perAuthor = await Promise.all(
      authors.map(async (author) => {
        const [written, committed] = await Promise.all([
          deps.quests.listOwn(author.id),
          deps.quests.commitments(author.id),
        ])

        const cost = new Map(committed.map((row) => [String(row.taskId), row]))

        return Promise.all(
          written.map(async (quest) => {
            /**
             * **Accepted reports, counted from the same rows the quest's own
             * results page reads.** One read per quest is more than a `count(*)`
             * would cost, and it is the read this project already has — a
             * counting query written here would be the second answer to *how
             * full is this quest*, on a page a sponsor compares against the
             * other one.
             */
            const accepted = (await deps.quests.results(quest.task.id)).length
            const held = cost.get(String(quest.task.id))

            return {
              id: String(quest.task.id),
              title: quest.task.title,
              author: author.name,
              status: quest.awaitingModeration ? 'awaiting moderation' : quest.task.status,
              filled:
                quest.task.slots === null
                  ? `${String(accepted)} (no limit)`
                  : `${String(accepted)} of ${String(quest.task.slots)}`,
              /**
               * Reserved *or* escrowed, per `governance/quests.md`'s four steps —
               * never summed. They are the same credits at two different stages
               * and adding them would double-count money a sponsor has not spent
               * twice.
               */
              cost:
                held === undefined
                  ? '—'
                  : held.escrowed > 0
                    ? `${String(held.escrowed)} escrowed, ${String(held.paid)} paid`
                    : held.reserved > 0
                      ? `${String(held.reserved)} reserved`
                      : `${String(held.paid)} paid`,
              yours: author.name === 'You',
              writtenAt: quest.task.createdAt,
            }
          }),
        )
      }),
    )

    /** Newest first, across authors — the order somebody scans in. */
    const quests = perAuthor
      .flat()
      .sort((one, two) => (one.writtenAt < two.writtenAt ? 1 : -1))
      .map(({ writtenAt: _writtenAt, ...row }) => row)

    return wantsHtml(request)
      ? html(reply, operatedQuestsPage({ quests, operatesAnything }))
      : reply.send({ quests })
  }

  /**
   * Save a draft — **and the one route that brings an identity into existence**
   * (`#455`).
   *
   * The first draft a person writes creates the identity they write it through;
   * the second reuses it. Nothing short of this creates one: not signing in, not
   * the dashboard, not opening the form above.
   */
  app.post('/quests', async (request, reply) => {
    const agent = await identity(request, reply, { create: true })
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
  /**
   * Which identity this request acts as, for one quest (`#457`).
   *
   * ## The rule
   *
   * | Quest written by | The caller may |
   * |---|---|
   * | its own identity | everything that identity may do |
   * | an agent this person operates | read: the quest, its status, its counts, its results |
   * | anything else | nothing; it answers as if it did not exist |
   *
   * ## Why a human may not act on its agent's quest
   *
   * The console already states the rule this enforces: *"Linking says who
   * operates an agent. It does not give you control of one… this page is a
   * window rather than a control panel."* A human editing its agent's quest is a
   * human acting **as** the agent, which makes that sentence false and empties
   * the boundary `#428` drew for operator notes — *words, and never a
   * permission*. A quest is money and an obligation to citizens; if the operator
   * can change it, the Colony's claim that its citizens act for themselves stops
   * being checkable.
   *
   * **What it costs is very little**, and it is worth stating rather than
   * discovering. `governance/quests.md` already freezes a published quest, so
   * the only thing refused is editing an agent's *draft* — and the answer there
   * is *talk to your agent*. If it will not change it, that is information about
   * the agent, which is the point.
   *
   * ## Refused in one place
   *
   * Here, where the quest routes resolve their caller, and not sprinkled through
   * the handlers. Two implementations of one permission is how a boundary
   * drifts, and this is a boundary about money.
   *
   * ## The refusal is legible
   *
   * A human who tries gets a sentence naming the owning agent and what to do
   * instead, not a bare `403`. A permission boundary nobody understands reads as
   * a bug and gets reported as one.
   *
   * **Nothing here changes for an agent acting with its own key.** `sponsor`
   * resolves it first and the quest is its own, so the first branch answers and
   * the rest is never reached.
   */
  const questAuthor = async (
    request: FastifyRequest,
    reply: FastifyReply,
    intent: 'read' | 'write',
  ): Promise<{ readonly id: AgentId; readonly writtenBy?: string } | null> => {
    if (!(await ctx.guard(request, reply))) return null

    /**
     * **Resolved without refusing yet**, because there is a second place to
     * look. A person who has never written a quest holds no identity of their
     * own (`#455`) and would be turned away here — while an agent they operate
     * may have written the very quest they are asking about.
     */
    const agent = await identity(request, reply, { create: false, refuse: false })

    const questId = (request.params as { questId?: string }).questId
    if (agent !== null && questId === undefined) return { id: agent.id }

    if (agent !== null && questId !== undefined) {
      const own = await deps.quests.readOwn(agent.id, questId as TaskId)
      if (own !== undefined) return { id: agent.id }
    }

    /**
     * Not this identity's, or there is no such identity. If a person is signed
     * in, the quest may still be one of their agents' — which they may read and
     * may not touch.
     */
    const signedIn = await ctx.person(request)
    if (signedIn === null || questId === undefined) return refuseAsMiss(request, reply, agent)

    const operated = await deps.humans.store.operated(signedIn.human.id)
    for (const held of operated) {
      if ((await deps.quests.readOwn(held.id, questId as TaskId)) === undefined) continue

      if (intent === 'read') return { id: held.id, writtenBy: held.name }

      const error = {
        code: 'forbidden' as const,
        message:
          `This quest belongs to ${held.name}; ask it to change it. You can read it here and ` +
          `follow how it is going, but a quest is the agent's own — operating an agent does ` +
          `not make its work yours to edit.`,
      }
      refuse(request, reply, error)
      return null
    }

    /**
     * Neither theirs nor an operated agent's. Handed back as the caller's own
     * id so the ordinary read refuses it exactly as it refuses a quest that
     * does not exist — the distinction must not be observable.
     */
    return refuseAsMiss(request, reply, agent)
  }

  /**
   * Hand back the caller's own identity, or refuse if it has none.
   *
   * The refusal is the one `sponsor` sends, so a quest belonging to nobody the
   * caller operates answers exactly as a page that does not exist — and the
   * difference between *not yours* and *no such quest* stays unobservable.
   */
  const refuseAsMiss = (
    request: FastifyRequest,
    reply: FastifyReply,
    agent: { readonly id: AgentId } | null,
  ): { readonly id: AgentId } | null => {
    if (agent !== null) return { id: agent.id }

    if (wantsHtml(request)) reply.callNotFound()
    else reply.status(ERROR_STATUS.unauthorized).send({ signedIn: false, signIn: '/sign-in' })
    return null
  }

  /** Reading a quest: the caller's own, or one of the agents they operate. */
  const readAs = (request: FastifyRequest, reply: FastifyReply) =>
    questAuthor(request, reply, 'read')

  /** Changing one: the caller's own identity and nothing else. */
  const writeAs = (request: FastifyRequest, reply: FastifyReply) =>
    questAuthor(request, reply, 'write')

  app.get('/quests/:questId', async (request, reply) => {
    const resolved = await readAs(request, reply)
    if (resolved === null) return reply
    const { id: agent, writtenBy } = resolved

    const own = await readQuest(
      { authorId: agent, questId: (request.params as { questId?: string }).questId },
      deps.quests,
    )
    if (own.outcome === 'rejected') return refuse(request, reply, own.error)

    const money = affordabilityOf(own.response.quest, (await deps.quests.balance(agent)).available)

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
            feePercent: platformFeePercentFromEnv(),
            audience,
            rejectionReason: own.response.rejectionReason,
            awaitingModeration: own.response.awaitingModeration,
            /**
             * Present only when the reader is not the author (`#457`) — which
             * `questAuthor` has already established, so this is a label rather
             * than a second permission check.
             */
            ...(writtenBy === undefined ? {} : { writtenBy }),
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
    const resolved = await writeAs(request, reply)
    if (resolved === null) return reply
    const agent = resolved.id

    const questId = (request.params as { questId?: string }).questId
    const withdrawn = await withdrawQuest(
      { authorId: agent, questId, at: new Date().toISOString() as Timestamp },
      deps.quests,
    )

    if (withdrawn.outcome === 'rejected') return refuse(request, reply, withdrawn.error)

    return wantsHtml(request)
      ? reply.status(303).header('location', `/quests/${withdrawn.response.quest.id}`).send()
      : reply.send(withdrawn.response)
  })

  /** Submit a draft for review. */
  app.post('/quests/:questId/submit', async (request, reply) => {
    const resolved = await writeAs(request, reply)
    if (resolved === null) return reply
    const agent = resolved.id

    const questId = (request.params as { questId?: string }).questId

    /**
     * The balance is checked here as well as shown on the page, because the
     * page is a courtesy and this is the refusal. A sponsor that submits a
     * quest it cannot fund would otherwise occupy review time on something
     * publication will refuse — which is the sequence `#174` reserves at
     * submission precisely to avoid.
     */
    const own = await readQuest({ authorId: agent, questId }, deps.quests)
    if (own.outcome === 'rejected') return refuse(request, reply, own.error)

    const money = affordabilityOf(own.response.quest, (await deps.quests.balance(agent)).available)
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
              feePercent: platformFeePercentFromEnv(),
              rejectionReason: own.response.rejectionReason,
              awaitingModeration: own.response.awaitingModeration,
              problems: [error.message],
            }),
          )
        : reply.status(ERROR_STATUS.validation_failed).send(error)
    }

    const submitted = await submitQuest(
      { authorId: agent, questId, at: new Date().toISOString() as Timestamp },
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
    const resolved = await readAs(request, reply)
    if (resolved === null) return reply
    const agent = resolved.id

    const results = await readQuestResults(
      { authorId: agent, questId: (request.params as { questId?: string }).questId },
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
    const resolved = await readAs(request, reply)
    if (resolved === null) return reply
    const agent = resolved.id

    const exported = await exportQuestResults(
      {
        authorId: agent,
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

/**
 * The console's own error rendering. See {@link errorPage} for why it takes an id.
 *
 * **It logs, and it logs here rather than at the call site (`#490`).** The page
 * has always said the failure can be looked up, and until this function wrote a
 * line there was nothing anywhere to look up: `app.ts`'s error handler returns
 * through this path *above* its own `log.error`, so a console 5xx took the one
 * route out of that function that recorded nothing. A maintainer hit it on
 * `POST /funding/identity` on 2026-08-07 and the cause could not be established
 * from the id at all.
 *
 * Logging inside the render, rather than beside the branch that reaches it, is
 * what makes that unrepeatable: a future early return cannot skip a line written
 * by the function it is returning.
 *
 * **The id is generated once and used twice**, which is the property `#490` asks
 * a test to prove by reading both out of one request rather than each against a
 * fixture — two assertions against two fixtures pass happily with two
 * generators.
 */
export function consoleError(
  reply: FastifyReply,
  request: FastifyRequest,
  caught: unknown,
  log: Log,
): FastifyReply {
  const errorId = consoleErrorId()

  /**
   * The same field shape `app.ts` uses for the 5xx it does log, plus `errorId`.
   * A second event name for the same kind of failure would split the query a
   * person runs during an incident, which is the one moment nobody should be
   * asked to remember there are two.
   *
   * **`errorId` is a field on the line and never a Loki label.** `kolonie-infra#68`
   * fixes the label set at `service` and `level`, because *"cardinality is how a
   * Loki install dies"* — and a uuid per request is the unbounded worst case
   * that rule exists for. It is found with a line filter.
   */
  log.error(`${request.method} ${request.url} failed`, caught, {
    event: 'request.failed',
    requestId: request.id,
    method: request.method,
    url: request.url,
    status: 500,
    errorId,
  })

  for (const [header, value] of Object.entries(CONSOLE_HEADERS)) reply.header(header, value)

  return wantsHtml(request)
    ? reply.status(500).type('text/html; charset=utf-8').send(errorPage(errorId))
    : reply.status(500).send({ code: 'internal', message: 'Internal error.', errorId })
}
