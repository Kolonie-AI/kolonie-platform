import { randomUUID } from 'node:crypto'
import { capabilitiesFromForm, handoverNotice } from '@kolonie-ai/core'
import {
  ERROR_STATUS,
  MESSAGE_BODY_MAX_LENGTH,
  MESSAGE_BODY_MIN_LENGTH,
  credentialFinding,
  credentialRefusalMessage,
  AccountEpisodeIdSchema,
  AccountKindSchema,
  AccountSlotIdSchema,
  ENTRY_BODY_MAX_LENGTH,
  EPISODE_TITLE_MAX_LENGTH,
  SLOT_LABEL_MAX_LENGTH,
  SLOT_MAX_READS,
  SLOT_VALUE_MAX_LENGTH,
  AccountProviderSchema,
  RECIPE_REFUSAL_MAX_LENGTH,
  RECIPE_MAX_STEPS,
  RECIPE_STEP_MAX_LENGTH,
  EntryWordingSchema,
  routeFromWording,
  type EntryWording,
  type ProviderRecipe,
  solFromLamports,
  platformFeePercentFromEnv,
  reportAudience,
  whyNotPublishable,
  ConversationIdSchema,
  OPERATOR_ANSWER_LABELS,
  OperatorAnswerKindSchema,
  type Agent,
  type AgentId,
  type ApiError,
  type ConversationId,
  type HumanId,
  type Message,
  type Log,
  type QuestTier,
  type Task,
  type TaskId,
  type Timestamp,
  questCanHaveAnswers,
  questCommitment,
  ProposalActionSchema,
} from '@kolonie-ai/core'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
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
  escape,
  errorPage,
  keyMintedPage,
  keyPage,
  notFoundPage,
  accountDeletedPage,
  accountPage,
  inboxPage,
  inboxThreadPage,
  dashboardPage,
  handoverPage,
  sessionsPage,
  signInPage,
} from '../console/html.js'
import type { ConsoleNav } from '../console/navigation.js'
import { messageBodyError, messageDeclarationError } from '../messaging.js'
import { relative, zoneFrom } from '../console/time.js'
import {
  activityLines,
  agentPage,
  agentSectionPage,
  autonomyLines,
  emptyAgentPages,
  questsLines,
  questsWrittenLines,
  rungsLines,
  skillsLines,
  walletLines,
} from '../console/agent-page.js'
import { AGENT_PAGES } from '../console/navigation.js'
import { answerAutonomyFormForAgent } from '../autonomy.js'
import { agentAccountsPage, heldAccountRows } from '../console/agent-accounts.js'
import {
  accountThreadPage,
  type Conversation,
  type ConversationSlot,
} from '../console/account-thread.js'
import {
  backendArrivalsPage,
  backendAtlasPage,
  backendBriefingsPage,
  backendEnquiriesPage,
  backendModerationPage,
  backendPage,
  backendQuestPage,
  backendQuestsPage,
  backendDeskPage,
  backendDeskTicketPage,
  backendRefusalsPage,
  backendSettingsPage,
  backendTicketsPage,
  backendDiagnosesPage,
  backendDiagnosisPage,
  backendDiagnosisRulesPage,
  backendUnreportedPage,
  backendWantedPage,
  moderationTrend,
} from '../console/backend.js'
import { agentSubjects, stateFilter, statesFor } from '../console/diagnoses-section.js'
import { curationSections } from '../console/curation.js'
import { atlasCatalogue, atlasCuration, atlasStateAt } from '../provider-recipes.js'
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
  readQuest,
  readQuestResults,
  submitQuest,
  withdrawQuest,
  endQuest,
  writeQuestDraft,
} from '../quests.js'
import { clientIp } from '../client-ip.js'
import { routeKeyOf } from '../call-rollup.js'
import { cookieValue, sessionCookie } from './authenticated.js'
import { consoleOperatorPath, operatorPageBody } from '../operator-page-body.js'
import { shareAdditionError } from '../operator-shares.js'
import { COLONY_QUEST_LIMIT, DIAGNOSES_PAGE, type OperatorPageView } from '@kolonie-ai/db'
import {
  autonomyFormPage,
  autonomyRevisedPage,
  operatorAnsweredPage,
  operatorNoteSentPage,
} from '../autonomy-page.js'
import { writeOperatorNote } from '../operator-notes.js'
import { answerOperatorThread, isWaitingOnTheOperator } from '../operator-threads.js'
import { markWishWanted, putOnWishList, selectBundle } from '../account-wishes.js'
import type { SealedSecret, WishCatalogueEntry } from '../console/agent-accounts.js'
import type { InboxView } from '../messaging.js'

/**
 * What *muted, until I say otherwise* is written as (`#1449`).
 *
 * `muted_until` is a nullable timestamp so that *mute for a week* is
 * expressible, and nothing on the page offers a date yet — so an indefinite
 * mute is a date far enough out to mean it. A boolean column would have made
 * the timed case a migration; this makes it a control somebody adds later.
 */
const MUTED_INDEFINITELY = '2999-01-01T00:00:00.000Z'
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
import { profilePath, robotsDirective } from '@kolonie-ai/core'
import { profileNotFoundPage, profilePage } from '../profile/html.js'
import { siteChromeFrom } from '../atlas/site-chrome.js'
import { updateProfile } from '../profile.js'
import {
  profileAccountRows,
  profilePatchFromForm,
  profileSectionPage,
} from '../console/profile-section.js'
import { setOwnAccountShownOnProfile } from '../accounts.js'
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

/**
 * What an operator is told about a slot that is not theirs to act on (`#931`).
 *
 * **One sentence for six states**, which is one more than the handover has and
 * the same reasoning: read out, expired, closed over with its episode, never
 * filled, never awaiting them, or never theirs. A console that told them apart
 * would answer questions about a conversation the asker is not in.
 */
const SLOT_CLOSED_NOTICE =
  'That one is not open to you. It may have been answered already, read the number of times it ' +
  'allows, closed with its episode, or it was never yours \u2014 the Colony answers the same way ' +
  'to all of them on purpose. Nothing was sent and nothing is held against the agent. Ask your ' +
  'agent to open another; it costs it nothing.'

/**
 * What a form on the account's page is told when the conversation will not take
 * it (`#932`).
 *
 * **One sentence for four states**, on `SLOT_CLOSED_NOTICE`'s reasoning: closed
 * since the page was drawn, never this account's, never this agent's, or a
 * Colony wired without the conversation at all. The HTML path never sees it — a
 * form that will not land redirects to the page, which now says what is true.
 */
const THREAD_CLOSED_NOTICE =
  'That conversation is not open to you. It may have been closed since this page was drawn, or ' +
  'it belongs to another account — the Colony answers the same way to both on purpose. ' +
  'Nothing was written.'

/** The two ends of the slot round trip, carried across a redirect like `filled`. */
const SLOT_NOTICE: Record<string, string | undefined> = {
  filled:
    'Sent. It went into the slot sealed, and your agent claims it into its own vault under the ' +
    'name it chose \u2014 nobody reads it back out, including you and including the Colony.',
  closed: SLOT_CLOSED_NOTICE,
}

/**
 * How far back `/backend/diagnoses` reads the consultation funnel (`#1081`).
 *
 * **Shorter than the 90 days a diagnosis is kept for**, deliberately: the
 * question the line answers is *is this channel working now*, and a window as
 * long as retention would take a quarter to notice that it had stopped.
 */
const CONSULTATION_WINDOW_DAYS = 30

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
       * the path — so `/` on the API host must answer what the app answers and
       * not something this file invented. A second 404 with a different
       * sentence would be this feature quietly changing an answer agents
       * already read.
       *
       * That answer is no longer always a 404, and delegating is what kept this
       * file out of it: `#1005` made `/` a 405 naming `POST`, because MCP
       * answers there and *no route here* was never true of it. Nothing had to
       * change below — the handler decides, and this one only declines.
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
      /**
       * The secrets sitting in an account conversation (`#931`).
       *
       * Its own read and not part of `waitingOnThem`: that query answers *what
       * is stopping an agent*, and half of these are the other direction — a
       * value the agent left for the person, which stops nothing. An empty list
       * on a Colony with no sealing key, and no section on the page.
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
              waiting: queue,
              slots,
              code,
              maintains,
              ...(filled === undefined ? {} : { notice: filled }),
            }),
          )
        : reply.send({
            signedIn: true,
            agents,
            waiting: queue,
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
   * The maintainer's gate (`#486`).
   *
   * **The separation the issue asked for is now the absence of the other
   * side.** It used to be structural: this registration resolved a person and a
   * second one, `registerStewardPages`, resolved an agent, and neither could
   * reach the other's resolver. `#943` deleted that second registration, so no
   * console page resolves an agent at all and *shares no code path that resolves
   * an identity* is trivially true — `#485`'s sentence, *"no console page is
   * reachable by holding an agent role"*, is a fact about the file rather than
   * about a boundary inside it.
   *
   * **That separation was a security property rather than tidiness**, which is
   * why it is worth recording what it was guarding. Two roles opened pages on
   * the same host and authenticated through different tables: `credentials` for
   * an agent, `human_sessions` for a person. `humans.ts` states what was at
   * stake — *"A bug there does not render a wrong page; it hands somebody a
   * citizen's authority."*
   *
   * So this reaches for {@link person} and never for {@link caller}, and the
   * compile is what stops the substitution: `person` resolves to a `Human`,
   * whose `roles` are `HumanRole[]`, and there is no value of that type an
   * `Agent` could be mistaken for — `HumanId` is branded apart from `AgentId` in
   * core precisely so this is a type error rather than a review comment.
   *
   * A caller without the role gets `callNotFound()`: the page does not announce
   * itself to somebody who cannot have it.
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
   * *How is the Colony doing*, answered to the person running it (`#486`), one
   * page per question (`#775`).
   *
   * ## What changed, and why it is nine routes rather than one
   *
   * `/backend` was one handler that ran nine sequential reads before it wrote a
   * byte, whatever the maintainer had come to look at, and answered every JSON
   * request with all nine at once. `#775`: *"the section a maintainer opens is
   * the only one the request pays for."* So each entry under *Running the
   * Colony* is a route with its own read and its own JSON body, and the reads
   * that were sequential are simply not made.
   *
   * The landing page reads `colonyNumbers()` and is the only page that does.
   * `/numbers` read it too until `#943` deleted that page, and the reason it
   * could be deleted is that the two never disagreed: one function, and now one
   * caller.
   *
   * ## One guard, applied nine times
   *
   * `maintainer()` and nothing else. It is called at the top of each handler
   * rather than in a hook so that the refusal is visible where the page is:
   * `#485`'s property is that this surface resolves a **person** and never an
   * agent, and a hook registered against a path prefix is one rename away from
   * covering nothing.
   */
  const backendGuard = async (request: FastifyRequest, reply: FastifyReply) =>
    await maintainer(request, reply)

  app.get('/backend', async (request, reply) => {
    if ((await backendGuard(request, reply)) === null) return reply

    const numbers = await deps.quests.numbers()
    /**
     * How much is waiting for a person (`#1347`). A second read rather than a
     * figure inside `ColonyNumbers`, because it is not an aggregate about the
     * Colony — it is a queue with this reader's name on it, and a deployment
     * with no desk wired has none of it to report.
     */
    const desk = deps.ticketDesk === undefined ? undefined : await deps.ticketDesk.depth()

    return wantsHtml(request)
      ? html(
          reply,
          backendPage({
            nav: navFor(request, ['maintainer']),
            numbers,
            ...(desk === undefined ? {} : { desk }),
          }),
        )
      : reply.send({ numbers, ...(desk === undefined ? {} : { desk }) })
  })

  /**
   * Who arrived (`#607`). Its own read, and it reaches no published figure.
   *
   * Not folded into `ColonyNumbers`: that object is aggregates entirely, and
   * showing individuals is a change of kind rather than one more figure.
   */
  app.get('/backend/arrivals', async (request, reply) => {
    if ((await backendGuard(request, reply)) === null) return reply

    const arrivals = await deps.quests.arrivals()

    return wantsHtml(request)
      ? html(reply, backendArrivalsPage({ nav: navFor(request, ['maintainer']), arrivals }))
      : reply.send({ arrivals })
  })

  /**
   * Every quest in the Colony, whoever wrote it (`#776`).
   *
   * **The one read that is deliberately unscoped by authorship.** Every other
   * quest surface asks *whose*: `/quests` lists what the signed-in person's
   * identities wrote, and the steward's pages are queues. So a quest that is
   * running, ended, refused or withdrawn was on no page at all, and the answer
   * to *what quests exist* was a database session.
   *
   * The row expressions are `questsFor`'s, word for word, because a maintainer
   * comparing this page against `/quests` is comparing two renderings of one
   * fact and they have to agree.
   */
  app.get('/backend/quests', async (request, reply) => {
    if ((await backendGuard(request, reply)) === null) return reply

    const written = await deps.quests.listAll()

    const quests = written.map((quest) => ({
      id: String(quest.task.id),
      title: quest.task.title,
      /**
       * **Named, never linked, and null-named where the citizen erased itself.**
       * `/agents/:agentId` is behind `operatedAgent`, so a link from here to an
       * agent this maintainer does not operate answers 404 — which is what
       * `console-links.test.ts` crawls for. Erasure leaves the quest and takes
       * the agent row, and the page says so rather than showing an empty cell.
       */
      author: quest.author.name ?? 'an erased citizen',
      status: quest.awaitingModeration ? 'awaiting moderation' : quest.task.status,
      filled:
        quest.task.slots === null
          ? `${String(quest.acceptedReports)} (no limit)`
          : `${String(quest.acceptedReports)} of ${String(quest.task.slots)}`,
      cost:
        quest.task.reward.lamports === 0
          ? '—'
          : `${solFromLamports(
              questCommitment({ reward: quest.task.reward, slots: quest.task.slots ?? 0 }),
            )} SOL`,
      written: relative(quest.task.createdAt),
    }))

    return wantsHtml(request)
      ? html(
          reply,
          backendQuestsPage({
            nav: navFor(request, ['maintainer']),
            quests,
            limit: COLONY_QUEST_LIMIT,
          }),
        )
      : reply.send({ quests, limit: COLONY_QUEST_LIMIT })
  })

  /**
   * The verdicts that decide whether a quest is published or refused (`#814`).
   *
   * The subject filter narrows both the history and its rate. The decision
   * filter narrows the history only: applying it before the aggregation would
   * make *rejected* read as a 100% refusal rate and *approved* as 0%, which is a
   * tautology rather than an operational signal.
   */
  app.get<{
    Querystring: { subject?: unknown; decision?: unknown }
  }>('/backend/moderation', async (request, reply) => {
    if ((await backendGuard(request, reply)) === null) return reply

    const parsed = z
      .object({
        subject: z.string().trim().max(120).optional(),
        decision: z.union([z.literal(''), z.enum(['approved', 'rejected'])]).optional(),
      })
      .safeParse(request.query)

    if (!parsed.success) {
      const error: ApiError = {
        code: 'validation_failed',
        message: parsed.error.issues[0]?.message ?? 'Invalid moderation filter.',
      }
      return wantsHtml(request)
        ? html(reply.status(ERROR_STATUS[error.code]), errorPage(error.message))
        : reply.status(ERROR_STATUS[error.code]).send(error)
    }

    const filters = {
      ...(parsed.data.subject === undefined || parsed.data.subject === ''
        ? {}
        : { subject: parsed.data.subject }),
      ...(parsed.data.decision === undefined || parsed.data.decision === ''
        ? {}
        : { decision: parsed.data.decision }),
    }
    const candidates = await deps.quests.moderations(
      filters.subject === undefined ? {} : { subject: filters.subject },
    )
    const moderations =
      filters.decision === undefined
        ? candidates
        : candidates.filter((moderation) => moderation.decision === filters.decision)
    const trend = moderationTrend(candidates)

    return wantsHtml(request)
      ? html(
          reply,
          backendModerationPage({
            nav: navFor(request, ['maintainer']),
            moderations,
            trend,
            filters,
          }),
        )
      : reply.send({ moderations, trend, filters })
  })

  /**
   * One quest, read to the end (`#776`).
   *
   * **404 and never 403 for a quest that does not exist**, which is the same
   * refusal the guard above makes for a reader who is not a maintainer: this
   * surface tells a stranger nothing about which ids are real.
   *
   * The counts and the answers both come from the reads the sponsor's own
   * results page uses, so no figure and no line of text on this page can drift
   * from the one the sponsor is looking at.
   *
   * **Reading the answers is recorded before they are served** — the condition
   * `kolonie-docs#311` attached to the permission, and the whole of what makes
   * that rule checkable. Written here rather than inside the renderer because
   * the JSON caller reads the same text and owes the same record; a record on
   * the HTML branch alone would be a rule that stops applying to whoever asks
   * with an `Accept` header.
   */
  app.get<{ Params: { questId: string } }>('/backend/quests/:questId', async (request, reply) => {
    const signedIn = await backendGuard(request, reply)
    if (signedIn === null) return reply

    const taskId = request.params.questId as TaskId
    const quest = await deps.quests.readAny(taskId)
    if (quest === undefined) return reply.callNotFound()

    const [counts, answerCounts, withheld, answers] = await Promise.all([
      deps.quests.reportCounts(taskId),
      deps.quests.counts(taskId),
      deps.quests.withheld(taskId),
      deps.quests.results(taskId),
    ])

    const facts = [
      {
        label: 'Status',
        value: quest.awaitingModeration ? 'awaiting moderation' : quest.task.status,
      },
      { label: 'Author', value: quest.author.name ?? 'an erased citizen' },
      {
        label: 'Filled',
        value:
          quest.task.slots === null
            ? `${String(quest.acceptedReports)} (no limit)`
            : `${String(quest.acceptedReports)} of ${String(quest.task.slots)}`,
      },
      {
        label: 'Committed',
        value:
          quest.task.reward.lamports === 0
            ? '—'
            : `${solFromLamports(
                questCommitment({ reward: quest.task.reward, slots: quest.task.slots ?? 0 }),
              )} SOL`,
      },
      { label: 'Reputation per answer', value: String(quest.task.reward.reputation) },
      { label: 'Written', value: relative(quest.task.createdAt) },
      { label: 'Text last revised', value: relative(quest.textRevisedAt) },
      { label: 'Last changed', value: relative(quest.task.updatedAt) },
      {
        label: 'Expires',
        value: quest.task.expiresAt === null ? 'no expiry' : relative(quest.task.expiresAt),
      },
      { label: 'Proof required', value: quest.task.proofVerifier ?? 'none' },
      { label: 'Deliverable', value: quest.task.deliverable },
      /**
       * **Why it ended, where it has ended.** There is no `ended_at`: the row
       * carries `endedBy`, `endedReason` and `updatedAt`, so the reason is the
       * fact and *Last changed* above is the nearest honest moment.
       */
      { label: 'Ended because', value: quest.task.endedReason ?? '—' },
    ]

    const made = [
      { label: 'Claims', value: String(counts.claims) },
      { label: 'Accepted reports', value: String(counts.acceptedReports) },
      { label: 'Said it was unclear', value: String(counts.unclear) },
      { label: 'Declined it', value: String(counts.declined) },
      { label: 'Withheld by the Colony', value: String(withheld) },
    ]

    const body = {
      title: quest.task.title,
      description: quest.task.description,
      instructions: quest.task.instructions,
      questions: quest.task.questions.map((question) => ({
        key: question.key,
        prompt: question.prompt,
      })),
      facts,
      counts: made,
      answerCounts,
      rejectionReason: quest.rejectionReason,
      withheld,
      declined: counts.declined,
      answers,
    }

    /**
     * **Recorded because the text is about to be served, and awaited.**
     *
     * A read that was fired and forgotten would make the record a thing that
     * usually happens, and a rule enforced by *usually* is not one an auditor
     * can rely on. It is one insert on a page a maintainer opens by hand.
     */
    await deps.quests.recordReportRead({ taskId, humanId: signedIn.id })

    return wantsHtml(request)
      ? html(reply, backendQuestPage({ nav: navFor(request, ['maintainer']), quest: body }))
      : reply.send({ quest: body })
  })

  /** Whether a briefing changes an outcome (`#609`). */
  app.get('/backend/briefings', async (request, reply) => {
    if ((await backendGuard(request, reply)) === null) return reply

    const briefings = await deps.quests.briefingEffect()

    return wantsHtml(request)
      ? html(reply, backendBriefingsPage({ nav: navFor(request, ['maintainer']), briefings }))
      : reply.send({ briefings })
  })

  /** Where the Colony knows nothing (`#611`). */
  app.get('/backend/unreported', async (request, reply) => {
    if ((await backendGuard(request, reply)) === null) return reply

    const unreported = await deps.quests.unreported()

    return wantsHtml(request)
      ? html(reply, backendUnreportedPage({ nav: navFor(request, ['maintainer']), unreported }))
      : reply.send({ unreported })
  })

  /** What is waiting to be read — a live query carrying its own moment (`#487`). */
  app.get('/backend/tickets', async (request, reply) => {
    if ((await backendGuard(request, reply)) === null) return reply

    const sections = await deps.quests.backendSections()

    return wantsHtml(request)
      ? html(reply, backendTicketsPage({ nav: navFor(request, ['maintainer']), sections }))
      : reply.send({ ...sections })
  })

  /**
   * The Colony addressing a citizen in its own name (`#473`), from the page a
   * person is already reading rather than from a tool a model holds (`#945`).
   *
   * **The same write path, and the same rule.** `Support.notify` validates the
   * notice and refuses one naming a submission that is not the addressed
   * citizen's — so this handler decides nothing about the content and only
   * turns the three outcomes into a sentence the person reading gets back.
   *
   * **It re-renders rather than redirecting**, the enquiries shape and not the
   * settings one: what the maintainer needs is confirmation that the notice
   * went, and a `303` to a page with no record of it is not that.
   */
  app.post('/backend/tickets/notice', async (request, reply) => {
    if ((await maintainer(request, reply)) === null) return reply

    const sent = await deps.support.notify(request.body)
    const notice =
      sent.outcome === 'sent'
        ? 'Sent. The citizen has it on its own record, settled, with nothing to reply to.'
        : sent.outcome === 'no-such-submission'
          ? 'Nothing was sent: that submission is not that citizen’s, or is not there. One ' +
            'answer for both, deliberately.'
          : 'Nothing was sent: a notice needs the citizen, one of its own submissions, a ' +
            'subject and a body.'

    const sections = await deps.quests.backendSections()

    return wantsHtml(request)
      ? html(
          reply,
          backendTicketsPage({
            // The queue's own path, not the POST's: this renders the tickets
            // page, so that is the entry `aria-current` marks.
            nav: { current: '/backend/tickets', maintains: true },
            sections,
            notice,
          }),
        )
      : reply.send({ outcome: sent.outcome, notice })
  })

  /**
   * What the Doctor found (`#841`).
   *
   * **Every route under this path is a `GET`, and that is asserted rather than
   * observed** — `console-diagnoses.test.ts` walks the router and fails on any
   * method that is not one. A diagnosis resolves when its evidence stops
   * matching (`#838`); a button that closed one would put a person's opinion
   * into a state machine defined by evidence, and the two would drift.
   *
   * **Registered only where a reader was wired**, which is D-013's way of
   * switching a surface off: a deployment with no diagnoses desk serves no page
   * rather than an empty one.
   */
  if (deps.diagnoses !== undefined) {
    const diagnoses = deps.diagnoses

    app.get<{
      Querystring: { scope?: string; history?: string; state?: string; page?: string }
    }>('/backend/diagnoses', async (request, reply) => {
      if ((await backendGuard(request, reply)) === null) return reply

      const showing = request.query.scope === 'agent' ? ('agent' as const) : ('colony' as const)
      /**
       * **Resolved and superseded are reachable, never deleted from view.**
       * The history is the point: `kolonie-platform#814` is the complaint that
       * verdicts cannot be read back, and a page that only showed what is
       * currently true would earn the same one.
       *
       * **One state at a time, since `#1079`.** `history=1` used to be the
       * whole vocabulary — a boolean over three states, which mixed them into
       * one list with nothing on a row to tell them apart. It survives as an
       * alias for `state=all` so that a bookmark made before that keeps
       * showing the page it showed, and it is read only when `state` is
       * absent: `state` winning when both are present is what makes carrying
       * the alias harmless. Nothing new links to it.
       */
      const state = stateFilter(
        request.query.state ?? (request.query.history === '1' ? 'all' : undefined),
      )
      const states = statesFor(state)
      const page = Math.max(0, Number.parseInt(request.query.page ?? '0', 10) || 0)

      /**
       * Thirty days, at the one call site that has an opinion about the
       * window (`#1081`). It is a property of the page — *is this channel
       * working now* — rather than of the storage function, which counts
       * whatever it is handed.
       */
      const since = new Date(Date.now() - CONSULTATION_WINDOW_DAYS * 24 * 60 * 60 * 1000)

      const [colony, agents, counts, funnel] = await Promise.all([
        diagnoses.list({
          scope: 'colony',
          states: [...states],
          offset: showing === 'colony' ? page * DIAGNOSES_PAGE : 0,
        }),
        diagnoses.list({
          scope: 'agent',
          states: [...states],
          offset: showing === 'agent' ? page * DIAGNOSES_PAGE : 0,
        }),
        diagnoses.counts(),
        diagnoses.funnel(since),
      ])

      // **`state` beside `states`** (`#1079`): the word that was asked for as
      // well as the rows it selects, so a script reading this does not have to
      // infer the filter back out of an array — and so that `?state=deleted` is
      // visibly `open` rather than silently it.
      if (!wantsHtml(request))
        return reply.send({ colony, agents, counts, funnel, showing, state, states, page })

      /**
       * The citizens on the page actually being rendered (`#1080`).
       *
       * **After the fan-out and not inside it**, because the ids are on the rows:
       * one extra round trip on a page that has citizens on it, and none at all
       * on one that has not — a colony-scoped page asks for an empty set, and the
       * lookup answers an empty map without going to the database. Only the
       * listed half is resolved: the other half is fetched for its count and its
       * rows are never rendered.
       */
      const listed = showing === 'agent' ? agents : colony
      const handles = await diagnoses.handles(agentSubjects(listed.rows))

      return html(
        reply,
        backendDiagnosesPage({
          nav: navFor(request, ['maintainer']),
          colony,
          agents,
          counts,
          funnel,
          showing,
          state,
          page,
          handles,
        }),
      )
    })

    /**
     * Which rules are any good (`#1083`).
     *
     * **Registered before the detail route below, deliberately rather than by
     * accident.** `rules` is not a uuid and the detail handler would refuse it
     * with a 404 either way, but that is a property of the id format and not a
     * decision anybody wrote down — a later id shape that admitted a word would
     * silently swallow this path. The order here is the decision, and
     * `console-diagnoses.test.ts` asserts both routes still answer.
     */
    app.get('/backend/diagnoses/rules', async (request, reply) => {
      if ((await backendGuard(request, reply)) === null) return reply

      const rules = await diagnoses.ruleHealth()

      return wantsHtml(request)
        ? html(reply, backendDiagnosisRulesPage({ nav: navFor(request, ['maintainer']), rules }))
        : reply.send({ rules })
    })

    /**
     * One diagnosis, read to the end.
     *
     * **404 and never 403 for an id that names nothing**, the same refusal the
     * guard above makes for a reader who is not a maintainer: this surface tells
     * a stranger nothing about which ids are real.
     */
    app.get<{ Params: { diagnosisId: string } }>(
      '/backend/diagnoses/:diagnosisId',
      async (request, reply) => {
        if ((await backendGuard(request, reply)) === null) return reply

        const diagnosis = await diagnoses.byId(request.params.diagnosisId)
        if (diagnosis === null) return reply.callNotFound()

        if (!wantsHtml(request)) return reply.send({ diagnosis })

        // The one citizen this page is about, if it is about one at all
        // (`#1080`) — the same lookup the list makes, over a page of one row.
        const handles = await diagnoses.handles(agentSubjects([diagnosis]))

        return html(
          reply,
          backendDiagnosisPage({ nav: navFor(request, ['maintainer']), diagnosis, handles }),
        )
      },
    )
  }

  /**
   * The walkers whose prose kept crossing a red line (`#1097`).
   *
   * **A read and one write, and the write only lifts.** The suspension itself is
   * imposed by the threshold, inside the transaction that writes the verdict
   * reaching it — so there is no route here that could impose one, and that is
   * the design rather than an omission. A person's job is the other direction.
   *
   * **Registered only where a desk was wired**, exactly as the diagnoses tree
   * above: a deployment with none serves no page rather than an empty one.
   */
  if (deps.walkRefusals !== undefined) {
    const walkRefusals = deps.walkRefusals

    app.get('/backend/refusals', async (request, reply) => {
      if ((await backendGuard(request, reply)) === null) return reply

      const tallies = await walkRefusals.tallies()

      return wantsHtml(request)
        ? html(reply, backendRefusalsPage({ nav: navFor(request, ['maintainer']), tallies }))
        : reply.send({ tallies })
    })

    app.post('/backend/refusals/lift', async (request, reply) => {
      const held = await maintainer(request, reply)
      if (held === null) return reply

      const { agentId } = (request.body ?? {}) as { agentId?: string }
      const lifted = agentId === undefined ? false : await walkRefusals.lift(agentId)
      const notice = lifted
        ? 'Suspension lifted. What the walker had earned is back; nothing else about the refusals changed.'
        : 'Nothing to lift — that walker is not suspended, or is banned, which this never touches.'

      const tallies = await walkRefusals.tallies()

      return wantsHtml(request)
        ? html(
            reply,
            backendRefusalsPage({
              // The path the navigation carries, not the POST's own: this
              // renders the refusals page, so that is what `aria-current` marks.
              nav: { current: '/backend/refusals', maintains: true },
              tallies,
              notice,
            }),
          )
        : reply.send({ tallies, lifted })
    })
  }

  /**
   * The tickets a person has to answer (`#1347`).
   *
   * **A read and three writes, and every write is a person's own word.** Triage
   * answers what it can; what reaches this desk is what it decided it could
   * not, plus what `#1344` routes here without asking — an appeal against a
   * suspension is not a thing a rule may settle. So `resolved` and `declined`
   * are both typed by hand here, and there is no route under this path that a
   * runner could call.
   *
   * **Registered only where a desk was wired**, exactly as the refusals tree
   * above: a deployment with none serves no page rather than an empty one.
   */
  if (deps.ticketDesk !== undefined) {
    const ticketDesk = deps.ticketDesk

    app.get('/backend/desk', async (request, reply) => {
      if ((await backendGuard(request, reply)) === null) return reply

      const tickets = await ticketDesk.tickets()

      return wantsHtml(request)
        ? html(reply, backendDeskPage({ nav: navFor(request, ['maintainer']), tickets }))
        : reply.send({ tickets })
    })

    app.get<{ Params: { ticketId: string } }>('/backend/desk/:ticketId', async (request, reply) => {
      if ((await backendGuard(request, reply)) === null) return reply

      const ticket = await ticketDesk.ticket(request.params.ticketId)
      if (ticket === undefined) return reply.status(404).send({ error: 'no such ticket' })

      return wantsHtml(request)
        ? html(reply, backendDeskTicketPage({ nav: navFor(request, ['maintainer']), ticket }))
        : reply.send({ ticket })
    })

    app.post<{ Params: { ticketId: string } }>(
      '/backend/desk/:ticketId/answer',
      async (request, reply) => {
        const held = await maintainer(request, reply)
        if (held === null) return reply

        const { status, resolution } = (request.body ?? {}) as {
          status?: string
          resolution?: string
        }
        /**
         * The three the form has buttons for, checked here rather than trusted.
         * `open` is not among them: a ticket reaches the colony queue by being
         * promoted, which is the route below and a decision of its own.
         */
        if (status !== 'resolved' && status !== 'declined' && status !== 'acknowledged') {
          return reply.status(400).send({ error: 'answer with resolved, declined or acknowledged' })
        }

        const written = await ticketDesk
          .answer({
            ticketId: request.params.ticketId,
            status,
            ...(resolution === undefined ? {} : { resolution }),
          })
          /**
           * The storage layer throws when a settling answer says nothing, and
           * that is a thing a person can put right by typing a sentence — so it
           * is a notice on the page rather than a 500.
           */
          .catch(() => undefined)

        if (written === undefined) {
          const ticket = await ticketDesk.ticket(request.params.ticketId)
          if (ticket === undefined) return reply.status(404).send({ error: 'no such ticket' })

          return wantsHtml(request)
            ? html(
                reply,
                backendDeskTicketPage({
                  nav: { current: '/backend/desk', maintains: true },
                  ticket,
                  notice:
                    'Nothing was written. Resolving or declining a ticket has to say why — the ' +
                    'citizen reads those words and there is nothing else in it for them.',
                }),
              )
            : reply.status(400).send({ error: 'a settled ticket has to say why' })
        }

        return wantsHtml(request)
          ? html(
              reply,
              backendDeskTicketPage({
                // The path the navigation carries, not the POST's own.
                nav: { current: '/backend/desk', maintains: true },
                ticket: written,
                notice:
                  written.status === 'acknowledged'
                    ? 'Acknowledged. It stays on the desk and in the count — an acknowledgement is a promise to answer.'
                    : `Answered, and ${written.status}. The citizen reads those words through kolonie.support.read.`,
              }),
            )
          : reply.send({ ticket: written })
      },
    )

    app.post<{ Params: { ticketId: string } }>(
      '/backend/desk/:ticketId/promote',
      async (request, reply) => {
        const held = await maintainer(request, reply)
        if (held === null) return reply

        const promoted = await ticketDesk.promote(request.params.ticketId)
        const tickets = await ticketDesk.tickets()

        return wantsHtml(request)
          ? html(
              reply,
              backendDeskPage({
                nav: { current: '/backend/desk', maintains: true },
                tickets,
                notice: promoted
                  ? 'Back in front of triage, open and unanswered. Anything already written was kept.'
                  : 'Nothing to promote — that ticket is not on this desk.',
              }),
            )
          : reply.send({ tickets, promoted })
      },
    )
  }

  /**
   * Providers writing in about the Atlas (`#544`). Reachable before the form is
   * announced anywhere, because an enquiry nobody answers is worse than no form.
   */
  app.get('/backend/enquiries', async (request, reply) => {
    if ((await backendGuard(request, reply)) === null) return reply

    const enquiries = await deps.providerEnquiries.list()

    return wantsHtml(request)
      ? html(reply, backendEnquiriesPage({ nav: navFor(request, ['maintainer']), enquiries }))
      : reply.send({ enquiries })
  })

  /**
   * What agents are asking for (`#534`).
   *
   * **Here and on no public route.** `kolonie-docs#216` gates the Colony's stock
   * figures until the majority of agents are not ours, and this is behind the
   * maintainer role — which is the only reason it may be drawn at all. The floor
   * is already applied in SQL, so nothing this route does can widen it.
   */
  app.get('/backend/wanted', async (request, reply) => {
    if ((await backendGuard(request, reply)) === null) return reply

    const wanted = await deps.wishes.store.wanted()

    return wantsHtml(request)
      ? html(reply, backendWantedPage({ nav: navFor(request, ['maintainer']), wanted }))
      : reply.send({ wanted })
  })

  /**
   * Curating the Atlas (`#549`) — the queue, and every decision on it.
   *
   * **The page rendered here and the routes its buttons post to are one gate**
   * (`#943`). The section has been drawn on this page since `#549`, but its
   * forms posted to the steward's `/review` tree, so a maintainer who was not
   * also a steward pressed a button and got a 404 from a page that had just
   * shown them the row. `/review` is gone and the writes moved under this path,
   * which is the one that says who owns them.
   */
  app.get('/backend/atlas', async (request, reply) => {
    if ((await backendGuard(request, reply)) === null) return reply

    const read = await atlasCuration(deps.recipes)

    return wantsHtml(request)
      ? html(
          reply,
          backendAtlasPage({
            nav: navFor(request, ['maintainer']),
            curation: curationSections(read),
          }),
        )
      : reply.send({ curation: read })
  })

  /**
   * Publish or refuse a measured entry (`#808`, `#857`).
   *
   * **The path says `walked` and not `drafts` since `#1032`**, because there is
   * no draft state left: a closed walk writes a public `measured` row with no
   * route on it, and what this screen decides is whether the Colony writes one.
   * Publishing is the wording — there is no status move behind it to make
   * separately — and refusing is for a red line, since everything fixable is
   * better left measured with the provider's briefing under it.
   *
   * **Not under `entries`, which is where it first went.** The entry *proposals*
   * below take `/backend/atlas/entries/:proposalId/…`, and a pair route hung off
   * the same segment collapses in the router's tree into
   * `entries/:kind|:proposalId/…` — one node with two names for it. Fastify
   * assigns both and it works, but the console's write surface stops being
   * readable as a list of what the console can write, which is the one thing
   * `console-write-surface.test.ts` is there to keep true. `walked` is the word
   * the screen already uses for these rows.
   */
  for (const verdict of ['publish', 'refuse'] as const) {
    app.post(`/backend/atlas/walked/:kind/:provider/${verdict}`, async (request, reply) => {
      if ((await backendGuard(request, reply)) === null) return reply

      const params = z
        .object({ kind: AccountKindSchema, provider: AccountProviderSchema })
        .safeParse(request.params)
      const body =
        verdict === 'refuse'
          ? z
              .object({ reason: z.string().trim().min(1).max(RECIPE_REFUSAL_MAX_LENGTH) })
              .safeParse(request.body ?? {})
          : undefined

      if (!params.success || (body !== undefined && !body.success)) {
        return reply.status(ERROR_STATUS['validation_failed']).send({
          code: 'validation_failed',
          message:
            verdict === 'refuse'
              ? 'Refusing a walked recipe needs a sentence the walker can read.'
              : 'That entry does not name a valid account kind and provider.',
        })
      }

      const draft = await deps.recipes.one(params.data.kind, params.data.provider)
      if (draft === undefined || draft.status !== 'measured') return consoleNotFound(reply, request)

      /**
       * **Refusing takes no route and publishing is nothing but one** (`#1032`).
       *
       * The two verdicts used to share a shape: a draft arrived already carrying
       * the steps a walk observed, wording was the optional half, and a separate
       * call moved the state afterwards. A measured entry carries no steps at
       * all — the table refuses them on one — so a publish with nothing written
       * has nothing to publish, and there is no second act to move: writing the
       * route *is* the publishing, which is why `dressEntry` is the only call on
       * this path.
       */
      if (verdict === 'refuse') {
        const refused = await deps.recipes.refuseEntry(params.data.kind, params.data.provider, {
          verdict: 'refused',
          refusal: body?.success === true ? body.data.reason : '',
        })

        if (!refused) return consoleNotFound(reply, request)

        return wantsHtml(request)
          ? reply.redirect('/backend/atlas', 303)
          : reply.send({
              kind: params.data.kind,
              provider: params.data.provider,
              status: 'refused',
            })
      }

      const wording = wordingIn(request.body)
      if (wording === undefined || wording.ok === false) {
        return reply.status(ERROR_STATUS['validation_failed']).send({
          code: 'validation_failed',
          message:
            wording === undefined
              ? 'Publishing an entry means writing the route it publishes: at least one step, ' +
                'each naming who acts, and the method the account is proved by.'
              : wording.why,
        })
      }

      const route = routeFromWording(wording.wording.steps)
      if (!route.ok) {
        return reply.status(ERROR_STATUS['validation_failed']).send({
          code: 'validation_failed',
          message: route.why,
        })
      }

      /**
       * Judged on what publishing would leave behind, so a route that would
       * still be unpublishable is refused **before** anything is written and the
       * form comes back rather than half-landing.
       */
      const effective: ProviderRecipe = {
        ...draft,
        steps: [...route.steps],
        proves: wording.wording.proves,
        provesTask: wording.wording.provesTask ?? null,
      }

      const missing = whyNotPublishable(effective)
      if (missing !== undefined) {
        return reply.status(ERROR_STATUS['validation_failed']).send({
          code: 'validation_failed',
          message: missing,
        })
      }

      const written = await deps.recipes.dressEntry(params.data.kind, params.data.provider, {
        steps: route.steps,
        proves: wording.wording.proves,
        ...(wording.wording.provesTask === undefined
          ? {}
          : { provesTask: wording.wording.provesTask }),
      })

      if (!written) return consoleNotFound(reply, request)

      return wantsHtml(request)
        ? reply.redirect('/backend/atlas', 303)
        : reply.send({
            kind: params.data.kind,
            provider: params.data.provider,
            status: 'joinable',
          })
    })
  }

  /**
   * Accepting or refusing a proposed entry (`#549`).
   *
   * **One press, and it is recorded against its author** — the row keeps who
   * proposed it and gains when it was decided.
   *
   * **Behind the maintainer gate** (`#943`). `#549` put it behind the steward's
   * as well, so that a catalogue would not stop when one person was busy; the
   * model pass in `#812` is what answers that now, and every proposal it decides
   * is decided before anybody opens this page. What is left is the correction
   * path for a decision the model got wrong, and a correction belongs where the
   * other overrides are.
   *
   * **Accepting records the decision; it does not write the entry.** Applying a
   * reviewed change is a curation edit made deliberately, and a button that both
   * approved and published would be the one press that puts a stranger's text
   * into the catalogue.
   */
  for (const decision of ['accept', 'refuse'] as const) {
    app.post(`/backend/atlas/entries/:proposalId/${decision}`, async (request, reply) => {
      if ((await backendGuard(request, reply)) === null) return reply

      const { proposalId } = request.params as { proposalId?: string }
      const decided = await deps.recipes.decide(
        proposalId ?? '',
        decision === 'accept' ? 'accepted' : 'refused',
      )

      if (decided === undefined) return consoleNotFound(reply, request)

      return wantsHtml(request) ? reply.redirect('/backend/atlas', 303) : reply.send(decided)
    })
  }

  /**
   * Deciding a proposed provider (`#600`).
   *
   * **Three actions and one of them needs words.** Accepting writes the listing;
   * merging records that the provider was already on the map under another
   * hostname; refusing needs a sentence, because the proposer is told the
   * outcome and *no* with no reason teaches nothing and invites the same
   * proposal next month.
   *
   * **Accepting produces a listing and nothing more.** The entry says the
   * provider, its shelf and *nobody has looked* — no steps are invented, because
   * what the Colony says about somebody else's product passes a person who
   * walked it, and a button that wrote a recipe would be that rule dying
   * quietly.
   */
  for (const action of ['accept', 'refuse', 'merge'] as const) {
    app.post(`/backend/atlas/providers/:proposalId/${action}`, async (request, reply) => {
      if ((await backendGuard(request, reply)) === null) return reply

      const { proposalId } = request.params as { proposalId?: string }
      const body = (request.body ?? {}) as Record<string, unknown>

      const parsed = ProposalActionSchema.safeParse(
        action === 'accept'
          ? { action, category: body['category'] }
          : action === 'refuse'
            ? { action, reason: body['reason'] }
            : { action, into: body['into'] },
      )

      if (!parsed.success) {
        return reply.status(ERROR_STATUS['validation_failed']).send({
          code: 'validation_failed',
          message:
            action === 'refuse'
              ? 'A refusal needs a sentence the proposer can read. They are told the outcome, ' +
                'and “no” with no reason teaches nothing.'
              : action === 'merge'
                ? 'A merge names the entry this provider turned out to be, as the Atlas prints it.'
                : 'Listing one needs the shelf it goes on, from the Atlas’s own categories. That ' +
                  'is the one thing a listing claims, so it is yours to answer rather than the ' +
                  'proposer’s.',
        })
      }

      const decided = await deps.recipes.decideProvider(proposalId ?? '', parsed.data)

      if (decided.outcome === 'not-pending') return consoleNotFound(reply, request)

      if (decided.outcome === 'no-such-entry') {
        return reply.status(ERROR_STATUS['validation_failed']).send({
          code: 'validation_failed',
          message:
            'Nothing in the catalogue holds that provider, so there is nothing to merge into. ' +
            'Listing it is the other answer.',
        })
      }

      return wantsHtml(request)
        ? reply.redirect('/backend/atlas', 303)
        : reply.send(decided.proposal)
    })
  }

  /** Everything a maintainer may turn without a deploy (`#489`, D-104). */
  const renderSettings = async (request: FastifyRequest, reply: FastifyReply, notice?: string) => {
    const settings = await deps.settings.effective()

    return wantsHtml(request)
      ? html(reply, backendSettingsPage({ nav: navFor(request, ['maintainer']), settings, notice }))
      : reply.send({
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

  app.get('/backend/settings', async (request, reply) => {
    if ((await backendGuard(request, reply)) === null) return reply

    return await renderSettings(request, reply)
  })

  /**
   * Mark one provider enquiry as dealt with (`#544`).
   *
   * **The only write this section has**, and there will not be a second: an
   * answer goes wherever the provider said to reach it, by a person. A reply box
   * here would be a mail queue built on the strength of a form nobody has filled
   * in yet.
   *
   * Behind the maintainer gate like everything else here, and a second press is
   * not an error — it is how somebody uses a button they are unsure about, and
   * the store leaves the first date alone.
   *
   * **It answers with the enquiries page and not the landing page** (`#775`).
   * Marking one handled and being returned to the Colony's numbers would hide
   * the very row that just changed.
   */
  app.post('/backend/enquiries/:id/handled', async (request, reply) => {
    const held = await maintainer(request, reply)
    if (held === null) return reply

    const { id } = request.params as { id?: string }
    const marked = id === undefined ? false : await deps.providerEnquiries.markHandled(id)
    const notice = marked
      ? 'Marked as handled.'
      : 'That enquiry was already handled, or is not there.'

    const enquiries = await deps.providerEnquiries.list()

    return wantsHtml(request)
      ? html(
          reply,
          backendEnquiriesPage({
            // The path the navigation carries, not the POST's own: this renders
            // the enquiries page, so that is the entry `aria-current` marks.
            nav: { current: '/backend/enquiries', maintains: true },
            enquiries,
            notice,
          }),
        )
      : reply.send({ enquiries, handled: marked })
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
        ? await renderSettings(request, reply.status(400), `${name ?? ''}: ${outcome.reason}`)
        : reply
            .status(ERROR_STATUS['validation_failed'])
            .send({ code: 'validation_failed', message: outcome.reason })
    }

    return wantsHtml(request)
      ? reply.status(303).header('location', '/backend/settings').send()
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
      ? reply.status(303).header('location', '/backend/settings').send()
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
  ): Promise<{ token: string; view: OperatorPageView; humanId: HumanId } | null> => {
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

    /**
     * The person, carried out with the token (`#1440`).
     *
     * A share written from the console is authorised by `human_agents` and not
     * by the page token — the token exists here because the *page* is rendered
     * through the same body, and reusing it as an authorisation would give the
     * console door a rule it did not earn.
     */
    return { token, view, humanId: signedIn.human.id }
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
   * What the navigation says about the agent whose page this is (`#797`).
   *
   * ## Why every page pays for every mark
   *
   * The navigation lists all eleven of an agent's pages on each of them, and `#583`'s
   * rule is that a page with nothing on it keeps its entry and is marked rather
   * than dropped. So *is the wallet empty* has to be answered on the rungs page,
   * and *are there quests* on the wallet page: the marks are a property of the
   * navigation, not of the page being rendered.
   *
   * That is one round trip of seven parallel reads on pages that would otherwise
   * do one or two. It is the price of the rule, and it is smaller than what it
   * replaced — the single long page did all six of these *plus* the catalogue,
   * the operator door and the door's rendered body, on every view.
   *
   * **Accounts and profile read `factsOf` twice**, once here and once for their
   * own content. Passing it down would thread a parameter through four renderers
   * to save one read of a view the mailed page already builds on every open;
   * noted here rather than fixed, because the fix is a cache and this project
   * does not have one.
   */
  const agentNavFor = async (operated: {
    readonly humanId: HumanId
    readonly agentId: AgentId
  }): Promise<ConsoleNav['agent'] | undefined> => {
    const { agentId } = operated
    const [facts, wallet, quests, written, history, planned, threads] = await Promise.all([
      deps.autonomy.pages.factsOf(agentId),
      deps.store.verifiedWalletOf(agentId),
      deps.quests.takenPartIn(agentId),
      deps.quests.listOwn(agentId),
      deps.autonomy.store.history(agentId),
      deps.wishes.store.list(agentId),
      /**
       * The operator threads, which is why this takes the human as well as the
       * agent (`#1305`). A person holds a participant row only in their own
       * thread, so *how many threads are there* has no answer without them.
       *
       * **A deployment with no desk reads as none**, which is the same mark an
       * operator who has never written gets — and the page says the same thing.
       */
      deps.operatorMessaging?.listThreads(operated.humanId, agentId) ?? [],
    ])
    if (facts === null) return undefined

    return {
      agentId: String(agentId),
      name: facts.name,
      empty: emptyAgentPages({
        hasWallet: wallet !== null,
        skills: facts.facts.skills.length,
        rungs: facts.facts.rungs.length,
        attempts: facts.facts.attempts.length,
        quests: quests.length,
        questsWritten: written.length,
        accounts:
          facts.facts.accounts.reduce((sum, account) => sum + account.count, 0) + planned.length,
        autonomyVersions: history.length,
        threads: threads.length,
      }),
    }
  }

  /**
   * One of an agent's sections, on a page of its own (`#797`).
   *
   * Every one of them is the same four steps — the guard, the facts, the marks
   * for the navigation, and the section's own lines — so they are one function
   * taking the last of those. A renderer per page would have been six copies of
   * the guard, and the rejection case is the criterion this issue names: a
   * person who does not operate this agent gets the console's 404 from every one
   * of these paths, identical to the answer for an id that names nothing.
   */
  const renderAgentSection = async (
    request: FastifyRequest,
    reply: FastifyReply,
    operated: {
      readonly humanId: HumanId
      readonly agentId: AgentId
      readonly roles: readonly string[]
    },
    slug: string,
    lines: (
      facts: NonNullable<Awaited<ReturnType<typeof deps.autonomy.pages.factsOf>>>,
    ) => Promise<readonly string[]>,
  ) => {
    const held = await deps.autonomy.pages.factsOf(operated.agentId)
    if (held === null) return consoleNotFound(reply, request)

    const [agent, rendered] = await Promise.all([agentNavFor(operated), lines(held)])

    return html(
      reply,
      agentSectionPage({
        nav: navFor(request, operated.roles, agent),
        agentId: String(operated.agentId),
        name: held.name,
        title: AGENT_PAGES.find((entry) => entry.slug === slug)?.title ?? slug,
        lines: rendered,
      }),
    )
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
     * Whether the door is open (`#453`), and no longer what is behind it
     * (`#797`).
     *
     * `undefined` when the citizen has issued no page — `#428` decided that no
     * live page means no door, and this side of the door is not an exception.
     *
     * **`pages.open` is not called here any more.** Folding the form in meant
     * every read of this page opened the door and moved its `lastOpenedAt`,
     * which made *when did somebody last look at the note channel* a fact about
     * the overview instead. The line the overview now draws leads to
     * `/agents/:agentId/operator`, which opens it for the reason the name says.
     */
    const token = await deps.autonomy.pages.liveToken(operated.agentId)

    const [open, quests, written, walletAddress, autonomyHistory] = await Promise.all([
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
      deps.autonomy.store.history(operated.agentId),
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
      autonomyHistory,
    }

    /**
     * Accounts, as the one line this page keeps (`#582`).
     *
     * On both representations, because a route here answers the same thing two
     * ways and never two different things.
     */
    /**
     * The operator threads, for the overview line and the mark (`#1305`).
     *
     * **The same read `/agents/:agentId/messages` does**, so the sentence here
     * and the page it leads to cannot disagree about how many there are. Kept
     * out of `view` deliberately: the JSON answer to this route is what an
     * operator's own facts are, and thread ids belong to the messages route.
     */
    const threads =
      (await deps.operatorMessaging?.listThreads(operated.humanId, operated.agentId)) ?? []

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
     * The marks for the navigation, from what this page has already read
     * (`#797`).
     *
     * `agentNavFor` would answer the same thing in six more queries, and this
     * is the one page that holds every figure it needs. That the two agree is
     * `emptyAgentPages`' job: one definition of *empty*, called twice with the
     * counts, rather than two places deciding what counts as nothing.
     */
    const agent: ConsoleNav['agent'] = {
      agentId: String(operated.agentId),
      name: held.name,
      empty: emptyAgentPages({
        hasWallet: walletAddress !== null,
        skills: held.facts.skills.length,
        rungs: held.facts.rungs.length,
        attempts: held.facts.attempts.length,
        quests: quests.length,
        questsWritten: written.length,
        accounts: accounts.held + accounts.planned,
        autonomyVersions: autonomyHistory.length,
        threads: threads.length,
      }),
    }

    return html(
      reply,
      agentPage({
        nav: navFor(request, operated.roles, agent),
        ...view,
        /**
         * Accounts as one line (`#582`).
         *
         * Counted here rather than rendered: the rows are on
         * `/agents/:agentId/accounts`, and a page that drew both would be two
         * records of one fact.
         */
        accounts,
        threads,
        hasDoor: token !== undefined,
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

      /**
       * The kind the entry is titled by, which is the one `atlasEntries` already
       * chose to stand for the provider (`#936`). It prefills the start form and
       * constrains nothing: a provider walked for a mailbox is a provider
       * somebody may want an entirely different sort of account at.
       */
      const lead =
        entry.recipes.find((recipe) => recipe.status === entry.status) ?? entry.recipes[0]

      held[entry.provider] = {
        status: entry.status,
        operatorNeed: entry.operatorNeed,
        /** The reason a refusal records, from the row that carries it. */
        refusal: entry.recipes.find((recipe) => recipe.refusal !== null)?.refusal ?? null,
        ...(lead === undefined ? {} : { kind: lead.kind }),
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
   * The sections of the agent page, each on a path of its own (`#797`).
   *
   * Six here; `accounts`, `autonomy` and `profile` were pages before this issue
   * and stay where they are, which is half of why the sections moved to them
   * rather than the other way round. The overview keeps the tenth entry.
   *
   * **Each page reads what it renders.** The wallet page asks for the wallet;
   * it does not ask the Academy what the skills open next, and the quests page
   * does not read the contract history. What every one of them also pays for is
   * the navigation's marks — see `agentNavFor`.
   */
  app.get('/agents/:agentId/wallet', async (request, reply) => {
    if (!(await guard(request, reply))) return reply
    const operated = await operatedAgent(request, reply)
    if (operated === null) return reply

    return renderAgentSection(request, reply, operated, 'wallet', async () =>
      walletLines(await deps.store.verifiedWalletOf(operated.agentId)),
    )
  })

  app.get('/agents/:agentId/skills', async (request, reply) => {
    if (!(await guard(request, reply))) return reply
    const operated = await operatedAgent(request, reply)
    if (operated === null) return reply

    return renderAgentSection(request, reply, operated, 'skills', async (facts) => {
      /** `availableOnly` and bounded at five, for the reason `renderAgentPage` gives. */
      const open = await deps.catalogue.list({
        agentId: operated.agentId,
        availableOnly: true,
        limit: 5,
        hints: false,
      })

      return skillsLines(
        facts.facts.skills,
        open.outcome === 'listed'
          ? open.page.items.map((task) => ({ title: task.title, requires: [...task.requires] }))
          : [],
      )
    })
  })

  app.get('/agents/:agentId/rungs', async (request, reply) => {
    if (!(await guard(request, reply))) return reply
    const operated = await operatedAgent(request, reply)
    if (operated === null) return reply

    return renderAgentSection(request, reply, operated, 'rungs', (facts) =>
      Promise.resolve(rungsLines(facts.facts.rungs)),
    )
  })

  app.get('/agents/:agentId/activity', async (request, reply) => {
    if (!(await guard(request, reply))) return reply
    const operated = await operatedAgent(request, reply)
    if (operated === null) return reply

    return renderAgentSection(request, reply, operated, 'activity', (facts) =>
      Promise.resolve(activityLines(facts.facts.attempts)),
    )
  })

  app.get('/agents/:agentId/quests', async (request, reply) => {
    if (!(await guard(request, reply))) return reply
    const operated = await operatedAgent(request, reply)
    if (operated === null) return reply

    return renderAgentSection(request, reply, operated, 'quests', async () => {
      const quests = await deps.quests.takenPartIn(operated.agentId)

      return questsLines(
        quests.map((quest) => ({
          questId: String(quest.questId),
          title: quest.title,
          at: quest.at,
          outcome: quest.outcome,
        })),
      )
    })
  })

  app.get('/agents/:agentId/quests-written', async (request, reply) => {
    if (!(await guard(request, reply))) return reply
    const operated = await operatedAgent(request, reply)
    if (operated === null) return reply

    return renderAgentSection(request, reply, operated, 'quests-written', async () => {
      const written = await deps.quests.listOwn(operated.agentId)

      return questsWrittenLines(
        written.map((quest) => ({
          questId: String(quest.task.id),
          title: quest.task.title,
          status: quest.awaitingModeration ? 'awaiting moderation' : quest.task.status,
        })),
      )
    })
  })

  /**
   * The operator may revisit its own consent without waiting for the citizen to
   * ask (`#658`), and reads what is recorded on the same page (`#797`).
   *
   * The contract used to be drawn on the overview and revised here, so *what may
   * this agent do* and *change what it may do* were two paths. They are one
   * question, and this is now the `Autonomy contract` entry in the navigation.
   */
  app.get('/agents/:agentId/autonomy', async (request, reply) => {
    if (!(await guard(request, reply))) return reply
    const operated = await operatedAgent(request, reply)
    if (operated === null) return reply
    const facts = await deps.autonomy.pages.factsOf(operated.agentId)
    if (facts === null) return consoleNotFound(reply, request)
    const [current, history, agent] = await Promise.all([
      deps.autonomy.store.read(operated.agentId),
      deps.autonomy.store.history(operated.agentId),
      agentNavFor(operated),
    ])
    const { agentId } = request.params as { agentId: string }

    return html(
      reply,
      autonomyFormPage({
        agentName: facts.name,
        action: `/agents/${agentId}/autonomy`,
        source: 'console',
        nav: navFor(request, operated.roles, agent),
        history: autonomyLines(history, zoneFrom(request.headers)),
        ...(current === null
          ? {}
          : {
              values: {
                level: current.level,
                challengesAllowed: current.challengesAllowed ? 'yes' : 'no',
                capabilities: current.capabilities ?? [],
                defaultRule: current.defaultRule,
                operatorRoute: current.operatorRoute,
              },
            }),
      }),
    )
  })

  app.post('/agents/:agentId/autonomy', async (request, reply) => {
    if (!(await guard(request, reply))) return reply
    const operated = await operatedAgent(request, reply)
    if (operated === null) return reply
    const facts = await deps.autonomy.pages.factsOf(operated.agentId)
    if (facts === null) return consoleNotFound(reply, request)
    const submitted = (request.body ?? {}) as Record<string, unknown>
    const result = await answerAutonomyFormForAgent(
      operated.agentId,
      {
        level: submitted['level'],
        challengesAllowed: submitted['challengesAllowed'] === 'yes',
        capabilities: capabilitiesFromForm(submitted),
        defaultRule: submitted['defaultRule'],
        operatorRoute: submitted['operatorRoute'],
      },
      deps.autonomy,
    )

    if (result.outcome === 'recorded') return html(reply, autonomyRevisedPage(facts.name))

    const { agentId } = request.params as { agentId: string }
    const text = (value: unknown): string | undefined =>
      typeof value === 'string' ? value : undefined
    return html(
      reply.status(422),
      autonomyFormPage({
        agentName: facts.name,
        action: `/agents/${agentId}/autonomy`,
        source: 'console',
        error: result.error.message,
        values: {
          level: text(submitted['level']),
          challengesAllowed: text(submitted['challengesAllowed']),
          capabilities: capabilitiesFromForm(submitted),
          defaultRule: text(submitted['defaultRule']),
          operatorRoute: text(submitted['operatorRoute']),
        },
      }),
    )
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
    notice?: string,
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

    /**
     * The accounts themselves, rather than the counts by kind (`#928`).
     *
     * **`register.list` and not `factsOf`.** The facts read is the *mailed*
     * page's, which counts because it is opened by whoever holds a link; this
     * one is behind the session of the person who operates the agent, and *how
     * are my agent's accounts doing* has no answer in a count. `factsOf` is
     * still what gives us the name and the 404 above, so nothing about who may
     * read this page has moved.
     *
     * **Scoped by `agentId` in the query.** That is the rejection case the issue
     * names — no other agent's identifier on this page — and it is held here, at
     * the read, rather than by anything the renderer does or does not print.
     */
    const accounts = heldAccountRows(await deps.accounts.register.list(operated.agentId))

    /**
     * The accounts a re-check could not reach (`#934`).
     *
     * **Filtered to `maintenance` here rather than read separately**, because
     * `openEpisodes` is one statement and one order and a second query for a
     * subset of the same rows is a second thing to keep true. The others are an
     * acquisition or a repair one of the two parties opened, and they are
     * conversations rather than news.
     *
     * **The title is the episode's own** — composed where the failure was
     * recorded, from the kind and the provider and never the identifier, which
     * is the rule this page has held since `#582`.
     */
    const maintenance = ((await deps.accountThreads?.openEpisodes(operated.agentId)) ?? [])
      .filter((open) => open.episode.kind === 'maintenance')
      .map((open) => ({
        title: open.episode.title,
        openedBy: open.episode.openedBy,
        turn: open.episode.turn,
        openedAt: open.episode.openedAt,
      }))

    /**
     * There is nothing sealed for this person to open any more (`#1443`).
     *
     * This listed what the agent had sealed through `kolonie.accounts.handover`.
     * That channel is retired — 42 sealed, **zero ever read** — and what
     * replaces it is a shared vault entry, which is read from the durable
     * operator page rather than from here. The empty array stays so the page
     * keeps its shape rather than growing a branch for a section that is now
     * always absent.
     */
    const sealed: readonly SealedSecret[] = []

    /**
     * Which of these wishes has a question waiting on this person (`#1027`).
     *
     * **The join the schema already carries.** `message_conversations.wish_id`
     * is mutually exclusive with `task_id` by a check constraint — so a thread
     * bound to a wish is a fact the database holds and nothing on this page
     * read. An operator working through the wish list learned about it on a
     * different page, or not at all.
     *
     * **Unanswered ones only, and keyed by the provider the row is.** A thread
     * the operator has replied in is not outstanding; the wish list in hand is
     * what turns a wish id back into a provider, so no second read is needed.
     */
    const openAsks = await deps.operatorThreads.store.wishesWaiting(operated.agentId)
    const asks = Object.fromEntries(
      openAsks.flatMap((item) => {
        const wish = wishes.find((candidate) => String(candidate.id) === item.wishId)
        return wish === undefined ? [] : [[wish.provider, String(item.threadId)] as const]
      }),
    )

    if (!wantsHtml(request)) {
      return reply.send({
        agentId: String(operated.agentId),
        name: held.name,
        held: accounts,
        wishes,
        maintenance,
        /**
         * The listing and never a value, exactly as the HTML has it — reading
         * one out is `POST /handovers/:id` and spends one of three.
         */
        sealed,
        asks,
        ...(adoption === undefined ? {} : { adoption }),
      })
    }

    return html(
      reply,
      agentAccountsPage({
        /** Inside an agent, so the navigation carries that agent's pages (`#797`). */
        nav: navFor(request, operated.roles, await agentNavFor(operated)),
        agentId: String(operated.agentId),
        name: held.name,
        zone: zoneFrom(request.headers),
        held: accounts,
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
        /**
         * Which wishes already have somewhere to go (`#936`).
         *
         * **Derived through the provider the two rows share, and stored
         * nowhere.** An acquisition opened from a wish creates an account at
         * that provider, and the account *is* the conversation since `#932` — so
         * the link the wish row wants already exists as a join. Writing an
         * account column onto the wish would be a second record of it, which is
         * D-002.
         *
         * **The first account at the provider wins, and there is normally only
         * one.** Where an agent holds two, either is a truthful way in: what the
         * row is saying is *this is no longer a plan*, and both rows prove it.
         */
        conversations: Object.fromEntries(
          accounts
            .filter((account) => account.provider !== null)
            .map((account) => [String(account.provider), account.id] as const)
            .reverse(),
        ),
        // The recommendation, beside the list it fills (`#531`).
        bundles: await deps.wishes.store.bundles(),
        // What stopped answering, if anything has (`#934`).
        maintenance,
        // What is sealed and what has been asked, on the rows they belong to (`#1027`).
        sealed,
        asks,
        ...(adoption === undefined ? {} : { adoption }),
        ...(notice === undefined ? {} : { notice }),
      }),
    )
  }

  /**
   * What a handover that could not land says on the way back (`#933`).
   *
   * A handover that lands has an account page to redirect to. One that does not
   * has no account at all, so it comes back here — and a page that came back
   * looking untouched would read as a form that quietly did nothing.
   */
  const HANDOVER_NOTICES: Readonly<Record<string, string>> = {
    'handed-over': 'Handed over. Your agent has the next move.',
    'handover-incomplete':
      'Nothing was handed over: an account needs both what sort it is and what it is held under.',
    'handover-taken':
      'Nothing was handed over: another citizen has proved that account, and one account ' +
      'belongs to one of them.',
    'handover-full': 'Nothing was handed over: your agent’s register is full.',
    'handover-open':
      'Nothing was handed over: your agent already has an acquisition open about that account.',
    'handover-unsealed':
      'Nothing was handed over: this console cannot seal a secret right now, and a value ' +
      'marked secret is not written unsealed.',

    /**
     * The same shelf for the wish that could not become a conversation (`#936`).
     * Four of the five ways it lands are word-for-word the handover's, because
     * both make an account and an episode out of one form — they are two doors
     * into one move, and telling a person the same thing twice in two voices
     * would be the tell that somebody built it twice.
     */
    'start-incomplete':
      'Nothing was started: an account needs both what sort it is and what it is held under.',
    'start-taken':
      'Nothing was started: another citizen has proved that account, and one account belongs ' +
      'to one of them.',
    'start-full': 'Nothing was started: your agent’s register is full.',
    'start-open':
      'Nothing was started: your agent already has an acquisition open about that account. The ' +
      'conversation is on its list.',
  }

  app.get('/agents/:agentId/accounts', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const operated = await operatedAgent(request, reply)
    if (operated === null) return reply

    const { said } = request.query as { said?: string }
    const notice = said === undefined ? undefined : HANDOVER_NOTICES[said]

    return renderAgentAccounts(request, reply, operated, undefined, notice)
  })

  /**
   * One account, and everything either side has ever said about it (`#932`).
   *
   * **The account row comes from the same read the list uses.** `register.list`
   * is scoped by `agentId` in its own `where`, so finding the row in that list is
   * the authorisation as well as the lookup — an account belonging to another
   * agent is simply not in it, and is answered by the console's 404 rather than
   * by a sentence saying it exists somewhere else. That is the rejection case the
   * issue names, and it is held at the read.
   *
   * **The reversal is here rather than in the renderer.** `episodes` is
   * newest-first because the reads it was written for ask *what is the latest*; a
   * history reads the other way. Sorting inside the page would hide the storage's
   * order from anyone reading either half alone, and would put a decision in a
   * function whose job is to print.
   */
  const renderAccountThread = async (
    request: FastifyRequest,
    reply: FastifyReply,
    operated: {
      readonly agentId: AgentId
      readonly humanId: HumanId
      readonly roles: readonly string[]
    },
    accountId: string,
    notice?: string,
  ) => {
    const held = await deps.autonomy.pages.factsOf(operated.agentId)
    if (held === null) return consoleNotFound(reply, request)

    const account = heldAccountRows(await deps.accounts.register.list(operated.agentId)).find(
      (row) => row.id === accountId,
    )
    if (account === undefined) return consoleNotFound(reply, request)

    /**
     * A Colony wired without the conversation renders the account and an empty
     * history, rather than a 404 for a page that exists.
     *
     * The same choice `renderAgentAccounts` makes one screen up: what is missing
     * is a dependency of the deployment's, and telling an operator their account
     * does not exist because of it would be a lie about their own data.
     */
    const store = deps.accountThreads
    const thread = store === undefined ? undefined : await store.thread(accountId)

    const conversations: Conversation[] = []
    if (store !== undefined && thread !== undefined) {
      for (const episode of [...(await store.episodes(thread.id))].reverse()) {
        const [entries, slots] = await Promise.all([
          store.entries(episode.id),
          store.slots(episode.id),
        ])

        conversations.push({
          id: String(episode.id),
          title: episode.title,
          openedBy: episode.openedBy,
          turn: episode.turn,
          outcome: episode.outcome,
          wall: episode.wall,
          openedAt: episode.openedAt,
          closedAt: episode.closedAt,
          entries: entries.map((entry) => ({
            author: entry.author,
            body: entry.body,
            createdAt: entry.createdAt,
          })),
          slots: slots.map(
            (slot) =>
              ({
                id: String(slot.id),
                label: slot.label,
                secret: slot.secret,
                awaits: slot.awaits,
                filled: slot.filledAt !== null,
                /**
                 * Null on every secret, which the storage has already done —
                 * asserted a second time here because the cost of the rule
                 * failing is a credential in a page a browser has cached.
                 */
                value: slot.secret ? null : slot.value,
                readsLeft: Math.max(SLOT_MAX_READS - slot.reads, 0),
                /**
                 * Taken, destroyed, or read to its last. Three ways to arrive at
                 * one sentence — *there was a value here and it is gone* — and
                 * an operator has nothing to do differently about which.
                 */
                gone:
                  slot.destroyedAt !== null ||
                  slot.takenAt !== null ||
                  (slot.secret && slot.filledAt !== null && slot.reads >= SLOT_MAX_READS),
              }) satisfies ConversationSlot,
          ),
        })
      }
    }

    if (!wantsHtml(request)) {
      return reply.send({
        agentId: String(operated.agentId),
        name: held.name,
        account,
        conversations,
      })
    }

    return html(
      reply,
      accountThreadPage({
        nav: navFor(request, operated.roles, await agentNavFor(operated)),
        agentId: String(operated.agentId),
        name: held.name,
        zone: zoneFrom(request.headers),
        account,
        conversations,
        /**
         * What the Atlas has on this provider, on the page where the work is
         * being done (`#936`).
         *
         * **Read here and not in the renderer**, which is the rule every console
         * page holds: a renderer is given facts and reaches for none. Absent
         * where the account named no provider, because there is then nothing to
         * look one up by and *unwalked* would be an answer to a question nobody
         * asked.
         */
        ...(account.provider === null
          ? {}
          : { atlas: await atlasStateAt(deps.recipes, account.provider, account.kind) }),
        ...(notice === undefined ? {} : { notice }),
      }),
    )
  }

  /**
   * The conversation this form names, if it is one this operator may write into.
   *
   * **Two conditions and both are checked here**: the episode belongs to an
   * account of this agent — `episode` scopes by `agentId` in the same statement —
   * and that account is the one in the path. The second matters because the id is
   * in a hidden field: without it, a form from one account's page would write
   * into another account's conversation and the page would never show it again.
   */
  const conversationOf = async (
    operated: { readonly agentId: AgentId },
    accountId: string,
    named: unknown,
  ) => {
    const store = deps.accountThreads
    if (store === undefined || typeof named !== 'string') return undefined

    const episodeId = AccountEpisodeIdSchema.safeParse(named)
    if (!episodeId.success) return undefined

    const found = await store.episode(operated.agentId, episodeId.data)
    if (found === undefined || found.account.id !== accountId) return undefined
    // A closed conversation takes neither a note nor a turn; the page offers
    // neither form on one, so arriving here means the page was stale.
    if (found.episode.outcome !== null) return undefined

    return { store, episode: found.episode }
  }

  app.get('/agents/:agentId/accounts/:accountId', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const operated = await operatedAgent(request, reply)
    if (operated === null) return reply

    const { accountId } = request.params as { accountId: string }
    const { said } = request.query as { said?: string }

    return renderAccountThread(
      request,
      reply,
      operated,
      accountId,
      said === 'note'
        ? 'Written down.'
        : said === 'turn'
          ? 'Noted whose move it is.'
          : said === 'opened'
            ? 'Opened, and your agent has been handed the next move.'
            : undefined,
    )
  })

  /**
   * Write into a conversation, without taking the next move (`#932`).
   *
   * Separate from the turn deliberately: an operator has to be able to say *I
   * have asked our provider and I am waiting* without also claiming the move.
   * `EpisodeTurnSchema` says the same thing in its own words — the turn is not
   * permission to speak.
   */
  app.post('/agents/:agentId/accounts/:accountId/note', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const operated = await operatedAgent(request, reply)
    if (operated === null) return reply

    const { accountId } = request.params as { accountId: string }
    const { conversation, body } = (request.body ?? {}) as {
      conversation?: unknown
      body?: unknown
    }

    const target = await conversationOf(operated, accountId, conversation)
    const written =
      target !== undefined &&
      typeof body === 'string' &&
      body.trim() !== '' &&
      body.length <= ENTRY_BODY_MAX_LENGTH

    if (written && target !== undefined) {
      await target.store.writeEntry({
        episodeId: target.episode.id,
        author: 'operator',
        body: body as string,
      })
    }

    if (!wantsHtml(request)) {
      return written
        ? reply.status(200).send({ written: true })
        : reply.status(ERROR_STATUS.conflict).send({
            code: 'conflict',
            message: THREAD_CLOSED_NOTICE,
          })
    }

    return reply
      .status(303)
      .header(
        'location',
        `/agents/${String(operated.agentId)}/accounts/${accountId}${written ? '?said=note' : ''}`,
      )
      .send()
  })

  /**
   * Hand the next move over, or take it (`#932`).
   *
   * The page omits the button for the side that already holds it, so this route
   * is reached with a side that is a change — but it does not depend on that:
   * `passTurn` writing the turn it already holds is the same row.
   */
  app.post('/agents/:agentId/accounts/:accountId/turn', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const operated = await operatedAgent(request, reply)
    if (operated === null) return reply

    const { accountId } = request.params as { accountId: string }
    const { conversation, to } = (request.body ?? {}) as { conversation?: unknown; to?: unknown }

    const target = await conversationOf(operated, accountId, conversation)
    // `nobody` is a real turn and is not offered here: an operator saying *over
    // to neither of us* about a conversation they opened is a way to lose it.
    const side = to === 'operator' || to === 'agent' ? to : undefined
    const passed = target !== undefined && side !== undefined

    if (passed && target !== undefined && side !== undefined) {
      await target.store.passTurn(target.episode.id, side)
    }

    if (!wantsHtml(request)) {
      return passed
        ? reply.status(200).send({ turn: side })
        : reply.status(ERROR_STATUS.conflict).send({
            code: 'conflict',
            message: THREAD_CLOSED_NOTICE,
          })
    }

    return reply
      .status(303)
      .header(
        'location',
        `/agents/${String(operated.agentId)}/accounts/${accountId}${passed ? '?said=turn' : ''}`,
      )
      .send()
  })

  /**
   * Start a conversation about an account that is already held (`#932`).
   *
   * **`maintenance`, always.** The acquisition is the one episode a thread has at
   * most one of, and it belongs to how the account came to exist; an operator
   * saying *something is wrong* months later is not that, and the unique index
   * would refuse it anyway.
   *
   * **The title is composed from the kind and the provider, never the
   * identifier** — the rule the console has held since `#582`. The two buttons
   * are the two things an operator arrives wanting to say, and both hand the
   * agent the move, because the point of saying either is that it acts.
   */
  app.post('/agents/:agentId/accounts/:accountId/open', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const operated = await operatedAgent(request, reply)
    if (operated === null) return reply

    const { accountId } = request.params as { accountId: string }
    const { reason } = (request.body ?? {}) as { reason?: unknown }

    const store = deps.accountThreads
    const account =
      store === undefined
        ? undefined
        : (await deps.accounts.register.list(operated.agentId)).find((row) => row.id === accountId)

    const thread =
      store === undefined || account === undefined ? undefined : await store.thread(accountId)

    const opened =
      store !== undefined &&
      account !== undefined &&
      thread !== undefined &&
      (reason === 'wrong' || reason === 'help')

    if (opened && store !== undefined && account !== undefined && thread !== undefined) {
      const at =
        account.provider === null
          ? `the ${String(account.kind)} your agent holds`
          : `the ${String(account.kind)} at ${account.provider}`

      await store.openEpisode({
        threadId: thread.id,
        openedBy: 'operator',
        kind: 'maintenance',
        title:
          reason === 'wrong'
            ? `Something is wrong with ${at}`.slice(0, EPISODE_TITLE_MAX_LENGTH)
            : `Your operator needs you about ${at}`.slice(0, EPISODE_TITLE_MAX_LENGTH),
        turn: 'agent',
      })
    }

    if (!wantsHtml(request)) {
      return opened
        ? reply.status(200).send({ opened: true })
        : reply.status(ERROR_STATUS.conflict).send({
            code: 'conflict',
            message: THREAD_CLOSED_NOTICE,
          })
    }

    return reply
      .status(303)
      .header(
        'location',
        `/agents/${String(operated.agentId)}/accounts/${accountId}${opened ? '?said=opened' : ''}`,
      )
      .send()
  })

  /**
   * An operator hands the agent an account it never asked for (`#933`).
   *
   * **The only route in the Colony that runs this way.** Every other one begins
   * with the agent wanting something — `accounts.handoff` asks the operator for
   * one step of a recipe the agent is walking, `operator.request.*` is the agent
   * asking, `accounts.handover` is the agent sealing something *for* the
   * operator. This is the one where a person opens an account somewhere and
   * gives it away unprompted.
   *
   * **It makes the account, and it has to.** `account_threads.account_id`
   * references `accounts` and a trigger makes the two together, so there is no
   * such thing as an episode about an account that does not exist. The row
   * lands unproved and belongs to the agent from the first statement — the
   * close then offers `accounts.declare` prefilled so the note, the vault key
   * and the provider on it end up being the citizen's own words rather than
   * this form's.
   *
   * **One episode, one entry, and the slots the operator filled in.** No
   * separate mechanism, no new kind: it is an `acquisition` opened by the
   * operator with the turn handed to the agent, so it arrives in the same read
   * and is answered by the same four calls as one the agent opened itself.
   *
   * **The agent is never penalised for what it does with it.** Nothing here
   * writes reputation, grants a skill or touches standing, and closing this as
   * `abandoned` costs exactly what closing any other episode costs, which is
   * nothing. That is `#933`'s rejection case and it is held by there being no
   * code to hold it.
   */
  app.post('/agents/:agentId/accounts/handover', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const operated = await operatedAgent(request, reply)
    if (operated === null) return reply

    const body = (request.body ?? {}) as Record<string, unknown>
    const text = (name: string): string => {
      const value = body[name]
      return typeof value === 'string' ? value.trim() : ''
    }

    const store = deps.accountThreads
    const kind = text('kind')
    const identifier = text('identifier')
    const provider = text('provider')
    const note = text('note')

    /**
     * The three rows the form renders, read positionally. A row with no value
     * is a row the person left blank, which is the ordinary case for the third.
     */
    const wanted = [1, 2, 3]
      .map((n) => ({
        label: text(`label${n}`),
        value: text(`value${n}`),
        secret: body[`secret${n}`] === 'yes',
      }))
      .filter((slot) => slot.value !== '')
      .map((slot) => ({ ...slot, label: slot.label === '' ? 'Value' : slot.label }))

    const said = async (code: string) =>
      wantsHtml(request)
        ? reply
            .status(303)
            .header('location', `/agents/${String(operated.agentId)}/accounts?said=${code}`)
            .send()
        : reply.status(ERROR_STATUS.conflict).send({ code: 'conflict', message: code })

    const parsed = AccountKindSchema.safeParse(kind)
    if (store === undefined || !parsed.success || identifier === '') {
      return await said('handover-incomplete')
    }

    /**
     * **Asked before the account is made**, rather than discovered halfway
     * through: a handover that opened the episode and then found it could not
     * seal the password would leave the agent an account it has been told
     * nothing about, and a person with no way to tell that had happened.
     */
    if (wanted.some((slot) => slot.secret) && !store.carriesSecrets) {
      return await said('handover-unsealed')
    }

    const declared = await deps.accounts.register.declare(operated.agentId, {
      kind: parsed.data,
      identifier,
      ...(provider === '' ? {} : { provider }),
    })

    if (declared.outcome === 'identifier_taken') return await said('handover-taken')
    if (declared.outcome === 'too_many') return await said('handover-full')

    const accountId = declared.account.id
    const thread = await store.thread(accountId)
    if (thread === undefined) return await said('handover-incomplete')

    /** `#582`: the kind and the provider, and never the identifier. */
    const at = provider === '' ? `a ${kind}` : `a ${kind} at ${provider}`
    const opened = await store.openEpisode({
      threadId: thread.id,
      openedBy: 'operator',
      kind: 'acquisition',
      title: `Your operator has opened ${at} for you`.slice(0, EPISODE_TITLE_MAX_LENGTH),
      turn: 'agent',
    })

    /**
     * An acquisition this thread already has. `declare` is idempotent on the
     * same three fields, so a person who submits the form twice lands here
     * rather than making a second account — and the honest answer is that the
     * first one is still open and waiting on the agent.
     */
    if (opened.outcome !== 'opened') return await said('handover-open')

    if (note !== '') {
      await store.writeEntry({
        episodeId: opened.episode.id,
        author: 'operator',
        body: note.slice(0, ENTRY_BODY_MAX_LENGTH),
      })
    }

    for (const slot of wanted) {
      /**
       * **Opened awaiting the operator and filled by the operator**, both
       * halves, in the one request. `awaits` is what decides which mechanism
       * seals the value — `account_slots_filled_by_the_awaited` refuses a row
       * where the wrong side filled it — so a slot the operator supplies is an
       * operator slot even though nobody was waiting for it.
       */
      const empty = await store.openSlot({
        episodeId: opened.episode.id,
        label: slot.label.slice(0, SLOT_LABEL_MAX_LENGTH),
        secret: slot.secret,
        awaits: 'operator',
      })

      const value = slot.value.slice(0, SLOT_VALUE_MAX_LENGTH)

      /**
       * A secret goes through `fillAsOperator`, which is the only path that
       * seals with the scope the read expects; a plain value goes through
       * `fillSlot`, because sealing something the page would print back is
       * ceremony without a secret in it.
       */
      if (slot.secret) {
        await store.fillAsOperator({
          slotId: empty.slot.id,
          humanId: String(operated.humanId),
          value,
        })
      } else {
        await store.fillSlot({ slotId: empty.slot.id, filledBy: 'operator', value })
      }
    }

    if (!wantsHtml(request)) {
      return reply.status(200).send({ handedOver: true, accountId })
    }

    return reply
      .status(303)
      .header('location', `/agents/${String(operated.agentId)}/accounts/${accountId}`)
      .send()
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
      /** Inside an agent, so the navigation carries that agent's pages (`#797`). */
      nav: navFor(request, operated.roles, await agentNavFor(operated)),
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
   * The move from *wanted* to a conversation (`#936`).
   *
   * **The mark used to be the end of the road.** An operator said yes, the agent
   * was woken, and then both sides waited for the other to open something — on a
   * row whose only remaining control was *Remove*. This is that missing move,
   * and it is deliberately the same one `#933` makes from the other direction:
   * an `acquisition`, opened by the operator, turn handed to the agent, arriving
   * in the same waking read and answered by the same four calls.
   *
   * **The wish stays.** It is what somebody asked for, and the conversation is
   * what is being done about it; deleting the first when the second opens would
   * throw away the record of the ask, and adding a column to point at the
   * episode would be a second record of a link the shared provider already
   * makes. The list renders *Open the conversation* from the join instead.
   *
   * **The kind and the identifier are asked for, and there is no way around
   * it.** An episode needs an account row and an account row needs both. A
   * placeholder identifier would be permanently wrong with no rename path,
   * which is D-002 arriving as a convenience — and at nearly every provider the
   * identifier is chosen at signup, which is the very thing the two parties are
   * on this page to plan.
   *
   * **The Atlas is not consulted here.** A provider it records as refused still
   * opens: the entry is one walk's finding and the provider is free to have
   * changed its mind, so the warning belongs on the page where the work happens
   * rather than on the door.
   */
  app.post('/agents/:agentId/wishes/start', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const operated = await operatedAgent(request, reply)
    if (operated === null) return reply

    const body = (request.body ?? {}) as Record<string, unknown>
    const text = (name: string): string => {
      const value = body[name]
      return typeof value === 'string' ? value.trim() : ''
    }

    const store = deps.accountThreads
    const provider = text('provider').toLowerCase()
    const identifier = text('identifier')
    const parsed = AccountKindSchema.safeParse(text('kind'))

    const said = async (code: string) =>
      wantsHtml(request)
        ? reply
            .status(303)
            .header('location', `/agents/${String(operated.agentId)}/accounts?said=${code}`)
            .send()
        : reply.status(ERROR_STATUS.conflict).send({ code: 'conflict', message: code })

    if (store === undefined || provider === '' || identifier === '' || !parsed.success) {
      return await said('start-incomplete')
    }

    const declared = await deps.accounts.register.declare(operated.agentId, {
      kind: parsed.data,
      identifier,
      provider,
    })

    if (declared.outcome === 'identifier_taken') return await said('start-taken')
    if (declared.outcome === 'too_many') return await said('start-full')

    const accountId = declared.account.id
    const thread = await store.thread(accountId)
    if (thread === undefined) return await said('start-incomplete')

    /** `#582`: composed from the kind and the provider, and never the identifier. */
    const opened = await store.openEpisode({
      threadId: thread.id,
      openedBy: 'operator',
      kind: 'acquisition',
      title: `Getting you a ${parsed.data} at ${provider}`.slice(0, EPISODE_TITLE_MAX_LENGTH),
      turn: 'agent',
    })

    /**
     * The account already had its acquisition, which is what a second submission
     * of the same form reaches: `declare` is idempotent on the three fields, so
     * nothing was duplicated and the honest answer is that the conversation is
     * open and waiting on the agent.
     */
    if (opened.outcome !== 'opened') return await said('start-open')

    if (!wantsHtml(request)) {
      return reply.status(200).send({ started: true, accountId })
    }

    return reply
      .status(303)
      .header('location', `/agents/${String(operated.agentId)}/accounts/${accountId}`)
      .send()
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

  /**
   * The operator's thread with their citizen (`#1288`, epic `#1284`).
   *
   * ## Why this is a page of its own and not an entry in `AGENT_PAGES`
   *
   * `/agents/:agentId/operator` argues it first and the argument holds here: an
   * entry that is present for some agents and absent for others is what a
   * navigation must not be, and this one exists only where the deployment wired
   * the port. It is reached the way the account thread is — by knowing it is
   * there — until a later issue gives every agent a messages page to mark empty.
   *
   * ## What the console adds over the storage check, and what it does not
   *
   * `operatedAgent` is the console's own proof of the relationship, and
   * `sendOperatorMessage` reads `human_agents` again for itself. That is
   * deliberate duplication rather than a belt on a brace: one of them is a guard
   * on a browser session and the other is the rule, and the rule has to hold for
   * a caller that never came through here.
   *
   * **Nothing here can write as the Colony.** The port takes a `HumanId` and a
   * body; there is no field on it for a party, a label or a system role, so the
   * worst a compromised session can do is say something as the person it belongs
   * to — which is what a session is for.
   */
  /**
   * One answer form, per thread (`#1093`, `#1319`).
   *
   * **The three declarations post the kind alone**, with no body of their own:
   * the sentence each sends is written in `OPERATOR_ANSWER_BODIES`, so a button
   * labelled *I have done it* cannot be made to carry words saying otherwise.
   * The textarea is the fourth control and declares nothing — free text is what
   * an operator writes when none of the three is what they mean.
   *
   * The hidden `conversationId` is what makes an answer land in the thread it
   * answers. Without it a reply about one task would be filed against whichever
   * thread the port happened to return first, which is the defect provenance
   * exists to prevent.
   */
  const answerForm = (
    agentId: AgentId,
    name: string,
    conversationId: ConversationId | undefined,
    index: number,
  ): string => {
    const field = `body-${String(index)}`
    return (
      `<form method="post" action="${escape(`/agents/${String(agentId)}/messages`)}">` +
      (conversationId === undefined
        ? ''
        : `<input type="hidden" name="conversationId" value="${escape(String(conversationId))}">`) +
      `<label for="${escape(field)}">Write to ${escape(name)}</label>` +
      `<textarea id="${escape(field)}" name="body" maxlength="${String(
        MESSAGE_BODY_MAX_LENGTH,
      )}"></textarea>` +
      '<button type="submit">Send</button>' +
      OperatorAnswerKindSchema.options
        .map(
          (kind) =>
            `<button type="submit" name="kind" value="${escape(kind)}">` +
            `${escape(OPERATOR_ANSWER_LABELS[kind])}</button>`,
        )
        .join('') +
      '</form>'
    )
  }

  const operatorThreadPage = async (
    request: FastifyRequest,
    reply: FastifyReply,
    operated: {
      readonly humanId: HumanId
      readonly agentId: AgentId
      readonly roles: readonly string[]
    },
    outcome: { readonly error?: string; readonly status?: number; readonly said?: boolean } = {},
  ): Promise<FastifyReply> => {
    /**
     * **No desk is an empty page and not a 404** (`#1305`).
     *
     * The entry is in `AGENT_PAGES` now, so every agent page links here — and a
     * navigation entry that answers 404 is what `console-links.test.ts` exists
     * to catch. A deployment with no port has nothing to show and nowhere to
     * send an answer, which is *nothing said yet* with no form under it rather
     * than *this page does not exist*.
     */
    const desk = deps.operatorMessaging

    /**
     * Every thread, not the newest one (`#1319`).
     *
     * A citizen asking for help about a task opens a thread about that task, and
     * a second task opens a second thread — so *the first one* stopped being a
     * complete view of what a person has been asked the moment provenance
     * existed. Each is rendered with its own form, which is also what makes an
     * answer land in the thread it answers: a form without a `conversationId`
     * would put every reply into whichever thread the port found first.
     */
    const threads =
      desk === undefined ? [] : await desk.listThreads(operated.humanId, operated.agentId)
    const conversations: {
      readonly id: ConversationId
      readonly messages: readonly Message[]
    }[] = []
    for (const thread of threads) {
      if (desk === undefined) break
      const read = await desk.getThread(operated.humanId, thread.id)
      conversations.push({
        id: thread.id,
        messages: read.outcome === 'read' ? read.response.messages : [],
      })
    }
    const messages = conversations[0]?.messages ?? []
    const status = outcome.status ?? 200

    if (!wantsHtml(request)) {
      return reply.status(status).send({
        agentId: String(operated.agentId),
        threads,
        conversations,
        messages,
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
      })
    }

    const held = await deps.autonomy.pages.factsOf(operated.agentId)
    if (held === null) return consoleNotFound(reply, request)

    const lines = [
      desk === undefined
        ? '<p class="note">This deployment has no messages desk wired, so there is nothing to ' +
          'read here and nowhere to write. The page stays where it is: the agent has one, and ' +
          'it is empty rather than missing.</p>'
        : '<p class="note">Your agent reads this as words from you — labelled as its operator ' +
          'and never as the Colony. It is not a permission: nothing said here widens what your ' +
          'agent may do.</p>',
      ...(outcome.said === true ? ['<p>Sent.</p>'] : []),
      ...(outcome.error === undefined ? [] : [`<p class="error">${escape(outcome.error)}</p>`]),
      ...(conversations.length === 0
        ? [
            '<p>Nothing said yet.</p>',
            ...(desk === undefined ? [] : [answerForm(operated.agentId, held.name, undefined, 0)]),
          ]
        : conversations.flatMap((conversation, index) => [
            conversation.messages.length === 0
              ? '<p>Nothing said yet.</p>'
              : `<ul>${conversation.messages
                  .map(
                    (message) =>
                      `<li><strong>${escape(message.sender.label)}</strong> ` +
                      `<span>${escape(relative(message.createdAt))}</span><br>` +
                      `${escape(message.body)}</li>`,
                  )
                  .join('')}</ul>`,
            answerForm(operated.agentId, held.name, conversation.id, index),
          ])),
    ]

    return html(
      reply.status(status),
      agentSectionPage({
        nav: navFor(request, operated.roles, await agentNavFor(operated)),
        agentId: String(operated.agentId),
        name: held.name,
        title: 'Messages',
        lines,
      }),
    )
  }

  app.get('/agents/:agentId/messages', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const operated = await operatedAgent(request, reply)
    if (operated === null) return reply

    const { said } = request.query as { said?: string }
    return operatorThreadPage(request, reply, operated, { said: said === 'sent' })
  })

  /**
   * The operator writes.
   *
   * **The credential check runs here for `#236`'s reason**, which the note
   * channel states in full: a person writing to their agent has usually just
   * made it an account, and the answer is where a password most likely actually
   * arrives. A refusal costs them nothing — nothing is sent and the form comes
   * back with what tripped it.
   */
  app.post('/agents/:agentId/messages', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const operated = await operatedAgent(request, reply)
    if (operated === null) return reply

    const desk = deps.operatorMessaging
    if (desk === undefined) return consoleNotFound(reply, request)

    const { body, kind, conversationId } = (request.body ?? {}) as {
      body?: unknown
      kind?: unknown
      conversationId?: unknown
    }
    const written = typeof body === 'string' ? body.trim() : ''
    const declared = OperatorAnswerKindSchema.safeParse(kind)
    const thread = ConversationIdSchema.safeParse(conversationId)

    if (kind !== undefined && !declared.success) {
      return operatorThreadPage(request, reply, operated, {
        error: messageDeclarationError.message,
        status: ERROR_STATUS.validation_failed,
      })
    }
    if (conversationId !== undefined && conversationId !== '' && !thread.success) {
      return operatorThreadPage(request, reply, operated, {
        error: messageDeclarationError.message,
        status: ERROR_STATUS.validation_failed,
      })
    }

    /**
     * A declaration carries no body of its own (`#1093`).
     *
     * The typed text is dropped rather than sent alongside, so the sentence a
     * citizen reads is always the canonical one for the button that was pressed.
     * The two checks below are about free text and have nothing to check when
     * there is none: the Colony wrote the words.
     */
    if (!declared.success) {
      if (written.length < MESSAGE_BODY_MIN_LENGTH || written.length > MESSAGE_BODY_MAX_LENGTH) {
        return operatorThreadPage(request, reply, operated, {
          error: messageBodyError.message,
          status: ERROR_STATUS.validation_failed,
        })
      }

      const finding = credentialFinding(written)
      if (finding !== null) {
        return operatorThreadPage(request, reply, operated, {
          error: credentialRefusalMessage(finding),
          status: ERROR_STATUS.validation_failed,
        })
      }
    }

    const result = await desk.send(operated.humanId, operated.agentId, {
      ...(declared.success ? { answerKind: declared.data } : { body: written }),
      ...(thread.success ? { conversationId: thread.data } : {}),
    })
    if (result.outcome === 'refused') {
      return operatorThreadPage(request, reply, operated, {
        error: result.error.message,
        status: ERROR_STATUS[result.error.code],
      })
    }

    if (!wantsHtml(request)) {
      return reply.status(200).send({ outcome: result.outcome, ...result.response })
    }

    return reply
      .status(303)
      .header('location', `/agents/${String(operated.agentId)}/messages?said=sent`)
      .send()
  })

  /**
   * The thread view, shared by the read and by every refusal of a write.
   *
   * **The read cursor moves here and nowhere else** (`#1448`). Rendering the
   * thread *is* reading it, so the write belongs at the moment the words reach
   * the person rather than behind a second gesture nobody would make.
   */
  const inboxThread = async (
    request: FastifyRequest,
    reply: FastifyReply,
    signedIn: { readonly human: { readonly id: HumanId; readonly roles: readonly string[] } },
    outcome: {
      readonly error?: string
      readonly status?: number
      readonly sent?: boolean
    } = {},
  ): Promise<FastifyReply> => {
    const desk = deps.operatorMessaging
    if (desk === undefined) return consoleNotFound(reply, request)

    const parsed = ConversationIdSchema.safeParse(
      (request.params as { conversationId?: string }).conversationId,
    )
    if (!parsed.success) return consoleNotFound(reply, request)

    const row = (await desk.inbox?.(signedIn.human.id, {}))?.find(
      (candidate) => String(candidate.conversationId) === String(parsed.data),
    )
    if (row === undefined) return consoleNotFound(reply, request)

    const read = await desk.getThread(signedIn.human.id, parsed.data)
    if (read.outcome !== 'read') return consoleNotFound(reply, request)

    await desk.markRead?.(signedIn.human.id, parsed.data)

    const status = outcome.status ?? 200

    if (!wantsHtml(request)) {
      return reply.status(status).send({
        conversationId: String(parsed.data),
        agentId: row.agentId,
        agentName: row.agentName,
        messages: read.response.messages,
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
      })
    }

    /**
     * Whether there is a box under it. A thread whose operator link has been
     * removed stays readable and stops accepting words — the relationship
     * ending does not un-say what was said in it.
     */
    const writable = await deps.humans.store.operates(signedIn.human.id, row.agentId as AgentId)

    return html(
      reply.status(status),
      inboxThreadPage({
        nav: navFor(request, signedIn.human.roles),
        conversationId: String(parsed.data),
        agentId: row.agentId,
        agentName: row.agentName,
        about: row.about?.label ?? null,
        messages: read.response.messages.map((message) => ({
          senderLabel: message.sender.label,
          party: message.sender.party,
          body: message.body,
          createdAt: message.createdAt,
        })),
        declarations: OperatorAnswerKindSchema.options.map((kind) => ({
          kind,
          label: OPERATOR_ANSWER_LABELS[kind],
        })),
        bodyMaxLength: MESSAGE_BODY_MAX_LENGTH,
        writable,
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
        ...(outcome.sent === true ? { sent: true } : {}),
      }),
    )
  }

  /**
   * The inbox (`#1448`, epic `#1447`).
   *
   * ## Why it is here and not under `/agents/:agentId/`
   *
   * That nesting **is** the defect. A person operating three agents had three
   * message pages and no view across them, and the dashboard's queue showed
   * only threads *never answered* — so replying once removed a thread from it
   * for ever. Measured 2026-08-20: 52 conversations, 243 messages, sixteen
   * threads waiting on a person and appearing nowhere.
   *
   * **Participation is the whole authorisation**, exactly as on every other
   * messaging surface: the listing starts from this person's own participant
   * rows, so there is no shape of input that reaches another person's thread —
   * nor any of their agents' conversations with other citizens or with the
   * Colony, which `#1447` frozen decision 2 rules out as surveillance.
   */
  app.get('/inbox', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const signedIn = await person(request)
    if (signedIn === null) return signInRequired(request, reply)

    const desk = deps.operatorMessaging

    /**
     * Open by default (`#1449`). An inbox is what is left to deal with, and a
     * page that opened on *all* would be a log rather than an inbox.
     */
    const asked = (request.query as { view?: string }).view
    const view: InboxView = asked === 'archived' || asked === 'all' ? asked : 'open'

    const threads = desk?.inbox === undefined ? [] : await desk.inbox(signedIn.human.id, { view })

    const rows = threads.map((thread) => ({
      conversationId: String(thread.conversationId),
      agentId: thread.agentId,
      agentName: thread.agentName,
      about: thread.about?.label ?? null,
      preview: thread.latest?.body ?? null,
      at: thread.latest?.at ?? null,
      senderLabel: thread.latest?.senderLabel ?? null,
      mine: thread.latest?.mine ?? false,
      unread: thread.unread,
      unreadCount: thread.unreadCount,
      archived: thread.archived,
      muted: thread.mutedUntil !== null,
    }))

    if (!wantsHtml(request)) return reply.status(200).send({ view, threads: rows })

    return html(
      reply,
      inboxPage({ nav: navFor(request, signedIn.human.roles), threads: rows, view }),
    )
  })

  /**
   * One thread, and **opening it is what marks it read**.
   *
   * That write is the single thing the console never did: the column existed,
   * the agents' side wrote it through `kolonie.messages.mark_read`, and nothing
   * here ever did — so a person had no notion of unread at all.
   *
   * **A thread of an agent this person does not operate is not reachable**, and
   * it is the store that refuses rather than this route: `getThread` starts from
   * a participant row, so an id belonging to somebody else answers exactly as an
   * id that names nothing.
   */
  app.get('/inbox/:conversationId', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const signedIn = await person(request)
    if (signedIn === null) return signInRequired(request, reply)

    const { said } = request.query as { said?: string }
    return inboxThread(request, reply, signedIn, { sent: said === 'sent' })
  })

  /**
   * The reply.
   *
   * **The existing handler's rules, unchanged**: the credential check runs here
   * for `#236`'s reason — a person writing to their agent has usually just made
   * it an account, and the answer is where a password most likely arrives — the
   * body bounds are the same, and a declaration still carries no body of its own
   * (`#1093`).
   */
  app.post('/inbox/:conversationId', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const signedIn = await person(request)
    if (signedIn === null) return signInRequired(request, reply)

    const desk = deps.operatorMessaging
    if (desk === undefined) return consoleNotFound(reply, request)

    const thread = ConversationIdSchema.safeParse(
      (request.params as { conversationId?: string }).conversationId,
    )
    if (!thread.success) return consoleNotFound(reply, request)

    const found = (await desk.inbox?.(signedIn.human.id, {}))?.find(
      (row) => String(row.conversationId) === String(thread.data),
    )
    if (found === undefined) return consoleNotFound(reply, request)

    const { body, kind } = (request.body ?? {}) as { body?: unknown; kind?: unknown }
    const written = typeof body === 'string' ? body.trim() : ''
    const declared = OperatorAnswerKindSchema.safeParse(kind)

    const refuse = (message: string) =>
      inboxThread(request, reply, signedIn, {
        error: message,
        status: ERROR_STATUS.validation_failed,
      })

    if (kind !== undefined && !declared.success) return refuse(messageDeclarationError.message)

    if (!declared.success) {
      if (written.length < MESSAGE_BODY_MIN_LENGTH || written.length > MESSAGE_BODY_MAX_LENGTH) {
        return refuse(messageBodyError.message)
      }

      const finding = credentialFinding(written)
      if (finding !== null) return refuse(credentialRefusalMessage(finding))
    }

    const result = await desk.send(signedIn.human.id, found.agentId as AgentId, {
      ...(declared.success ? { answerKind: declared.data } : { body: written }),
      conversationId: thread.data,
    })

    if (result.outcome === 'refused') {
      return inboxThread(request, reply, signedIn, {
        error: result.error.message,
        status: ERROR_STATUS[result.error.code],
      })
    }

    if (!wantsHtml(request)) {
      return reply.status(200).send({ outcome: result.outcome, ...result.response })
    }

    return reply
      .status(303)
      .header('location', `/inbox/${String(thread.data)}?said=sent`)
      .send()
  })

  /**
   * The three states, as three writes (`#1449`, `#1447` frozen decision 4).
   *
   * **One route and an `act`, not three routes.** They are the same gesture on
   * the same thread from the same list, and a person who pressed the wrong one
   * has pressed a button rather than found a different page. What they are
   * *not* is the same column: archive is *take it out of my list*, mute is
   * *stop telling me about it*, and folding them would mean silencing a chatty
   * thread also lost it.
   *
   * **Neither marks read**, and reading marks neither. Somebody who archives an
   * unread thread has decided not to read it, which is a thing they are allowed
   * to decide.
   */
  app.post('/inbox/:conversationId/state', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const signedIn = await person(request)
    if (signedIn === null) return signInRequired(request, reply)

    const desk = deps.operatorMessaging
    if (desk === undefined) return consoleNotFound(reply, request)

    const parsed = ConversationIdSchema.safeParse(
      (request.params as { conversationId?: string }).conversationId,
    )
    if (!parsed.success) return consoleNotFound(reply, request)

    const { act, back } = (request.body ?? {}) as { act?: unknown; back?: unknown }

    /**
     * **Muting with no date is indefinite.** `muted_until` is a nullable
     * timestamp so *mute for a week* is expressible; nothing on this page offers
     * a date yet, so the far future stands for *until I say otherwise* and the
     * shape is ready for the control that will.
     */
    const outcome =
      act === 'archive'
        ? await desk.archive?.(signedIn.human.id, parsed.data, true)
        : act === 'unarchive'
          ? await desk.archive?.(signedIn.human.id, parsed.data, false)
          : act === 'mute'
            ? await desk.mute?.(signedIn.human.id, parsed.data, MUTED_INDEFINITELY)
            : act === 'unmute'
              ? await desk.mute?.(signedIn.human.id, parsed.data, null)
              : undefined

    if (outcome === undefined || outcome.outcome === 'not-a-participant') {
      return consoleNotFound(reply, request)
    }

    if (!wantsHtml(request)) return reply.status(200).send({ act, outcome: outcome.outcome })

    return reply
      .status(303)
      .header('location', typeof back === 'string' && back.startsWith('/inbox') ? back : '/inbox')
      .send()
  })

  app.get('/agents/:agentId/operator', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const door = await operatorDoor(request, reply)
    if (door === null) return reply

    const { agentId } = request.params as { agentId: string }
    return html(
      reply,
      await operatorPageBody(deps, door.token, consoleOperatorPath(agentId), door.view, {
        fillDrops: true,
        /**
         * The share's forms post to the console's own path (`#1440`).
         *
         * **The same section either door**, unlike `fillDrops` beside it: a drop
         * may only be filled from a console and a share may be read and written
         * from both, which is `#1437` frozen decision 1 and the difference that
         * makes this channel the one that might work.
         */
        ...(deps.operatorShares === undefined ? {} : { shareAction: consoleOperatorPath(agentId) }),
      }),
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

    /**
     * A shared entry, written into or handed back (`#1440`).
     *
     * The same branch the durable page carries, reached through the same store
     * with the person's `human_agents` row in place of a token — which is what
     * `#428` means by *a second door to one page*: the rows, the rules and the
     * refusals are one, and only the authorisation differs.
     */
    if (submitted['act'] === 'write' || submitted['act'] === 'hand-back') {
      const shares = deps.operatorShares
      const shareId = typeof submitted['shareId'] === 'string' ? submitted['shareId'] : ''
      const shareBody = async (shareError?: string) =>
        html(
          reply,
          await operatorPageBody(deps, door.token, action, door.view, {
            fillDrops: true,
            ...(shares === undefined ? {} : { shareAction: action }),
            ...(shareError === undefined ? {} : { shareError }),
          }),
        )

      if (shares === undefined || shareId === '') {
        return await shareBody('That share is not one this page can reach any more.')
      }

      if (submitted['act'] === 'hand-back') {
        await shares.handBack({ humanId: door.humanId }, shareId)
        return await shareBody()
      }

      const addition = typeof submitted['addition'] === 'string' ? submitted['addition'] : ''
      const refusal = shareAdditionError(addition)
      if (refusal !== undefined) return await shareBody(refusal)

      const written = await shares.write({ humanId: door.humanId }, shareId, addition.trim())

      return await shareBody(
        written.outcome === 'closed'
          ? 'That share ended before this was saved. Nothing was written.'
          : undefined,
      )
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
        await deps.operatorThreads.store.forPageToken(door.token),
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
          noteError === undefined ? { fillDrops: true } : { noteError, fillDrops: true },
        ),
      )
    }

    const result = await answerOperatorThread(
      {
        token: door.token,
        /** The second door renders the identical form, so it forwards `kind` too (`#1093`). */
        body: {
          threadId: submitted['threadId'],
          body: submitted['body'],
          kind: submitted['kind'],
        },
      },
      deps.operatorThreads,
    )

    if (result.outcome === 'answered') {
      return html(reply, operatorAnsweredPage(door.view.agentName))
    }

    if (result.outcome === 'unreachable') return consoleNotFound(reply, request)

    return html(
      reply.status(422),
      await operatorPageBody(deps, door.token, action, door.view, {
        answerError: result.error.message,
        fillDrops: true,
      }),
    )
  })

  /**
   * The site's header and footer, for the one console route that renders a
   * public page rather than a console page.
   *
   * The same expression `registerProfilePages` uses, and deliberately the same
   * dependency: a preview assembled from a second source of chrome would differ
   * from the page it claims to be exactly when the site changed, which is the
   * moment somebody is most likely to be looking at it.
   */
  const profileChrome =
    deps.siteChrome ?? siteChromeFrom({ websiteUrl: deps.websiteUrl, log: deps.log })

  /**
   * The profile section for one operated agent (`#829`).
   *
   * **Every value comes from `profileOf`**, which is the record the write path
   * answers with — so a form that renders and a save that returns cannot
   * disagree about a field. Nothing here reads a credential, a key or a token,
   * and there is nothing on the projection that could be rendered by accident:
   * `Agent` carries a profile, a status, roles and skills.
   */
  const renderAgentProfile = async (
    request: FastifyRequest,
    reply: FastifyReply,
    operated: {
      readonly humanId: HumanId
      readonly agentId: AgentId
      readonly roles: readonly string[]
    },
    outcome: {
      readonly error?: string
      readonly values?: Readonly<Record<string, string>>
      readonly saved?: boolean
      readonly status?: number
      readonly accountsError?: string
      readonly accountsSaved?: { readonly identifier: string; readonly shown: boolean }
    },
  ): Promise<FastifyReply> => {
    const agent = await deps.store.profileOf(operated.agentId)
    if (agent === null) return consoleNotFound(reply, request)

    const indexable = await deps.store.indexableOf(operated.agentId)
    /** The other switch on this page, read the same way (`#960`). */
    const attributed = await deps.store.attributedOf(operated.agentId)
    /** And the third of them (`#1067`), which starts off as `indexable` does. */
    const discoverable = await deps.store.discoverableOf(operated.agentId)
    const review = await deps.store.profileReviewOf(operated.agentId)
    const accounts = profileAccountRows(await deps.accounts.register.list(operated.agentId))

    /**
     * Asked rather than assumed: a candidate has a profile and no page, and the
     * preview would answer *not found* for it. The section is where a citizen
     * finds out what its page does, so it says which of the two it is looking at.
     */
    const published = (await deps.citizens.publicRecord(agent.profile.name)) !== undefined

    const canonical = `${deps.websiteUrl}${profilePath(agent.profile.name)}`
    const previewPath = `/agents/${operated.agentId}/profile/preview`
    const status = outcome.status ?? 200

    if (!wantsHtml(request)) {
      return reply.status(status).send({
        agentId: String(operated.agentId),
        name: agent.profile.name,
        canonical,
        published,
        profile: agent.profile,
        indexable,
        attributed,
        discoverable,
        review,
        /**
         * The same rows the page renders, so a caller reading this branch sees
         * the disclosure the browser sees rather than a shorter version of it.
         */
        accounts,
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
        ...(outcome.accountsError === undefined ? {} : { accountsError: outcome.accountsError }),
      })
    }

    return html(
      reply.status(status),
      profileSectionPage({
        /** Inside an agent, so the navigation carries that agent's pages (`#797`). */
        nav: navFor(request, operated.roles, await agentNavFor(operated)),
        agentId: String(operated.agentId),
        name: agent.profile.name,
        canonical,
        previewPath,
        published,
        profile: agent.profile,
        indexable,
        attributed,
        discoverable,
        review,
        accounts,
        ...outcome,
      }),
    )
  }

  app.get('/agents/:agentId/profile', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const operated = await operatedAgent(request, reply)
    if (operated === null) return reply

    return renderAgentProfile(request, reply, operated, {})
  })

  app.post('/agents/:agentId/profile', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const operated = await operatedAgent(request, reply)
    if (operated === null) return reply

    const agent = await deps.store.profileOf(operated.agentId)
    if (agent === null) return consoleNotFound(reply, request)

    /**
     * Through `updateProfile`, and there is no console-shaped shortcut past it.
     *
     * The rhythm bounds, the avatar fetch, the moderation reset and the refusal
     * a citizen reads all live in that function; a console that wrote to the
     * store directly would be a second write path with none of them, and the
     * first thing to go missing would be the refusal.
     */
    const result = await updateProfile(
      profilePatchFromForm(request.body, agent.profile),
      agent,
      deps.store,
      deps.rhythm,
    )

    if (result.outcome === 'rejected') {
      const form = (request.body ?? {}) as Record<string, unknown>

      return renderAgentProfile(request, reply, operated, {
        error: result.error.message,
        // Handed back so a refusal costs the typing rather than only the save.
        values: Object.fromEntries(
          Object.entries(form).flatMap(([key, value]) =>
            typeof value === 'string' ? [[key, value] as const] : [],
          ),
        ),
        status: ERROR_STATUS[result.error.code],
      })
    }

    return renderAgentProfile(request, reply, operated, { saved: true })
  })

  /**
   * One account's `shownOnProfile`, from the browser (`#872`).
   *
   * **Through `setOwnAccountShownOnProfile`, and there is no console-shaped
   * shortcut past it** — the same rule the profile form above keeps. That
   * function holds the three refusals: a kind a page may never name, an account
   * that is not proved and attestable, and a body that is not `{shown: boolean}`.
   * A console writing the column directly would be a second write path with none
   * of them, and the first thing to go missing would be the refusal that says
   * which of the two acts comes first.
   *
   * The refusal is rendered back onto the same screen rather than as an error
   * page: what a reader needs after being refused is the list, with the sentence
   * about it.
   */
  app.post('/agents/:agentId/profile/accounts', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const operated = await operatedAgent(request, reply)
    if (operated === null) return reply

    const form = (request.body ?? {}) as Record<string, unknown>
    const accountId = typeof form.accountId === 'string' ? form.accountId : ''

    const result = await setOwnAccountShownOnProfile(
      operated.agentId,
      accountId,
      // The two hidden inputs the page renders carry `yes` and `no`; anything
      // else reaches the core schema as what it was and is refused there.
      { shown: form.shown === 'yes' ? true : form.shown === 'no' ? false : form.shown },
      deps.accounts,
    )

    if (result.outcome === 'rejected') {
      return renderAgentProfile(request, reply, operated, {
        accountsError: result.error.message,
        status: ERROR_STATUS[result.error.code],
      })
    }

    return renderAgentProfile(request, reply, operated, {
      accountsSaved: {
        identifier: result.response.account.identifier,
        shown: result.response.account.shownOnProfile,
      },
    })
  })

  /**
   * The public page itself, on the console host, for whoever operates it.
   *
   * **`profilePage`'s bytes and not a second rendering of them.** The issue asks
   * for a preview that cannot show a friendlier version of reality, and the only
   * arrangement that holds is the one where there is nothing to keep in step:
   * this handler builds the same arguments the public route builds and hands
   * them to the same function. A test compares the two responses byte for byte.
   *
   * The headers differ and must: this is a console response, so `guard` has
   * already applied `no-store` and the console's CSP. What the issue is about is
   * the body.
   */
  app.get('/agents/:agentId/profile/preview', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const operated = await operatedAgent(request, reply)
    if (operated === null) return reply

    const agent = await deps.store.profileOf(operated.agentId)
    if (agent === null) return consoleNotFound(reply, request)

    const record = await deps.citizens.publicRecord(agent.profile.name)
    const chrome = await profileChrome()

    /**
     * The site's own miss, rather than the console's.
     *
     * An agent with no public record has a page that answers `404` to everybody,
     * and showing its operator the console's not-found page instead would say
     * *you may not look at this* about something that is simply not there.
     */
    if (record === undefined) {
      return reply
        .status(404)
        .type('text/html; charset=utf-8')
        .send(profileNotFoundPage({ chrome }))
    }

    return reply.type('text/html; charset=utf-8').send(
      profilePage({
        record,
        canonical: `${deps.websiteUrl}${profilePath(record.handle)}`,
        siteUrl: deps.websiteUrl,
        chrome,
        robots: robotsDirective(await deps.citizens.indexing(record.handle)),
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
    /**
     * The acting agent, whole rather than just its id, because a quest refusal
     * reads what it holds (`#744`). The closure always had the `Agent`; only this
     * declaration narrowed it away.
     */
    readonly caller: (request: FastifyRequest) => Promise<Agent | null>
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
  ): Promise<Agent | null> => {
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
      authors.map(async (author) => ({
        author,
        written: await deps.quests.listOwn(author.id),
      })),
    )

    /**
     * **Two reads for the whole list, whatever its length** (`#778`).
     *
     * This used to be one full results read per quest, on the argument that a
     * counting query written here would be a second answer to *how full is this
     * quest*. The argument held and the shape did not: the fix is one reader
     * with two entry points — `activity` and the singular `reportCounts` /
     * `withheld` the results page uses are the same SQL — so the list and
     * `/quests/:questId/results` still cannot disagree, and the query count no
     * longer grows with how many quests somebody has written.
     */
    const activity = await deps.quests.activity(
      perAuthor.flatMap(({ written }) => written.map((quest) => quest.task.id)),
    )

    const rows = perAuthor.map(({ author, written }) =>
      written.map((quest) => {
        const made = activity.get(quest.task.id)
        const accepted = made?.acceptedReports ?? 0
        const claims = made?.claims ?? 0
        const withheld = made?.withheld ?? 0

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
           * **What arrived, beside what was accepted** (`#778`). `filled` alone
           * reads as *nobody has answered* in three situations that are not
           * that, and a sponsor comparing this against the results page was the
           * only way to tell them apart.
           */
          claims,
          withheld,
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
                  }),
                )} SOL`,
          yours: author.name === 'You',
          /**
           * Whether the answers page can hold anything (`#777`). The status
           * is the whole of it: a quest nobody has been shown has been
           * answered by nobody, whatever its slots say.
           */
          answers: questCanHaveAnswers(quest.task.status),
          writtenAt: quest.task.createdAt,
        }
      }),
    )

    /** Newest first, across authors — the order somebody scans in. */
    const quests = rows
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
  ): Promise<{
    readonly id: AgentId
    readonly writtenBy?: string
  } | null> => {
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
    agent: Agent | null,
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

    /**
     * What has happened to it, for the sponsor the list sent here (`#778`).
     *
     * Read only for a quest that has been open to citizens: the same test the
     * answers link uses, because a quest nobody could have answered has nothing
     * to count and a round trip to prove it is a round trip spent on zero.
     */
    const activity = questCanHaveAnswers(own.response.quest.status)
      ? (await deps.quests.activity([own.response.quest.id as TaskId])).get(
          own.response.quest.id as TaskId,
        )
      : undefined

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
            // The page composes its own sentence from the timestamp rather than
            // rendering the API's, so the two cannot drift (`#759`).
            heldSince: own.response.held?.since ?? null,
            /**
             * Present only when the reader is not the author (`#457`) — which
             * `questAuthor` has already established, so this is a label rather
             * than a second permission check.
             */
            ...(writtenBy === undefined ? {} : { writtenBy }),
            ...(activity === undefined ? {} : { activity }),
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
        asWarden: false,
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
      {
        authorId: agent,
        questId,
        at: new Date().toISOString() as Timestamp,
      },
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
 * The route a curator typed into the entry form (`#857`, rewritten by `#1032`).
 *
 * **Read positionally, from fields named by index.** A form that repeated one
 * name would hand back a string for a one-step route and an array for a
 * two-step one, and the step a mis-indexed sentence lands on is the step an
 * agent then follows. `instruction-0` cannot drift.
 *
 * **How far the form reaches changed with the entry underneath it.** It used to
 * supply sentences only, onto a shape a walk had already recorded; a measured
 * entry records no shape, so the actor is a field here now. The length is read
 * off the form rather than off the entry for the same reason — nothing on the
 * row says how many steps this provider takes.
 *
 * **Absence is a real answer and it is not an empty route**: a form that names
 * no `proves` is one nobody filled in, and the caller says so in its own words
 * rather than reporting a schema failure about a list of zero steps.
 */
function wordingIn(
  body: unknown,
):
  | { readonly ok: true; readonly wording: EntryWording }
  | { readonly ok: false; readonly why: string }
  | undefined {
  const fields = (body ?? {}) as Record<string, unknown>
  const field = (name: string): string | undefined => {
    const value = fields[name]

    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
  }

  if (field('proves') === undefined) return undefined

  /**
   * Stops at the first index with neither an actor nor an instruction, so a form
   * that offers more blank rows than the curator used publishes the route they
   * wrote rather than refusing on the blanks underneath it.
   */
  const written: unknown[] = []
  for (let at = 0; at < RECIPE_MAX_STEPS; at += 1) {
    const actor = field(`actor-${String(at)}`)
    const instruction = field(`instruction-${String(at)}`)
    if (actor === undefined && instruction === undefined) break

    const ask = field(`ask-${String(at)}`)
    written.push({
      actor,
      instruction,
      ...(ask === undefined ? {} : { ask }),
      ...(fields[`secret-${String(at)}`] === undefined ? {} : { secret: true }),
    })
  }

  const parsed = EntryWordingSchema.safeParse({
    steps: written,
    proves: field('proves'),
    ...(field('provesTask') === undefined ? {} : { provesTask: field('provesTask') }),
  })

  return parsed.success
    ? { ok: true, wording: parsed.data }
    : {
        ok: false,
        why:
          'That route does not fit a recipe: every step names who acts and carries a sentence of ' +
          `at most ${String(RECIPE_STEP_MAX_LENGTH)} characters, and the proof method has to be ` +
          'one the Colony recognises.',
      }
}

/**
 * The console's 404, and it stopped being the sign-in page in `#396`.
 *
 * A 404 listing the API's routes would be an oracle for which console pages
 * exist, so an unknown path on the console host answers with this and nothing
 * else. Called from `app.ts`'s single not-found handler rather than registered
 * as a second one: Fastify allows one per context, and the API's own answer
 * names the REST prefix and the MCP path, which is the wrong thing to say to a
 * browser.
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
const navFor = (
  request: FastifyRequest,
  roles?: readonly string[],
  /**
   * The agent whose pages this one is among (`#797`), from `agentNavFor`.
   *
   * Omitted everywhere else, which is what keeps the section out of the
   * navigation on every page that is not inside an agent.
   */
  agent?: ConsoleNav['agent'],
): ConsoleNav => {
  // The path only: a query string is not a destination the navigation carries,
  // and `?filled=…` on the dashboard would stop `/` matching itself.
  const path = request.url.split('?')[0] ?? '/'
  return {
    current: path,
    ...(roles?.includes('maintainer') === true ? { maintains: true } : {}),
    ...(agent === undefined ? {} : { agent }),
  }
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
    route: routeKeyOf(request),
    url: request.url,
    status: 500,
    errorId,
  })

  for (const [header, value] of Object.entries(CONSOLE_HEADERS)) reply.header(header, value)

  return wantsHtml(request)
    ? reply.status(500).type('text/html; charset=utf-8').send(errorPage(errorId))
    : reply.status(500).send({ code: 'internal', message: 'Internal error.', errorId })
}
