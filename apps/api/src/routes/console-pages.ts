import { randomUUID } from 'node:crypto'
import {
  ERROR_STATUS,
  type AgentId,
  type ApiError,
  type Task,
  type Timestamp,
} from '@kolonie-ai/core'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { authenticate } from '../authentication.js'
import { CHECK_YOUR_MAIL, RequestLinkSchema, redeemSignIn, requestSignIn } from '../console.js'
import { CONSOLE_HEADERS, errorPage, signInPage } from '../console/html.js'
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
  readQuest,
  readQuestResults,
  submitQuest,
  writeQuestDraft,
} from '../quests.js'
import { clientIp } from '../client-ip.js'
import { sessionCookie } from './authenticated.js'
import { SESSION_COOKIE } from './console.js'
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

    const agent = await caller(request)
    if (agent === null) {
      return wantsHtml(request)
        ? html(reply, signInPage())
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
        ? html(reply.status(ERROR_STATUS.validation_failed), signInPage())
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
        ? html(reply.status(ERROR_STATUS[result.error.code]), signInPage())
        : reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return wantsHtml(request)
      ? html(reply.status(200), signInPage({ sent: true }))
      : reply.status(202).send(CHECK_YOUR_MAIL)
  })

  /**
   * Where the mail lands.
   *
   * A `GET`, because a link in an email is a `GET` and nothing else. The token
   * is single-use and expires (`#172`), which is what makes that acceptable —
   * and the session leaves in `Set-Cookie` rather than in the body, so no bearer
   * secret reaches a proxy log or the rendered page.
   */
  app.get('/sign-in/redeem', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const { token } = request.query as { token?: string }
    const result = await redeemSignIn(
      token ?? '',
      clientIp(request.headers, request.socket.remoteAddress ?? ''),
      deps.console,
    )

    if (result.outcome === 'rejected') {
      return wantsHtml(request)
        ? html(reply.status(ERROR_STATUS[result.error.code]), signInPage())
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
      : reply.send({ ...own.response, money, audience })
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
export function consoleNotFound(reply: FastifyReply, request: FastifyRequest): FastifyReply {
  for (const [header, value] of Object.entries(CONSOLE_HEADERS)) reply.header(header, value)

  return wantsHtml(request)
    ? reply.status(404).type('text/html; charset=utf-8').send(signInPage())
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
