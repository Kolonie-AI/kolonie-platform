import { randomUUID } from 'node:crypto'
import { handoverNotice } from '@kolonie-ai/core'
import {
  ERROR_STATUS,
  solFromLamports,
  platformFeePercentFromEnv,
  reportAudience,
  type AgentId,
  type ApiError,
  type HumanId,
  type Log,
  type QuestTier,
  type Task,
  type TaskId,
  type Timestamp,
  questCommitment,
} from '@kolonie-ai/core'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { authenticate } from '../authentication.js'
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
  CONSOLE_HEADERS,
  errorPage,
  keyMintedPage,
  keyPage,
  notFoundPage,
  accountDeletedPage,
  accountPage,
  dashboardPage,
  handoverPage,
  sessionsPage,
  signInPage,
} from '../console/html.js'
import type { ConsoleNav } from '../console/navigation.js'
import { zoneFrom } from '../console/time.js'
import { agentPage } from '../console/agent-page.js'
import { agentAccountsPage } from '../console/agent-accounts.js'
import { numbersPage, reviewQueuePage } from '../console/steward.js'
import { backendPage } from '../console/backend.js'
import { curationSections } from '../console/curation.js'
import { atlasCatalogue, atlasCuration } from '../provider-recipes.js'
import {
  operatedQuestsPage,
  questDraftPage,
  pairAnAgentPage,
  questFormPage,
  questResultsPage,
  questsPage,
} from '../console/sponsor.js'
import {
  AUDIENCE_CHOICES,
  PROOF_CHOICES,
  QUEST_FORM_FIELDS,
  SKILL_CHOICES,
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
  endQuest,
  writeQuestDraft,
} from '../quests.js'
import { stewardFor } from './privileged.js'
import { clientIp } from '../client-ip.js'
import { cookieValue, sessionCookie } from './authenticated.js'
import { consoleOperatorPath, operatorPageBody } from '../operator-page-body.js'
import type { OperatorPageView } from '@kolonie-ai/db'
import { operatorAnsweredPage, operatorNoteSentPage } from '../autonomy-page.js'
import { writeOperatorNote } from '../operator-notes.js'
import { answerOperatorRequest, isWaitingOnTheOperator } from '../operator-requests.js'
import { markWishWanted, putOnWishList, selectBundle } from '../account-wishes.js'
import type { WishCatalogueEntry } from '../console/agent-accounts.js'
import {
  atlasPickerIndex,
  atlasPickerPath,
  atlasPickerShelf,
  pickerCategory,
} from '../console/atlas-picker.js'
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
/**
 * What the dashboard says after a drop was filled from the queue (`#570`).
 *
 * **Keyed by `SubmitDropOutcome`**, so a new ending cannot be added to the
 * sealing path and quietly render as nothing here. `closed` is deliberately one
 * sentence for four states — expired, already answered, never a drop, or
 * somebody else's agent — on `submitDrop`'s own reasoning: telling them apart
 * would let a signed-in person learn that an id belongs to another operator's
 * fleet.
 */
const FILL_NOTICE: Record<string, string | undefined> = {
  accepted:
    'Sent. It went straight into that agent\u2019s vault, sealed \u2014 nobody can read it back ' +
    'out, including you and including the Colony. The agent carries on within moments.',
  closed:
    'That one is no longer open. It may have been answered already, or expired, or it is not ' +
    'yours to fill. Nothing was sent and nothing is held against the agent.',
  'key-taken':
    'The agent already holds something under that name in its vault, and the Colony will not ' +
    'overwrite it. Nothing was sent \u2014 the agent has to clear the old one or ask again ' +
    'under another name.',
  'vault-full':
    'That agent\u2019s vault is full, so there is nowhere for this to land. Nothing was sent; ' +
    'the agent has to remove something first.',
}

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
       * **The queue** (`#530`): every waiting request and drop across every
       * agent this person operates, in one list.
       *
       * One query rather than one per agent, which is where this differs from
       * the standing hints above. Those are per-agent by nature — each is the
       * sentence *that* agent will be told — while this is the inversion the
       * issue is about: twelve conversations become one queue, so it is one
       * question to the database and not twelve.
       *
       * Already ordered by what each item costs to clear. The renderer does not
       * sort.
       */
      const queue = await deps.humans.store.waitingOnThem(signedIn.human.id)

      /**
       * What just happened to a drop, carried across the redirect (`#570`).
       *
       * **A code from a closed set and never a sentence in the URL.** The
       * value is looked up here, so a link somebody was sent cannot put words
       * on this page in the Colony's voice — and the wording stays in one
       * place when it is edited.
       */
      const filled = FILL_NOTICE[String((request.query as { filled?: unknown }).filled ?? '')]

      return wantsHtml(request)
        ? html(
            reply,
            dashboardPage({
              nav: navFor(request, signedIn.human.roles),
              zone: zoneFrom(request.headers),
              agents,
              waiting: queue,
              code,
              maintains,
              ...(filled === undefined ? {} : { notice: filled }),
            }),
          )
        : reply.send({
            signedIn: true,
            agents,
            waiting: queue,
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
   * Fill a drop from the queue, as the person the agent asked (`#570`).
   *
   * ## Why this exists on the console at all
   *
   * `#530` built a queue that lists everything waiting on one person and could
   * act on one of the two kinds it lists. A question links to the operator page;
   * **a drop was named and went nowhere** — the cell said *use the link that was
   * mailed to you*, which sends somebody to their inbox for a three-day-old
   * mail. That is the item an operator does later or not at all, and `code`
   * ranks first in `WAITING_EFFORT` precisely because the value is already in
   * front of them. The queue was batching the questions and scattering the
   * codes.
   *
   * ## The trust boundary, decided
   *
   * **A signed-in operator is more strongly authenticated than a bearer link in
   * a mail**, and `human_agents` already answers *is this your agent*. That is
   * the authorisation and nothing weaker; the mailed link's own guards —
   * single-use, attempt-limited — protect a token, and this path presents none.
   * What that means for `attempts` and for the link's continued validity is
   * written on `fillDropAsOperator`, in the present tense, beside the sealing it
   * shares.
   *
   * **No drop is created here** (`#410`), the value is never shown back, and
   * nothing new seals anything: this reaches the same sealing `submitDrop` does.
   */
  app.post('/drops/:dropId', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const signedIn = await person(request)
    if (signedIn === null) return signInRequired(request, reply)

    const { dropId } = request.params as { dropId: string }
    const { value } = (request.body ?? {}) as { value?: unknown }

    /**
     * **`closed` when the channel is not configured**, which is the same answer
     * a stranger's drop id gets. A console that said *this Colony has no sealing
     * key* would be telling a signed-in person about the deployment rather than
     * about their own queue — and the queue cannot list a drop on a Colony that
     * could not have created one.
     */
    const result =
      deps.drops === undefined || typeof value !== 'string' || value === ''
        ? ({ outcome: 'closed' } as const)
        : await deps.drops.fillAsOperator(dropId, signedIn.human.id, value)

    if (!wantsHtml(request)) {
      return result.outcome === 'accepted'
        ? reply.status(200).send({ filled: true })
        : reply.status(ERROR_STATUS.conflict).send({
            code: 'conflict',
            message: FILL_NOTICE[result.outcome] ?? FILL_NOTICE['closed'],
          })
    }

    return reply.status(303).header('location', `/?filled=${result.outcome}`).send()
  })

  /**
   * Read a secret an agent sealed for its operator (`#592`).
   *
   * ## Why this is a POST and why it is on the console at all
   *
   * **A signed-in session is the only thing that authorises it.** The mailed
   * operator-page token never expires and is revoked only by the agent, and
   * `#587` already found it rendered into console HTML. Writing into a sealed
   * box through a bearer link discloses nothing; reading a password out of one
   * does. `readHandoverAsOperator` takes a human id and there is no token
   * parameter to leave out — the join is the authorisation.
   *
   * **POST rather than GET, because reading it spends one of three.** A browser
   * prefetching a link, a crawler following one, or a back button would each
   * burn a read of a live credential. The same reasoning every other state
   * change on this console is a form for, with more at stake.
   *
   * **The value is in the response body and nowhere else.** Not in the URL, not
   * in a redirect, not in a log line. The page that shows it says, before the
   * operator opens it, that it is not keeping a copy.
   */
  app.post('/handovers/:handoverId', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const signedIn = await person(request)
    if (signedIn === null) return signInRequired(request, reply)

    const { handoverId } = request.params as { handoverId: string }

    /**
     * `closed` when the channel is not configured, which is the same answer a
     * stranger's id gets and the same answer an expired one gets. A console that
     * distinguished them would be telling whoever asked about the deployment, or
     * about whether a row ever existed.
     */
    const result =
      deps.handovers === undefined
        ? ({ outcome: 'closed' } as const)
        : await deps.handovers.read(handoverId, signedIn.human.id)

    if (result.outcome !== 'read') {
      const message =
        'That secret is not readable. It has been read the number of times it allows, its few ' +
        'hours have passed, or it was never yours — the Colony answers the same way to all ' +
        'three on purpose. Ask your agent to seal another; it costs it nothing.'

      return wantsHtml(request)
        ? reply.status(303).header('location', '/?handover=closed').send()
        : reply.status(ERROR_STATUS.conflict).send({ code: 'conflict', message })
    }

    return wantsHtml(request)
      ? html(
          reply,
          handoverPage({
            nav: navFor(request, signedIn.human.roles),
            provider: result.provider,
            prompt: result.prompt,
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
  /** The page, assembled — used by the route and by every redirect back to it. */
  const renderBackend = async (request: FastifyRequest, reply: FastifyReply, notice?: string) => {
    const numbers = await deps.quests.numbers()
    // Two live queries beside the aggregates, each carrying its own moment
    // (`#487`). Not folded into `ColonyNumbers`: that object is aggregates
    // entirely, and showing individuals is a change of kind rather than one
    // more figure.
    const sections = await deps.quests.backendSections()
    // Who arrived (`#607`). Its own read, and it reaches no published figure.
    const arrivals = await deps.quests.arrivals()
    // Where the Colony knows nothing (`#611`).
    const unreported = await deps.quests.unreported()
    // Whether a briefing changes an outcome (`#609`).
    const briefings = await deps.quests.briefingEffect()
    const settings = await deps.settings.effective()
    // Providers writing in about the Atlas (`#544`). On the page before the form
    // is announced anywhere, because an enquiry nobody answers is worse than no
    // form.
    const enquiries = await deps.providerEnquiries.list()
    const curation = curationSections(await atlasCuration(deps.recipes))
    /**
     * What agents are asking for (`#534`).
     *
     * **Here and on no public route.** `kolonie-docs#216` gates the Colony's
     * stock figures until the majority of agents are not ours, and `/backend` is
     * behind the maintainer role — which is the only reason this may be drawn at
     * all. The floor is already applied in SQL, so nothing this route does can
     * widen it.
     */
    const wanted = await deps.wishes.store.wanted()

    return wantsHtml(request)
      ? html(
          reply,
          backendPage({
            nav: navFor(request, ['maintainer']),
            numbers,
            sections,
            arrivals,
            unreported,
            briefings,
            settings,
            enquiries,
            notice,
            curation,
            wanted,
          }),
        )
      : reply.send({
          numbers,
          ...sections,
          // The same answer the page renders (`#607`), not a thinner one.
          arrivals,
          unreported,
          briefings,
          enquiries,
          wanted,
          settings: settings.map((setting) => ({
            name: setting.definition.name,
            group: setting.definition.group,
            describes: setting.definition.describes,
            value: setting.value ?? null,
            source: setting.source,
            changedAt: setting.changedAt ?? null,
          })),
        })
  }

  /**
   * Mark one provider enquiry as dealt with (`#544`).
   *
   * **The only write this section has**, and there will not be a second: an
   * answer goes wherever the provider said to reach it, by a person. A reply box
   * here would be a mail queue built on the strength of a form nobody has filled
   * in yet.
   *
   * Behind the maintainer gate like everything else on this page, and a second
   * press is not an error — it is how somebody uses a button they are unsure
   * about, and the store leaves the first date alone.
   */
  app.post('/backend/enquiries/:id/handled', async (request, reply) => {
    const held = await maintainer(request, reply)
    if (held === null) return reply

    const { id } = request.params as { id?: string }
    const marked = id === undefined ? false : await deps.providerEnquiries.markHandled(id)

    return await renderBackend(
      request,
      reply,
      marked ? 'Marked as handled.' : 'That enquiry was already handled, or is not there.',
    )
  })

  app.get('/backend', async (request, reply) => {
    const held = await maintainer(request, reply)
    if (held === null) return reply

    return await renderBackend(request, reply)
  })

  /**
   * Set one value (`#489`).
   *
   * **One setting per POST**, never a page-wide save: a stale tab loaded before
   * somebody else's change would silently revert it.
   *
   * Validation is `writeSetting`'s, against the definition's own schema rather
   * than a looser one written for the form — and it happens **before the row is
   * written** rather than at the next loop, which is where a poll interval of
   * `0` would otherwise be discovered.
   */
  app.post('/backend/settings/:name', async (request, reply) => {
    const held = await maintainer(request, reply)
    if (held === null) return reply

    const { name } = request.params as { name?: string }
    const body = (request.body ?? {}) as { value?: unknown }

    const outcome = await deps.settings.write({
      name: name ?? '',
      value: typeof body.value === 'string' ? body.value : '',
      by: held.id,
    })

    if (outcome.outcome === 'unknown-setting') {
      // Refused, not *unsupported* (D-104). A name that is not in the allow-list
      // gets the console's 404 rather than an error naming what it is not.
      reply.callNotFound()
      return reply
    }

    if (outcome.outcome === 'invalid') {
      return wantsHtml(request)
        ? await renderBackend(request, reply.status(400), `${name ?? ''}: ${outcome.reason}`)
        : reply
            .status(ERROR_STATUS['validation_failed'])
            .send({ code: 'validation_failed', message: outcome.reason })
    }

    return wantsHtml(request)
      ? reply.status(303).header('location', '/backend').send()
      : reply.status(200).send({ name, written: true })
  })

  /**
   * And put one back to the environment's value.
   *
   * **A distinct action from writing the old number back**, because the old
   * number may itself have been an override — and this is the recovery path for
   * a maintainer who does not remember what it was.
   */
  app.post('/backend/settings/:name/clear', async (request, reply) => {
    const held = await maintainer(request, reply)
    if (held === null) return reply

    const { name } = request.params as { name?: string }
    const outcome = await deps.settings.clear({ name: name ?? '', by: held.id })

    if (outcome.outcome === 'unknown-setting') {
      reply.callNotFound()
      return reply
    }

    return wantsHtml(request)
      ? reply.status(303).header('location', '/backend').send()
      : reply.status(200).send({ name, cleared: outcome.outcome === 'cleared' })
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

    /**
     * The doors, and what is left to attach (`#574`).
     *
     * `OFFERED_PROVIDERS` minus the ones already held, so the page offers a
     * button only where pressing it would do something. With one provider in
     * that list this section says *every door is already attached* and offers
     * nothing, which is correct today and stops being the whole story the day
     * `#568` adds Google.
     */
    const held = signedIn.human.identities
    const doors = {
      held: held.map((identity) => ({ provider: identity.provider, email: identity.email })),
      offered: OFFERED_PROVIDERS.filter(
        (provider) => !held.some((identity) => identity.provider === provider),
      ),
    }

    /**
     * What the connect handover said, read back off the redirect (`#574`).
     *
     * A query parameter and not a flash cookie: the callback has nowhere to keep
     * a message, this site sets no cookie it does not need, and the three
     * sentences below say nothing a stranger could not already guess by trying.
     * Unknown values render no notice at all rather than being echoed.
     */
    const connected = (request.query as { connected?: unknown }).connected
    const notice =
      connected === 'attached'
        ? 'That provider is attached. Either one now signs you in to this account.'
        : connected === 'already-theirs'
          ? 'That provider was already attached to this account. Nothing changed.'
          : connected === 'taken'
            ? 'That provider is already attached to somebody else’s account, so nothing was changed here.'
            : undefined

    return wantsHtml(request)
      ? html(
          reply,
          accountPage({
            nav: navFor(request, signedIn.human.roles),
            zone: zoneFrom(request.headers),
            agents,
            unreachable,
            doors,
            notice,
          }),
        )
      : reply.send({ agents: exported.agents, unreachable, doors })
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
              nav: navFor(request, signedIn.human.roles),
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

    return wantsHtml(request)
      ? html(reply.status(200), keyMintedPage(result.apiKey, navFor(request)))
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
  ): Promise<{
    readonly humanId: HumanId
    readonly agentId: AgentId
    /** For the navigation, which is role aware on every page (`#608`). */
    readonly roles: readonly string[]
  } | null> => {
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

    return { humanId: signedIn.human.id, agentId: subject, roles: signedIn.human.roles }
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
    operated: {
      readonly agentId: AgentId
      readonly humanId: HumanId
      /** For the navigation, which is role aware on every page (`#608`). */
      readonly roles: readonly string[]
    },
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

    const [open, quests, written, walletAddress] = await Promise.all([
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
       * The wallet the agent proved, so the page can say where to send SOL
       * (`#573`). Read from the cleared challenge rather than from the profile's
       * free-text `wallet`, which is two questions with one shape of answer.
       */
      deps.store.verifiedWalletOf(operated.agentId),
    ])

    const view = {
      zone: zoneFrom(request.headers),
      agentId: String(operated.agentId),
      name: held.name,
      runtime: held.runtime,
      citizenship: held.citizenship,
      arrivedOn: held.arrivedOn,
      facts: held.facts,
      walletAddress,
      /**
       * Bounded here rather than in the page, because *how many is too many* is
       * a question about this surface and the frontier is a general answer. Five
       * is what fits above the fold at 375px.
       */
      opensNext:
        open.outcome === 'listed'
          ? open.page.items.map((task) => ({ title: task.title, requires: [...task.requires] }))
          : [],
      /**
       * Absent rather than `null` when the agent holds none, so the JSON
       * representation says the same thing the page does: it has not asked.
       */
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
     * Accounts, as the one line this page keeps (`#582`).
     *
     * On both representations, because a route here answers the same thing two
     * ways and never two different things.
     */
    const planned = await deps.wishes.store.list(operated.agentId)
    const accounts = {
      held: held.facts.accounts.reduce((sum, account) => sum + account.count, 0),
      planned: planned.length,
      wanted: planned.filter((wish) => wish.wantedAt !== null).length,
    }

    if (!wantsHtml(request)) {
      return reply.send({ ...view, accounts })
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
        nav: navFor(request, operated.roles),
        ...view,
        /**
         * Accounts as one line (`#582`).
         *
         * Counted here rather than rendered: the rows are on
         * `/agents/:agentId/accounts`, and a page that drew both would be two
         * records of one fact.
         */
        accounts,
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

  /**
   * What the catalogue says about each provider on one agent's list (`#581`).
   *
   * **Only the providers on the list**, which is what keeps this from being a
   * hundred-and-eight-entry read rendered as five rows. `atlasCatalogue` is one
   * query either way; the narrowing is of the map handed to the page, so the
   * renderer cannot accidentally show the whole Atlas in a table about a plan.
   */
  const wishCatalogue = async (
    dependencies: RouteDependencies,
    agentId: AgentId,
  ): Promise<Record<string, WishCatalogueEntry>> => {
    const [wishes, entries] = await Promise.all([
      dependencies.wishes.store.list(agentId),
      atlasCatalogue(dependencies.recipes),
    ])

    const wanted = new Set(wishes.map((wish) => wish.provider))
    const held: Record<string, WishCatalogueEntry> = {}

    for (const entry of entries) {
      if (!wanted.has(entry.provider)) continue

      held[entry.provider] = {
        status: entry.status,
        operatorNeed: entry.operatorNeed,
        /** The reason a refusal records, from the row that carries it. */
        refusal: entry.recipes.find((recipe) => recipe.refusal !== null)?.refusal ?? null,
      }
    }

    return held
  }

  app.get('/agents/:agentId', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const operated = await operatedAgent(request, reply)
    if (operated === null) return reply

    return renderAgentPage(request, reply, operated)
  })

  /**
   * One agent's accounts, on a page of their own (`#582`).
   *
   * **Three blocks became one page.** *Accounts proved*, *Hand this account to
   * an agent* and *Accounts you and this agent are planning* sat at three places
   * on the agent page with four unrelated sections between them, and three
   * headings imply three subjects. The agent page keeps a count and a link and
   * renders none of the rows — two records of one fact drift, which is D-002's
   * reason and not a new one.
   *
   * **The guard is `operatedAgent` and nothing else**, so somebody who does not
   * operate this agent gets exactly what they get from the agent page itself:
   * the console's 404, identical to the answer for an id that names nothing.
   * This page cannot be used to test for agents either.
   */
  const renderAgentAccounts = async (
    request: FastifyRequest,
    reply: FastifyReply,
    operated: {
      readonly agentId: AgentId
      readonly humanId: HumanId
      readonly roles: readonly string[]
    },
    issued?: { readonly code: string; readonly expiresAt: string },
  ) => {
    const held = await deps.autonomy.pages.factsOf(operated.agentId)
    if (held === null) return consoleNotFound(reply, request)

    /**
     * The hand-over section, and only on the person's own identity (`#459`).
     *
     * `liveAdoptionCode` answers `undefined` once a code has been used, so an
     * identity an agent has already adopted would show the *Generate* button —
     * which would be wrong. `issueAdoptionCode` refuses it, but a button whose
     * only answer is a refusal is the thing D-013 refuses to build, so the
     * section is absent for an identity that holds a key at all.
     */
    const adoption = !(await deps.humans.store.identityHoldsKey(operated.agentId))
      ? {
          ...(issued === undefined ? {} : { issued }),
          ...(issued !== undefined
            ? {}
            : await deps.humans.store
                .liveAdoptionCode(operated.agentId)
                .then((live) => (live === undefined ? {} : { live }))),
        }
      : undefined

    const wishes = await deps.wishes.store.list(operated.agentId)

    if (!wantsHtml(request)) {
      return reply.send({
        agentId: String(operated.agentId),
        name: held.name,
        held: held.facts.accounts,
        wishes,
        ...(adoption === undefined ? {} : { adoption }),
      })
    }

    return html(
      reply,
      agentAccountsPage({
        nav: navFor(request, operated.roles),
        agentId: String(operated.agentId),
        name: held.name,
        zone: zoneFrom(request.headers),
        held: held.facts.accounts,
        wishes,
        /**
         * What the catalogue holds for each provider on that list (`#581`).
         *
         * **Read here rather than joined in storage**, because a wish is what
         * somebody asked for and the catalogue is what the Colony knows today —
         * two facts with different lifetimes. Assembled from `atlasCatalogue`,
         * which is the same read the public Atlas and the picker make, so the
         * three cannot disagree about one provider.
         */
        catalogue: await wishCatalogue(deps, operated.agentId),
        // The recommendation, beside the list it fills (`#531`).
        bundles: await deps.wishes.store.bundles(),
        ...(adoption === undefined ? {} : { adoption }),
      }),
    )
  }

  app.get('/agents/:agentId/accounts', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const operated = await operatedAgent(request, reply)
    if (operated === null) return reply

    return renderAgentAccounts(request, reply, operated)
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

    /**
     * **`issueAdoptionCode` is the check, and it always was** (`#578`).
     *
     * This used to also require the agent to be the person's minted `sponsor-*`
     * identity. Nothing mints one now, so that guard would refuse every request
     * — and it was redundant anyway: adoption supplies a credential, so the
     * storage call refuses any identity that already holds one, which is the
     * durable form of the same question and does not depend on the console
     * being right.
     */
    const issued = await deps.humans.store.issueAdoptionCode(operated.agentId)

    if (issued.outcome === 'refused') return consoleNotFound(reply, request)

    return wantsHtml(request)
      ? renderAgentAccounts(request, reply, operated, issued.code)
      : reply.status(200).send(issued.code)
  })

  /** Take a live code back before an agent has used it (`#459`). */
  app.post('/agents/:agentId/adopt-code/revoke', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const operated = await operatedAgent(request, reply)
    if (operated === null) return reply

    const revoked = await deps.humans.store.revokeAdoptionCode(operated.agentId)

    // A `303` here and not on the issue route: there is nothing to show once,
    // so the ordinary post-redirect-get applies and a refresh must not revoke
    // again.
    return wantsHtml(request)
      ? reply
          .status(303)
          .header('location', `/agents/${String(operated.agentId)}/accounts`)
          .send()
      : reply.status(200).send({ revoked })
  })

  /**
   * The operator's half of the shared list (`#527`).
   *
   * **Three writes and not one taking a verb**, on the reasoning `accounts.ts`
   * gives about its six small tools: adding, deciding and withdrawing are three
   * different intentions, and a handler that reads an action out of the body
   * cannot refuse the one it did not mean to offer.
   *
   * All three authorise through {@link operatedAgent}, so a person can only
   * touch the list of an agent they operate — and the author is decided by which
   * route was called rather than by a field.
   */
  app.post('/agents/:agentId/wishes', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const operated = await operatedAgent(request, reply)
    if (operated === null) return reply

    const added = await putOnWishList(operated.agentId, 'operator', request.body, deps.wishes)
    if (added.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[added.error.code]).send(added.error)
    }

    /**
     * Where the operator lands afterwards (`#591`).
     *
     * **Back to the shelf they were reading, when they came from one.** Somebody
     * equipping an agent adds four things from one shelf, and a redirect to the
     * agent page after each would make them navigate back three times. The agent
     * page stays the destination for the free-text field beside the list, which
     * is where they already were.
     *
     * **The shelf is read from the closed vocabulary and never from the body as
     * given**, so this cannot be talked into redirecting anywhere but a page
     * this file owns — a `returnTo` would have been the ordinary shape and the
     * ordinary open redirect.
     */
    const shelf = pickerCategory((request.body as { category?: unknown } | undefined)?.category)
    const back =
      shelf === undefined
        ? `/agents/${String(operated.agentId)}/accounts`
        : `${atlasPickerPath(String(operated.agentId), shelf)}` +
          (added.outcome === 'already-listed'
            ? `&already=${encodeURIComponent(added.wish.provider)}`
            : '')

    return wantsHtml(request)
      ? reply.status(303).header('location', back).send()
      : reply.status(added.outcome === 'added' ? 201 : 200).send({ wish: added.wish })
  })

  /**
   * Browsing the catalogue from the console (`#591`).
   *
   * **Its own route under the accounts area rather than a block on the agent
   * page.** `#582` is moving the three account blocks to
   * `/agents/:agentId/accounts`, and a browser built into the page it is about
   * to move would be built twice; a page at
   * `/agents/:agentId/accounts/browse` is where that issue would have put it
   * anyway, and links to it from either place cost one line.
   *
   * It reads `atlasCatalogue` — the same assembly the public Atlas and
   * `kolonie.accounts.recipes` read — so the console cannot drift from what a
   * stranger sees.
   */
  app.get('/agents/:agentId/accounts/browse', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const operated = await operatedAgent(request, reply)
    if (operated === null) return reply

    const [entries, wishes, accounts] = await Promise.all([
      atlasCatalogue(deps.recipes),
      deps.wishes.store.list(operated.agentId),
      deps.accounts.register.list(operated.agentId),
    ])

    const state = {
      listed: new Set(wishes.map((wish) => wish.provider)),
      /**
       * **Providers, not kinds.** An agent holding one mailbox has not exhausted
       * the mailbox shelf, and a picker that greyed out twelve providers because
       * one account exists would be answering a question nobody asked.
       */
      held: new Set(
        accounts.flatMap((account) => (account.provider === null ? [] : [account.provider])),
      ),
    }

    const { category, already } = request.query as { category?: unknown; already?: unknown }
    const shelf = pickerCategory(category)

    const input = {
      nav: navFor(request, operated.roles),
      agentId: String(operated.agentId),
      entries,
      state,
      ...(typeof already === 'string' ? { alreadyListed: already } : {}),
    }

    /**
     * **An unknown shelf lands on the list of shelves rather than on a 404.** A
     * category is a name in a link, and somebody who edits one out of curiosity
     * has not found a missing page — they have asked for a shelf that does not
     * exist, and the list of the ones that do is the answer.
     */
    return html(
      reply,
      shelf === undefined
        ? atlasPickerIndex(input)
        : atlasPickerShelf({ ...input, category: shelf }),
    )
  })

  /**
   * Take a bundle, in one action (`#531`).
   *
   * **It writes wishes and marks nothing wanted.** Choosing a bundle is choosing
   * what to consider; the decision that lets a recipe act on an entry is still
   * made item by item, on the route above. A bundle that arrived pre-approved
   * would turn the one judgement `#527` reserves for a person into a side effect
   * of a button.
   */
  app.post('/agents/:agentId/wishes/bundle', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const operated = await operatedAgent(request, reply)
    if (operated === null) return reply

    /**
     * A form with one ticked box sends a string and one with several sends an
     * array — the ordinary HTML shape, normalised here rather than in the domain
     * function, which takes the same body the JSON caller sends.
     */
    const body = (request.body ?? {}) as { slug?: unknown; entries?: unknown }
    const entries =
      typeof body.entries === 'string'
        ? [body.entries]
        : Array.isArray(body.entries)
          ? body.entries
          : undefined

    const result = await selectBundle(
      operated.agentId,
      { slug: body.slug, ...(entries === undefined ? {} : { entries }) },
      deps.wishes,
    )

    if (result.outcome === 'rejected') {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    if (result.outcome === 'no-such-bundle') {
      return consoleNotFound(reply, request)
    }

    return wantsHtml(request)
      ? reply
          .status(303)
          .header('location', `/agents/${String(operated.agentId)}/accounts`)
          .send()
      : reply.status(200).send({ added: result.added, alreadyListed: result.alreadyListed })
  })

  /**
   * The mark that turns a wish into something that may be attempted.
   *
   * **Only the operator can make it, and that is the whole of what it means.**
   * An agent that could set it would be agreeing with itself; there is
   * deliberately no MCP call that reaches this.
   */
  app.post('/agents/:agentId/wishes/want', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const operated = await operatedAgent(request, reply)
    if (operated === null) return reply

    const { provider } = (request.body ?? {}) as { provider?: unknown }
    if (typeof provider !== 'string' || provider.trim() === '') {
      return reply.status(ERROR_STATUS.validation_failed).send({
        code: 'validation_failed',
        message: 'Name the provider on the list to mark as wanted.',
      })
    }

    /**
     * Through the domain function rather than the store (`#580`), so the mark
     * and the knock cannot come apart on a surface somebody adds later.
     */
    const marked = await markWishWanted(
      operated.agentId,
      provider.trim().toLowerCase(),
      deps.wishes,
    )

    return wantsHtml(request)
      ? reply
          .status(303)
          .header('location', `/agents/${String(operated.agentId)}/accounts`)
          .send()
      : reply.status(200).send({ marked })
  })

  /**
   * Take something off the list.
   *
   * **This is also how an operator withdraws a yes**, which is why there is no
   * *unwanted* state: a third value would be something every reader has to
   * handle for a case a removal already covers, and it would leave a row saying
   * *refused* about a provider somebody may simply have changed their mind on.
   */
  app.post('/agents/:agentId/wishes/remove', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const operated = await operatedAgent(request, reply)
    if (operated === null) return reply

    const { provider } = (request.body ?? {}) as { provider?: unknown }
    if (typeof provider !== 'string' || provider.trim() === '') {
      return reply.status(ERROR_STATUS.validation_failed).send({
        code: 'validation_failed',
        message: 'Name the provider to take off the list.',
      })
    }

    const removed = await deps.wishes.store.remove(operated.agentId, provider.trim().toLowerCase())

    return wantsHtml(request)
      ? reply
          .status(303)
          .header('location', `/agents/${String(operated.agentId)}/accounts`)
          .send()
      : reply.status(200).send({ removed })
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
      /**
       * Whether a question of the citizen's is still open (`#564`).
       *
       * **Read here rather than assumed**, because the confirmation page has to
       * say so: a note leaves an open question open, and a person who thought
       * they had just answered one finds out on the page that says *sent*
       * instead of at their agent's sixth blocked run.
       */
      const stillWaiting = isWaitingOnTheOperator(
        await deps.operatorRequests.store.exchangesForToken(door.token),
      )

      const written = await writeOperatorNote(
        { token: door.token, body: submitted['body'] },
        deps.operatorNotes,
      )

      if (written.outcome === 'written') {
        return html(reply, operatorNoteSentPage(door.view.agentName, stillWaiting))
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
        /** For the navigation, which is role aware on every page (`#608`). */
        readonly roles: readonly string[]
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
    const agent = await identity(request, reply, {})
    if (agent === null) return null
    return agent
  }

  /**
   * The tier ceilings in force, for the pages that quote one (`#630`).
   *
   * **Per render rather than per process**, which is the whole of what D-104
   * bought: a maintainer who lowers a ceiling sees the form say so within the
   * settings cache's thirty seconds, without a deploy and without a restart.
   * The cost is one map lookup — the reader caches — so this is not a query per
   * page view.
   *
   * A desk without the method falls back to the constants inside `capsOf`; here
   * it means the page renders exactly what it rendered before this existed.
   */
  const tierCaps = async (): Promise<Readonly<Record<QuestTier, number>> | undefined> =>
    await deps.quests.tierCaps?.()

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

    /**
     * **A signed-in person resolves to no identity at all** (`#578`).
     *
     * This used to answer with the `sponsor-*` identity the console minted for
     * them, and to mint one on the first draft. Nothing mints one now, and
     * resolving a person to an agent they merely operate would put their hand on
     * that agent's work — which `#457` refused in as many words: *operating an
     * agent does not make its work yours to edit*.
     *
     * So the person falls through to the refusal, and the callers that have a
     * second place to look — {@link questAuthor}, which searches the agents they
     * operate in order to let them **read** — still find what they are entitled
     * to.
     */

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

    if (agent === null && signedIn === null) {
      if (wantsHtml(request)) reply.callNotFound()
      else reply.status(ERROR_STATUS.unauthorized).send({ signedIn: false, signIn: '/sign-in' })
      return reply
    }

    /**
     * **The form is the agent's, and a person is shown the way to it** (`#578`).
     *
     * An agent caller gets the form. A person gets the page that says an agent
     * writes this — and, where they have paired none, that pairing is the first
     * step. The console no longer opens an identity for them to write through.
     */
    if (signedIn !== null) {
      const operated = await deps.humans.store.operated(signedIn.human.id)

      return wantsHtml(request)
        ? html(reply, pairAnAgentPage(navFor(request, signedIn.human.roles), operated.length > 0))
        : reply.send({
            writtenBy: 'agent',
            tool: 'kolonie.quests.write',
            pairAt: '/',
            operates: operated.length,
          })
    }

    const caps = await tierCaps()

    return wantsHtml(request)
      ? html(reply, questFormPage({ nav: navFor(request), caps }))
      : reply.send({
          fields: QUEST_FORM_FIELDS,
          skills: SKILL_CHOICES,
          audiences: AUDIENCE_CHOICES,
          proofVerifiers: PROOF_CHOICES,
          proofNote: proofNote(null, caps),
        })
  })

  /**
   * **The funding page and `POST /funding/identity` are gone** — `#506`, D-106.
   *
   * They existed to hand a person a deposit address the Colony held the key to,
   * and to open a `sponsor-*` identity to hang it on. Under D-106 the Colony
   * generates no address for anybody: a sponsor pays a quest invoice in SOL from
   * a wallet it controls, and the invoice is on the quest rather than on a
   * funding page.
   *
   * What a person needs instead is on `kolonie-platform#540` — pricing a quest
   * in SOL where a sponsor writes one — and `#539`, which is what lets a person
   * verify the wallet they would pay from at all.
   */

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

    /**
     * **The list is their agents, and nothing else** (`#578`). It used to carry
     * the minted identity first, labelled `You`; there is no such identity now,
     * and every author here is an agent the person paired and named.
     */
    const authors = [...operated.map((agent) => ({ id: agent.id, name: agent.name }))]

    return questsFor(request, reply, authors, operated.length > 0, signedIn.human.roles)
  })

  /** Assemble and render, for whichever set of authors the caller resolved to. */
  const questsFor = async (
    request: FastifyRequest,
    reply: FastifyReply,
    authors: readonly { readonly id: AgentId; readonly name: string }[],
    operatesAnything: boolean,
    /** For the navigation, which is role aware on every page (`#608`). */
    roles: readonly string[] = [],
  ) => {
    const perAuthor = await Promise.all(
      authors.map(async (author) => {
        const written = await deps.quests.listOwn(author.id)

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
               * **What the quest was invoiced and what has arrived** (`#553`
               * phase C). This read *reserved or escrowed, never summed* — the
               * four steps `governance/quests.md` describes for a credit
               * balance. There is no balance and no escrow now: a sponsor is
               * invoiced in SOL when a steward publishes, and the two numbers
               * worth showing are what was asked for and what has been paid.
               */
              cost:
                quest.task.reward.lamports === 0
                  ? '—'
                  : `${solFromLamports(
                      questCommitment({
                        reward: quest.task.reward,
                        slots: quest.task.slots ?? 0,
                        publishObstacles: quest.task.publishObstacles ?? false,
                      }),
                    )} SOL`,
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
      ? html(reply, operatedQuestsPage({ nav: navFor(request, roles), quests, operatesAnything }))
      : reply.send({ quests })
  }

  /**
   * Save a draft.
   *
   * **It used to be the one route that brought an identity into existence**
   * (`#455`), minting a `sponsor-*` agent on a person's first draft. `#578`
   * removed that: the person writes through an agent they already operate, and
   * where they operate several the form asked which.
   */
  app.post('/quests', async (request, reply) => {
    if (!(await ctx.guard(request, reply))) return reply

    /**
     * **An agent caller is its own author**, and everything below is about the
     * other kind of caller: a person, who now writes through an agent they
     * paired rather than through one the Colony made for them (`#578`).
     */
    const caller = await ctx.caller(request)
    const signedIn = caller === null ? await ctx.person(request) : null

    if (caller === null && signedIn === null) {
      if (wantsHtml(request)) reply.callNotFound()
      else reply.status(ERROR_STATUS.unauthorized).send({ signedIn: false, signIn: '/sign-in' })
      return reply
    }

    /**
     * **A person does not author a quest here, and `#457` is why** (`#578`).
     *
     * That issue settled that *operating an agent does not make its work yours
     * to edit*. The console got around it by minting the person an identity of
     * their own to write through; `#578` removed the minting, and writing as an
     * agent they merely operate would break `#457` in the other direction —
     * putting a quest, and the invoice behind it, on a citizen that did not
     * write it.
     *
     * So the agent writes its own quests, over MCP with its own key, exactly as
     * `kolonie.quests.write` already lets it. What the person gets here is the
     * sentence saying so.
     */
    if (signedIn !== null) {
      const operated = await deps.humans.store.operated(signedIn.human.id)

      return wantsHtml(request)
        ? html(
            reply.status(ERROR_STATUS.validation_failed),
            pairAnAgentPage(navFor(request, signedIn.human.roles), operated.length > 0),
          )
        : reply.status(ERROR_STATUS.validation_failed).send({
            code: 'validation_failed',
            message:
              operated.length > 0
                ? 'A quest is written by the agent it belongs to. Ask one of yours to call ' +
                  'kolonie.quests.write.'
                : 'A quest is written by an agent. Pair one with this account first — the ' +
                  'Colony opens none on your behalf.',
            pairAt: '/',
          })
    }

    const agent = caller
    if (agent === null) return reply

    const parsed = parseQuestForm(request.body)
    if (parsed.outcome === 'rejected') {
      return wantsHtml(request)
        ? html(
            reply.status(ERROR_STATUS.validation_failed),
            questFormPage({
              nav: navFor(request),
              problems: parsed.problems,
              caps: await tierCaps(),
            }),
          )
        : reply.status(ERROR_STATUS.validation_failed).send({
            code: 'validation_failed',
            message: parsed.problems.join(' '),
            problems: parsed.problems,
          })
    }

    const written = await writeQuestDraft({ authorId: agent.id, body: parsed.draft }, deps.quests)
    if (written.outcome === 'rejected') {
      return wantsHtml(request)
        ? html(
            reply.status(ERROR_STATUS[written.error.code]),
            questFormPage({
              nav: navFor(request),
              problems: [written.error.message],
              caps: await tierCaps(),
            }),
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
    const agent = await identity(request, reply, { refuse: false })

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
            nav: navFor(request),
            quest: own.response.quest,
            feePercent: platformFeePercentFromEnv(),
            caps: await tierCaps(),
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
        reply.send({ ...own.response, audience: reportAudience(audience) })
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

  /**
   * End a quest that is running (`#619`).
   *
   * A form post for the reason the withdrawal above is one, and it carries a
   * reason rather than only a confirmation — the citizens who were answering
   * read it.
   *
   * **The sponsor's door and not the steward's.** `questAuthor` resolves the
   * author and turns everybody else away, which is right for this page — it is
   * the sponsor's own quest page. A steward ending somebody else's quest goes
   * through `POST /v1/quests/:questId/end`, where the role is read; adding a
   * role check here would make this page pretend to be a review surface.
   */
  app.post('/quests/:questId/end', async (request, reply) => {
    const resolved = await writeAs(request, reply)
    if (resolved === null) return reply

    const questId = (request.params as { questId?: string }).questId
    const ended = await endQuest(
      {
        actorId: resolved.id,
        questId,
        body: request.body,
        at: new Date().toISOString() as Timestamp,
        stewarding: false,
      },
      deps.quests,
    )

    if (ended.outcome === 'rejected') return refuse(request, reply, ended.error)

    return wantsHtml(request)
      ? reply.status(303).header('location', `/quests/${ended.response.quest.quest.id}`).send()
      : reply.send(ended.response)
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
    /**
     * **There is no affordability refusal any more** — D-106 (`#540`).
     *
     * This block refused a submission the sponsor's balance could not cover,
     * because `#174` reserved at submission so that review time was never spent
     * on hypothetical funding. Under D-106 there is no balance to check against:
     * a sponsor pays an invoice from its own wallet after a steward has
     * published, so the Colony now spends the review before knowing whether the
     * sponsor will pay. That cost is real, it lands on the Colony rather than on
     * the steward — who is paid either way, D-105 — and it is the price of
     * holding nobody's money.
     */

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
      rewardSol: quest.reward.lamports === 0 ? '' : solFromLamports(quest.reward.lamports),
      minReputation: String(quest.minReputation),
    }

    const copiedFrom =
      own.response.rejectionReason === null
        ? undefined
        : { title: quest.title, reason: own.response.rejectionReason }

    return wantsHtml(request)
      ? html(
          reply,
          questFormPage({ nav: navFor(request), prefill, copiedFrom, caps: await tierCaps() }),
        )
      : reply.send({ prefill, copiedFrom: copiedFrom ?? null })
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
      ? html(reply, questResultsPage({ ...results.response, nav: navFor(request) }))
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
      ? html(
          reply,
          reviewQueuePage({
            steward: caller.profile.name,
            queue,
            curation: curationSections(await atlasCuration(deps.recipes)),
          }),
        )
      : reply.send({ queue })
  })

  /**
   * Accepting or refusing a proposed entry (`#549`).
   *
   * **One press, and it is recorded against its author** — the row keeps who
   * proposed it and gains when it was decided. Behind the steward gate rather
   * than the maintainer's, because `#549` requires that stewards curate: a
   * catalogue only one person can maintain stops when that person is busy.
   *
   * **Accepting records the decision; it does not write the entry.** Applying a
   * reviewed change is a curation edit made deliberately, and a button that both
   * approved and published would be the one press that puts a stranger's text
   * into the catalogue.
   */
  for (const decision of ['accept', 'refuse'] as const) {
    app.post(`/curation/:proposalId/${decision}`, async (request, reply) => {
      const caller = await steward(request, reply)
      if (caller === null) return reply

      const { proposalId } = request.params as { proposalId?: string }
      const decided = await deps.recipes.decide(
        proposalId ?? '',
        decision === 'accept' ? 'accepted' : 'refused',
      )

      if (decided === undefined) return consoleNotFound(reply, request)

      return wantsHtml(request) ? reply.redirect('/review', 303) : reply.send(decided)
    })
  }

  app.post('/review/:questId/publish', async (request, reply) => {
    const caller = await steward(request, reply)
    if (caller === null) return reply

    const { questId } = request.params as { questId?: string }
    const result = await publishQuest(
      { stewardId: caller.id, questId, at: new Date().toISOString() as Timestamp },
      deps.quests,
    )

    if (result.outcome === 'rejected') {
      /**
       * **A refusal, rendered as a refusal** (`#496`).
       *
       * This used to render `errorPage` — *"Something went wrong. The Colony
       * could not answer that."* — for a 4xx the domain composed on purpose,
       * whose reason the JSON branch below already sends to the caller. So a
       * steward publishing a quest that had not cleared moderation read that the
       * Colony was broken, while an agent calling the same route with a
       * different `Accept` header read what to do about it.
       *
       * The queue is re-read rather than redirected to, for two reasons: a
       * `303` would drop the message, there being no flash anywhere in this
       * console, and the status has to stay the rejection's own — a refusal
       * answered `200` is a refusal nothing downstream can tell from a success.
       *
       * `errorPage` is untouched and stays the 5xx page, which is `#490`'s.
       */
      if (wantsHtml(request)) {
        const queue = await deps.quests.stewardQueue(caller.id)
        return html(
          reply.status(ERROR_STATUS[result.error.code]),
          reviewQueuePage({
            steward: caller.profile.name,
            queue,
            declined: result.error.message,
          }),
        )
      }

      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
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
      /**
       * **A refusal, rendered as a refusal** (`#496`).
       *
       * This used to render `errorPage` — *"Something went wrong. The Colony
       * could not answer that."* — for a 4xx the domain composed on purpose,
       * whose reason the JSON branch below already sends to the caller. So a
       * steward publishing a quest that had not cleared moderation read that the
       * Colony was broken, while an agent calling the same route with a
       * different `Accept` header read what to do about it.
       *
       * The queue is re-read rather than redirected to, for two reasons: a
       * `303` would drop the message, there being no flash anywhere in this
       * console, and the status has to stay the rejection's own — a refusal
       * answered `200` is a refusal nothing downstream can tell from a success.
       *
       * `errorPage` is untouched and stays the 5xx page, which is `#490`'s.
       */
      if (wantsHtml(request)) {
        const queue = await deps.quests.stewardQueue(caller.id)
        return html(
          reply.status(ERROR_STATUS[result.error.code]),
          reviewQueuePage({
            steward: caller.profile.name,
            queue,
            declined: result.error.message,
          }),
        )
      }

      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
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

/**
 * What the navigation needs to know, for one request (`#608`).
 *
 * **One place, and the role question is the same expression the guards use.**
 * `#606`: *"the page and the navigation must ask the same question, or a
 * steward gets a link to a page that refuses them."* `/backend` is behind
 * `roles.includes('maintainer')` on the signed-in human, and so is the
 * section the navigation renders for it.
 *
 * `roles` is omitted where the caller is an agent with a key rather than a
 * person with a session — those pages have no role to read, and a navigation
 * that guessed would be guessing about somebody who cannot use the answer.
 */
const navFor = (request: FastifyRequest, roles?: readonly string[]): ConsoleNav => {
  // The path only: a query string is not a destination the navigation carries,
  // and `?filled=…` on the dashboard would stop `/` matching itself.
  const path = request.url.split('?')[0] ?? '/'
  return roles?.includes('maintainer') === true
    ? { current: path, maintains: true }
    : { current: path }
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
 * It is a uuid and not a message: an id can be found in a log, and a message is
 * the thing `#171` is about.
 *
 * **No longer exported, and that is `#496`'s last step.** It was exported so
 * "the error handler and its test name the same thing" — and two review routes
 * then called it to stamp an id on a page nothing logged. A uuid generator
 * reachable from anywhere is how a findable id became an unfindable one twice.
 *
 * Its one caller is {@link consoleError}, which writes the log line the page's
 * *"Error id"* promises (`#490`). Anything that wants an id wants that function.
 */
function consoleErrorId(): string {
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
