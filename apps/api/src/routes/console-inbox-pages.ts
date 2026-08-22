import {
  ERROR_STATUS,
  MESSAGE_BODY_MAX_LENGTH,
  MESSAGE_BODY_MIN_LENGTH,
  credentialFinding,
  credentialRefusalMessage,
  AgentIdSchema,
  ConversationIdSchema,
  TaskIdSchema,
  OPERATOR_ANSWER_BODIES,
  OPERATOR_ANSWER_LABELS,
  OperatorAnswerKindSchema,
  answerKindOfBody,
  type AgentId,
  type HumanId,
  type TaskId,
} from '@kolonie-ai/core'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { inboxPage, inboxThreadPage } from '../console/html.js'
import { messageBodyError, messageDeclarationError } from '../messaging.js'
import { consoleOperatorPath, operatorPageBody } from '../operator-page-body.js'
import { shareAdditionError } from '../operator-shares.js'
import type { InboxView } from '../messaging.js'

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
import { consoleNotFound, html, navFor, wantsHtml } from './console-shared.js'

import type { ConsolePageContext } from './console-page-context.js'

/**
 * Split out of `console-pages.ts` by `#1500`'s sibling `#1498`, which is a move
 * and not a rewrite — every route body below is the bytes that were in that
 * file. The closures they capture arrive as `ctx`, which is the shape
 * `registerSponsorPages` in that file already used for the quest routes.
 */
export function registerConsoleInboxPages(
  app: FastifyInstance,
  deps: RouteDependencies,
  ctx: ConsolePageContext,
): void {
  const { guard, person, signInRequired, operatorDoor, operatedAgent } = ctx
  app.get('/agents/:agentId/messages', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const operated = await operatedAgent(request, reply)
    if (operated === null) return reply

    if (!wantsHtml(request)) {
      return renderInbox(
        request,
        reply,
        { human: { id: operated.humanId, roles: operated.roles } },
        {
          onlyAgent: operated.agentId,
        },
      )
    }

    return reply
      .status(303)
      .header('location', `/inbox?agent=${String(operated.agentId)}`)
      .send()
  })

  /**
   * The operator writes.
   *
   * **The credential check runs here for `#236`'s reason**, which the note
   * channel states in full: a person writing to their agent has usually just
   * made it an account, and the answer is where a password most likely actually
   * arrives. A refusal costs them nothing — nothing is sent and the form comes
   * back with what tripped it.
   *
   * **Kept when `operatorThreadPage` went** (`#1453`): the inbox's own reply
   * posts through this handler, so this is the one write path and not a second
   * one left behind. What changed is where a refusal is drawn — the inbox
   * narrowed to this agent, rather than the page that no longer exists.
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

    /**
     * **The status is the refusal's own**, not a blanket 422. A removed
     * operator link is a `403` and a deployment with no messaging is a `404`,
     * and flattening those to *your input was wrong* would tell a person to
     * edit a message that was fine.
     */
    const refuse = (message: string, status = ERROR_STATUS.validation_failed) =>
      renderInbox(
        request,
        reply,
        { human: { id: operated.humanId, roles: operated.roles } },
        { onlyAgent: operated.agentId, composeError: message, status },
      )

    if (kind !== undefined && !declared.success) return refuse(messageDeclarationError.message)
    if (conversationId !== undefined && conversationId !== '' && !thread.success) {
      return refuse(messageDeclarationError.message)
    }

    /**
     * A declaration carries no body of its own (`#1093`) — **and a request that
     * sends both is now refused rather than silently having one dropped**
     * (`#1548`).
     *
     * This is the JSON door; no page renders a form posting here since `#1547`,
     * and the inbox's one form derives the tag from the body instead. What
     * reaches this route with a `kind` is a caller declaring, and a caller that
     * also sent words has made a request whose two halves disagree. Dropping one
     * is what `#1548` is named for: *nothing else a person uses does that*.
     * Saying so costs a caller one corrected call and costs nobody a sentence.
     */
    if (declared.success && written !== '') return refuse(messageDeclarationError.message)

    if (!declared.success) {
      if (written.length < MESSAGE_BODY_MIN_LENGTH || written.length > MESSAGE_BODY_MAX_LENGTH) {
        return refuse(messageBodyError.message)
      }

      const finding = credentialFinding(written)
      if (finding !== null) return refuse(credentialRefusalMessage(finding))
    }

    const result = await desk.send(operated.humanId, operated.agentId, {
      ...(declared.success ? { answerKind: declared.data } : { body: written }),
      ...(thread.success ? { conversationId: thread.data } : {}),
    })
    if (result.outcome === 'refused') {
      return refuse(result.error.message, ERROR_STATUS[result.error.code])
    }

    if (!wantsHtml(request)) {
      return reply.status(200).send({ outcome: result.outcome, ...result.response })
    }

    return reply
      .status(303)
      .header('location', `/inbox/${String(result.response.conversationId)}?said=sent`)
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
      /** What the box holds when it is drawn again (`#1548`). */
      readonly body?: string
      /** What to say if an addition to a shared entry was just refused (`#1574`). */
      readonly shareError?: string
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
        signedIn: true,
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
        /**
         * The entries shared onto this thread (`#1574`).
         *
         * **Passed through, not queried.** `getThread` already returns them —
         * `conversationShares` keys them by conversation — so this issue adds a
         * renderer and no read. The share whose invisibility was measured on
         * 2026-08-21 was in this response the whole time.
         */
        shares: read.response.shares,
        /**
         * Where a write lands, and where the value is read.
         *
         * **The console's own path**, never the durable token: `#428` refuses a
         * bearer link inside a page served behind a login. Both are the same
         * path here because reading and writing a share are both things
         * `/agents/:agentId/operator` already does.
         */
        ...(deps.operatorShares === undefined
          ? {}
          : {
              shareAction: consoleOperatorPath(row.agentId),
              readAt: consoleOperatorPath(row.agentId),
            }),
        ...(outcome.shareError === undefined ? {} : { shareError: outcome.shareError }),
        writable,
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
        ...(outcome.sent === true ? { sent: true } : {}),
        ...(outcome.body === undefined ? {} : { body: outcome.body }),
      }),
    )
  }

  /**
   * What a new thread may be about, across this person's agents (`#1551`, from
   * `#1452`).
   *
   * **Only that agent's own things.** An account another citizen holds, or a task
   * this one never attempted, is not a subject its operator may name — the
   * citizen's side already checks exactly this (`#1441`), and the person's side
   * needs the same check. The list is built *from* what each agent holds, so a
   * value not in it is refused rather than filtered.
   *
   * **Proved and in use only, for accounts.** A thread about an account the
   * citizen merely wrote down is a thread about a claim.
   *
   * **Open attempts only, for tasks.** A closed one is work the citizen has
   * finished reporting on; offering it would be offering a subject nobody is
   * blocked on, which is how a picker over everything starts.
   *
   * Empty where no register is wired, which renders as no picker rather than as
   * an empty one.
   */
  const composeSubjects = async (
    operated: readonly { readonly id: AgentId; readonly name: string }[],
  ): Promise<
    readonly {
      readonly value: string
      readonly agentId: string
      readonly label: string
      readonly kind: 'task' | 'account'
      readonly subjectId: string
    }[]
  > => {
    const found: {
      value: string
      agentId: string
      label: string
      kind: 'task' | 'account'
      subjectId: string
    }[] = []

    for (const agent of operated) {
      for (const account of await deps.accounts.register.list(agent.id)) {
        if (!account.proved || account.status !== 'in-use') continue
        found.push({
          value: `account:${account.id}`,
          agentId: String(agent.id),
          label: `${agent.name} — ${account.identifier}`,
          kind: 'account',
          subjectId: account.id,
        })
      }

      for (const task of (await deps.operatorMessaging?.openTasks?.(agent.id)) ?? []) {
        found.push({
          value: `task:${task.id}`,
          agentId: String(agent.id),
          label: `${agent.name} — ${task.title}`,
          kind: 'task',
          subjectId: task.id,
        })
      }
    }

    return found
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
  /**
   * The inbox, rendered (`#1448`, filters `#1450`, per agent `#1453`).
   *
   * **One renderer, three doors.** `/inbox`, `/agents/:agentId/messages` and
   * every refusal from the compose form come through here. Three renderers
   * would be three chances for the count on one to disagree with the list on
   * another, and the ACL is stated once rather than three times.
   *
   * **A refusal renders rather than redirects**, so the wording never goes into
   * a URL. `#570` states the rule on the dashboard — *a code from a closed set
   * and never a sentence in the URL* — and it applies here for the same reason:
   * a link somebody was sent must not be able to put words on this page in the
   * Colony's voice.
   */
  const renderInbox = async (
    request: FastifyRequest,
    reply: FastifyReply,
    signedIn: { readonly human: { readonly id: HumanId; readonly roles: readonly string[] } },
    options: {
      readonly onlyAgent?: AgentId | undefined
      readonly composeError?: string | undefined
      readonly status?: number | undefined
    } = {},
  ): Promise<FastifyReply> => {
    const desk = deps.operatorMessaging

    /**
     * Open by default (`#1449`). An inbox is what is left to deal with, and a
     * page that opened on *all* would be a log rather than an inbox.
     */
    const asked = (request.query as { view?: string }).view
    const view: InboxView = asked === 'archived' || asked === 'all' ? asked : 'open'

    /**
     * The filters, as query parameters (`#1450`).
     *
     * **So that a filtered inbox is a link somebody can keep.** State held in a
     * session would make *everything about the mailbox* a place a person has to
     * navigate back to rather than something they can bookmark or paste.
     *
     * **Ignored rather than refused when malformed.** An `agent` that is not a
     * uuid is somebody's mangled link, and an inbox that answers 400 to one is
     * worse than an inbox that answers with the unfiltered list.
     */
    const query = request.query as {
      readonly agent?: string
      readonly account?: string
      readonly unread?: string
      readonly sent?: string
      readonly q?: string
    }
    /**
     * A uuid, or nothing. The store interpolates these into `::uuid` casts, so
     * anything that is not one would be a database error rather than an empty
     * list — and an empty list is the honest answer to *threads about a thing
     * that does not exist*.
     */
    const uuid = (value: string | undefined): string | undefined =>
      typeof value === 'string' && AgentIdSchema.safeParse(value).success ? value : undefined

    // The path wins over the query string: `/agents/<id>/messages?agent=<other>`
    // is one link contradicting itself, and the one in the path is the one the
    // person clicked.
    const agent = options.onlyAgent === undefined ? uuid(query.agent) : String(options.onlyAgent)
    const account = uuid(query.account)

    const filters = {
      ...(agent === undefined ? {} : { agentId: AgentIdSchema.parse(agent) }),
      ...(account === undefined ? {} : { accountId: account }),
      ...(query.unread === undefined ? {} : { unreadOnly: true }),
      ...(query.sent === undefined ? {} : { writtenByMe: true }),
      ...(typeof query.q === 'string' && query.q.trim() !== '' ? { search: query.q } : {}),
    }

    const threads =
      desk?.inbox === undefined ? [] : await desk.inbox(signedIn.human.id, { view, ...filters })

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
    }))

    if (!wantsHtml(request)) {
      return reply.status(options.status ?? 200).send({
        view,
        filters,
        threads: rows,
        ...(options.composeError === undefined ? {} : { error: options.composeError }),
      })
    }

    /**
     * The agents this person operates, for the compose form (`#1452`) and for
     * the agent filter (`#1450`) — one read, because they are the same list.
     *
     * Read on the HTML branch only: a caller asking for JSON wants the list,
     * and the pickers are furniture for the page.
     */
    const operated = await deps.humans.store.operated(signedIn.human.id)
    const subjects = await composeSubjects(operated)
    const named = operated.find((held) => String(held.id) === agent)

    /**
     * Where a message with each subject will land (`#1551`).
     *
     * **Read from the threads this person already has**, unfiltered — the list
     * above is narrowed by whatever the person is looking at, and *does a thread
     * about this exist* is a question about all of them. `about` carries the
     * subject's own id, which is what makes this a comparison rather than a
     * guess about prose.
     */
    const all = (await desk?.inbox?.(signedIn.human.id, { view: 'all' })) ?? []
    const taken = new Set(
      all.flatMap((thread) => (thread.about == null ? [] : [String(thread.about.id)])),
    )
    const plainThreads = all.flatMap((thread) => (thread.about == null ? [thread.agentId] : []))

    const accounts = subjects
      .filter((subject) => subject.kind === 'account')
      .map((subject) => ({ id: subject.subjectId, agentId: subject.agentId, label: subject.label }))

    return html(
      options.status === undefined ? reply : reply.status(options.status),
      inboxPage({
        signedIn: true,
        nav: navFor(request, signedIn.human.roles),
        threads: rows,
        view,
        agents: operated.map((held) => ({ id: String(held.id), name: held.name })),
        accounts,
        subjects: subjects.map((subject) => ({
          value: subject.value,
          agentId: subject.agentId,
          label: subject.label,
          joins: taken.has(subject.subjectId),
        })),
        plainThreads,
        ...(options.onlyAgent !== undefined && named !== undefined
          ? { onlyAgent: named.name }
          : {}),
        filters: {
          ...(filters.agentId === undefined ? {} : { agentId: String(filters.agentId) }),
          ...(filters.accountId === undefined ? {} : { accountId: filters.accountId }),
          unreadOnly: filters.unreadOnly === true,
          writtenByMe: filters.writtenByMe === true,
          search: typeof query.q === 'string' ? query.q : '',
        },
        bodyMaxLength: MESSAGE_BODY_MAX_LENGTH,
        ...(options.composeError === undefined ? {} : { composeError: options.composeError }),
      }),
    )
  }

  app.get('/inbox', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const signedIn = await person(request)
    if (signedIn === null) return signInRequired(request, reply)

    return renderInbox(request, reply, signedIn)
  })

  /**
   * The person starts a thread (`#1452`).
   *
   * ## The handler this reuses already opened threads
   *
   * `sendOperatorMessage` with no `conversationId` matches this person's plain
   * thread and, finding none, opens one — that behaviour predates this issue
   * and is what the issue asks to be established rather than rebuilt. So what
   * is new here is the surface and the account provenance, not a second path.
   *
   * **Only their own agents.** `sendOperatorMessage` refuses with
   * `not-the-operator` when `human_agents` has no row, so the authorisation is
   * the store's and this route adds none of its own.
   *
   * **No subject is typed.** A thread's subject is what it is *about*, and
   * those are chosen. A thread about nothing in particular is an ordinary
   * state.
   */
  app.post('/inbox/compose', async (request, reply) => {
    if (!(await guard(request, reply))) return reply

    const signedIn = await person(request)
    if (signedIn === null) return signInRequired(request, reply)

    const desk = deps.operatorMessaging
    if (desk === undefined) return consoleNotFound(reply, request)

    const { agentId, body, about } = (request.body ?? {}) as {
      agentId?: unknown
      body?: unknown
      about?: unknown
    }
    const written = typeof body === 'string' ? body.trim() : ''
    const to = AgentIdSchema.safeParse(agentId)
    if (!to.success) return consoleNotFound(reply, request)

    /**
     * **Rendered, not redirected** (`#1453`). This used to redirect with the
     * message in the query string, which put words on the page in the Colony's
     * voice for anybody who could hand somebody a link — the thing `#570`
     * refuses on the dashboard in as many words.
     */
    const refuse = (message: string) =>
      renderInbox(request, reply, signedIn, {
        composeError: message,
        status: ERROR_STATUS.validation_failed,
      })

    /**
     * **A subject that is not that agent's own is refused** (`#1551`), matching
     * the citizen-side check `#1441` already makes about *a citizen naming an
     * account row that is not its own*.
     *
     * It is checked against the list the picker was built from rather than by a
     * second query, so the two cannot disagree — and the comparison is on the
     * pair, so an account of *this* person's other agent is refused as firmly as
     * a stranger's.
     */
    const named = typeof about === 'string' && about !== '' ? about : undefined
    let provenance: { accountId?: string; taskId?: TaskId } = {}

    if (named !== undefined) {
      const operated = await deps.humans.store.operated(signedIn.human.id)
      const allowed = (await composeSubjects(operated)).find(
        (one) => one.value === named && one.agentId === String(to.data),
      )
      if (allowed === undefined) return consoleNotFound(reply, request)

      provenance =
        allowed.kind === 'account'
          ? { accountId: allowed.subjectId }
          : { taskId: TaskIdSchema.parse(allowed.subjectId) }
    }

    if (written.length < MESSAGE_BODY_MIN_LENGTH || written.length > MESSAGE_BODY_MAX_LENGTH) {
      return refuse(messageBodyError.message)
    }

    /**
     * **`#236`'s reason, unchanged**: a person writing to their agent has often
     * just made it an account, and this is where a password most likely
     * actually arrives. A refusal costs them nothing.
     */
    const finding = credentialFinding(written)
    if (finding !== null) return refuse(credentialRefusalMessage(finding))

    const result = await desk.send(signedIn.human.id, to.data, {
      body: written,
      ...provenance,
    })

    if (result.outcome === 'refused') {
      if (!wantsHtml(request)) {
        return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
      }
      return consoleNotFound(reply, request)
    }

    if (!wantsHtml(request)) {
      return reply.status(200).send({ outcome: result.outcome, ...result.response })
    }

    return reply
      .status(303)
      .header('location', `/inbox/${String(result.response.conversationId)}?said=sent`)
      .send()
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

    const { body, fill } = (request.body ?? {}) as { body?: unknown; fill?: unknown }
    const written = typeof body === 'string' ? body.trim() : ''

    const refuse = (message: string) =>
      inboxThread(request, reply, signedIn, {
        error: message,
        status: ERROR_STATUS.validation_failed,
        body: written,
      })

    /**
     * **A press that fills rather than sends** (`#1548`).
     *
     * The console has no script, so *put this sentence in the box* is a round
     * trip. What comes back is the sentence, editable, in the field that will
     * actually be sent — and **whatever was already typed is kept under it**,
     * because discarding it is the defect this issue is about. A person who
     * pressed by mistake still has their words.
     */
    const asked = OperatorAnswerKindSchema.safeParse(fill)
    if (fill !== undefined) {
      if (!asked.success) return refuse(messageDeclarationError.message)

      const sentence = OPERATOR_ANSWER_BODIES[asked.data]
      return inboxThread(request, reply, signedIn, {
        body: written === '' ? sentence : `${sentence}\n\n${written}`,
      })
    }

    if (written.length < MESSAGE_BODY_MIN_LENGTH || written.length > MESSAGE_BODY_MAX_LENGTH) {
      return refuse(messageBodyError.message)
    }

    const finding = credentialFinding(written)
    if (finding !== null) return refuse(credentialRefusalMessage(finding))

    /**
     * **The tag follows the body, not the button** (`#1548`). A body that *is* a
     * canonical sentence carries its `answerKind`, so `#1093`'s guarantee to the
     * citizen is intact: anything tagged *I have done it* says only that. An
     * edited one is an ordinary message.
     */
    const declared = answerKindOfBody(written)

    const result = await desk.send(signedIn.human.id, found.agentId as AgentId, {
      ...(declared === undefined ? { body: written } : { answerKind: declared }),
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
   * Archive and un-archive, as one route and an `act` (`#1449`).
   *
   * **One route and an `act`, not two routes.** They are the same gesture on the
   * same thread from the same list, and a person who pressed the wrong one has
   * pressed a button rather than found a different page. The shape is kept
   * rather than collapsed into a single toggle so the page says which way it
   * meant it, and so a third state — if one is ever measured to be wanted — is a
   * value here rather than a route.
   *
   * **There were three, and `#1549` withdrew mute.** Nobody had ever used it: 0
   * of 107 participants. What it guarded against was a flood, and `#1451` caps
   * notifications at one per thread per person per day, so there was none to
   * silence.
   *
   * **It does not mark read**, and reading does not archive. Somebody who
   * archives an unread thread has decided not to read it, which is a thing they
   * are allowed to decide.
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

    const outcome =
      act === 'archive'
        ? await desk.archive?.(signedIn.human.id, parsed.data, true)
        : act === 'unarchive'
          ? await desk.archive?.(signedIn.human.id, parsed.data, false)
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
         * The console's own inbox, narrowed to this agent (`#1547`).
         *
         * **Not a token URL**, which is `#428`'s rule and the reason this is the
         * door's parameter rather than something the renderer composes: a
         * durable bearer link inside a page served behind a login is a
         * credential leaking downward for no gain.
         */
        inboxBase: `/inbox?agent=${agentId}`,
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
            inboxBase: `/inbox?agent=${agentId}`,
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

    /*
     * `intent === 'note'` and the `answerOperatorThread` fallthrough stood here
     * until `#1547`. They were this door's half of the durable page's two
     * message forms — the note box and the three declarations with their
     * *Explain instead* field — and the page no longer renders either. Both acts
     * survive at `/inbox`, which is now the one place an operator writes: the
     * note is the inbox's compose, and the declarations are the buttons beside
     * the reply box. One writer, reached two ways.
     */
    return consoleNotFound(reply, request)
  })
}
