import {
  ERROR_STATUS,
  MESSAGE_BODY_MAX_LENGTH,
  MESSAGE_BODY_MIN_LENGTH,
  ConversationIdSchema,
  TaskIdSchema,
  OPERATOR_ANSWER_BODIES,
  OPERATOR_ANSWER_LABELS,
  OperatorAnswerKindSchema,
  answerKindOfBody,
  credentialFinding,
  credentialRefusalMessage,
  type AgentId,
  type ConversationId,
  type HumanId,
  type TaskId,
} from '@kolonie-ai/core'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { autonomyClosedPage } from '../autonomy-page.js'
import { CONSOLE_HEADERS, inboxPage, inboxThreadPage } from '../console/html.js'
import { messageBodyError, messageDeclarationError, type InboxView } from '../messaging.js'
import { composeSubjects } from './compose-subjects.js'
import type { RouteDependencies } from './dependencies.js'

/**
 * The inbox, behind the link in a notification mail (`#1547`, epic `#1447`).
 *
 * ## What was wrong
 *
 * There were **two surfaces onto the same threads**. `/inbox` in the console was
 * built by `#1448`; `operatorPageBody` is what existed before it and is what a
 * person actually meets, because the mail is what tells them there is something
 * to read. That second surface still carried the pre-thread design — three fixed
 * declarations and a separate *Explain instead (optional)* box, under every
 * message — which was right for `#1093`, where a person answered **one question
 * on a page**, and is furniture in a thread.
 *
 * While there were two, every other inbox follow-up was built twice or built
 * half: the compose fix, the two-forms defect, choosing a subject, and all the
 * visual work deliberately deferred. Unifying first turns each of those into one
 * change. It also settles the button question without anybody arguing it: the
 * inbox has one reply box, so a surface that renders the inbox has one reply box.
 *
 * ## What differs between the doors, and it is only this
 *
 * | | Console | Here |
 * |---|---|---|
 * | Who is reading | a signed-in person | the holder of `operator_pages.token` |
 * | What they see | every agent they operate | **that agent only** |
 * | Where forms post | `/inbox/…` | `/operator/page/<token>/inbox/…` |
 *
 * The renderers are the same two functions. What is different is the
 * authorisation, and that is why these route bodies are their own file rather
 * than a flag on the console's: a session and a bearer token are resolved by
 * different means, and a shared handler branching on which would be one place
 * for the two to be confused.
 *
 * ## The scoping is a filter on the read, never a promise in the markup
 *
 * `#1547`: *a mailed link that suddenly showed every agent its holder's operator
 * happens to run would be a widening nobody asked for.* So every read below
 * passes `agentId` from {@link resolve}, which takes it from the token and from
 * nothing the caller sent — the property `#241` and `#399` both rest on. A
 * conversation belonging to another of this person's agents is `not found` here,
 * exactly as one belonging to a stranger is.
 *
 * ## Host routes, not under `/v1/`
 *
 * Same reason `registerAutonomyPageRoutes` gives: these are pages a person
 * clicks out of a mail, and a URL with an API version in it is a URL that breaks
 * when the API's version moves for reasons that have nothing to do with them.
 */
export function registerOperatorInboxRoutes(app: FastifyInstance, deps: RouteDependencies): void {
  const closed = (reply: FastifyReply): FastifyReply =>
    reply.status(404).headers(CONSOLE_HEADERS).type('text/html').send(autonomyClosedPage())

  const html = (reply: FastifyReply, body: string): FastifyReply =>
    reply.headers(CONSOLE_HEADERS).type('text/html').send(body)

  /** Where this door's forms post, for one token. Every path below derives from it. */
  const baseFor = (token: string): string => `/operator/page/${token}/inbox`

  /**
   * The token, resolved to the one agent and the one person it reaches.
   *
   * **Everything downstream is scoped by what this returns and by nothing else.**
   * A revoked page, an unknown token, a citizen with several operators and no
   * address match, and a deployment with no messaging all answer `undefined` —
   * one ending for every cause, so a stranger holding a guessed token cannot tell
   * that a citizen took a real page away.
   */
  const resolve = async (
    request: FastifyRequest,
  ): Promise<
    | {
        readonly token: string
        readonly agentId: AgentId
        readonly agentName: string
        readonly humanId: HumanId
      }
    | undefined
  > => {
    const { token } = request.params as { token?: string }
    if (token === undefined) return undefined

    const view = await deps.autonomy.pages.open(token)
    if (view === null) return undefined

    const subject = await deps.operatorThreads.store.subjectForPageToken?.(token)
    if (subject === undefined) return undefined

    return {
      token,
      agentId: subject.agentId,
      agentName: view.agentName,
      humanId: subject.humanId,
    }
  }

  /**
   * The list, narrowed to this token's agent (`#1449`, `#1450`).
   *
   * **The same filters the console has, minus the one that would be a lie.**
   * There is no agent picker here because there is one agent; search, *about*,
   * *unread only* and *I have written in it* are each one predicate over this
   * person's own participant rows and are as useful behind a mailed link as
   * behind a session.
   */
  const renderInbox = async (
    request: FastifyRequest,
    reply: FastifyReply,
    at: {
      readonly token: string
      readonly agentId: AgentId
      readonly agentName: string
      readonly humanId: HumanId
    },
    outcome: {
      readonly composeError?: string | undefined
      readonly status?: number | undefined
    } = {},
  ): Promise<FastifyReply> => {
    const desk = deps.operatorMessaging
    if (desk?.inbox === undefined) return closed(reply)

    const asked = (request.query as { view?: string }).view
    const view: InboxView = asked === 'archived' || asked === 'all' ? asked : 'open'

    const query = request.query as {
      readonly account?: string
      readonly unread?: string
      readonly sent?: string
      readonly q?: string
    }
    const account =
      typeof query.account === 'string' && query.account !== '' ? query.account : undefined

    const filters = {
      // From the token, never from the query string. This is the scoping.
      agentId: at.agentId,
      ...(account === undefined ? {} : { accountId: account }),
      ...(query.unread === undefined ? {} : { unreadOnly: true }),
      ...(query.sent === undefined ? {} : { writtenByMe: true }),
      ...(typeof query.q === 'string' && query.q.trim() !== '' ? { search: query.q } : {}),
    }

    const threads = await desk.inbox(at.humanId, { view, ...filters })
    const subjects = await composeSubjects(deps, [{ id: at.agentId, name: at.agentName }])
    const all = await desk.inbox(at.humanId, { agentId: at.agentId, view: 'all' })
    const taken = new Set(
      all.flatMap((thread) => (thread.about == null ? [] : [String(thread.about.id)])),
    )
    const plainThreads = all.flatMap((thread) => (thread.about == null ? [thread.agentId] : []))

    return html(
      outcome.status === undefined ? reply : reply.status(outcome.status),
      inboxPage({
        base: baseFor(at.token),
        threads: threads.map((thread) => ({
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
        })),
        view,
        onlyAgent: at.agentName,
        /**
         * **One agent, so the compose is a box rather than a picker.** This is
         * what `#239` gave the durable page — a way to say something nobody
         * asked — and losing it in the move would have cost the operator the
         * only unprompted route they have.
         */
        agents: [{ id: String(at.agentId), name: at.agentName }],
        subjects: subjects.map((subject) => ({
          value: subject.value,
          agentId: subject.agentId,
          label: subject.label,
          joins: taken.has(subject.subjectId),
        })),
        plainThreads,
        filters: {
          ...(account === undefined ? {} : { accountId: account }),
          unreadOnly: filters.unreadOnly === true,
          writtenByMe: filters.writtenByMe === true,
          search: typeof query.q === 'string' ? query.q : '',
        },
        bodyMaxLength: MESSAGE_BODY_MAX_LENGTH,
        /**
         * The rest of what this person holds (`#1547`). They arrived from a mail
         * and have no navigation, so the badge wall, the contract and what the
         * agent has proved need a way back or they are unreachable from here.
         */
        alongside: {
          href: `/operator/page/${at.token}`,
          label: `Everything else about ${at.agentName}`,
        },
        ...(outcome.composeError === undefined ? {} : { composeError: outcome.composeError }),
      }),
    )
  }

  /**
   * One thread, and **opening it is what marks it read** — the same rule the
   * console follows, for the same reason: rendering the thread *is* reading it.
   *
   * **The agent check is this door's own and is not delegated.** `getThread`
   * refuses a conversation this person is not in, which is the console's whole
   * ACL and is not enough here: a person operating two agents is in both their
   * threads, and this token reaches one of them.
   */
  const renderThread = async (
    request: FastifyRequest,
    reply: FastifyReply,
    at: {
      readonly token: string
      readonly agentId: AgentId
      readonly agentName: string
      readonly humanId: HumanId
    },
    outcome: {
      readonly error?: string | undefined
      readonly status?: number | undefined
      readonly sent?: boolean | undefined
      /** What the box holds when it is drawn again (`#1548`). */
      readonly body?: string | undefined
    } = {},
  ): Promise<FastifyReply> => {
    const desk = deps.operatorMessaging
    if (desk === undefined) return closed(reply)

    const found = await threadOf(request, at)
    if (found === undefined) return closed(reply)

    const read = await desk.getThread(at.humanId, found.conversationId)
    if (read.outcome !== 'read') return closed(reply)

    await desk.markRead?.(at.humanId, found.conversationId)

    return html(
      outcome.status === undefined ? reply : reply.status(outcome.status),
      inboxThreadPage({
        base: baseFor(at.token),
        conversationId: String(found.conversationId),
        agentId: String(at.agentId),
        agentName: at.agentName,
        about: found.about,
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
         * The entries shared onto this thread (`#1574`), on this door too.
         *
         * `#1442` put a share inside the conversation that explains it and
         * reached one of the two surfaces. `#1547` made them one renderer, so
         * this reaches both — D-134 rule 1, which exists because a mechanism
         * that reaches one door is a mechanism half the operators cannot see.
         */
        shares: read.response.shares,
        /** The token's own page is where a share is written and read. */
        shareAction: `/operator/page/${at.token}`,
        readAt: `/operator/page/${at.token}`,
        /**
         * A live page means a live operator link: `subjectForPageToken` resolves
         * through `human_agents`, so a thread reachable here is one this person
         * still operates. The console has to ask separately because a session
         * outlives the relationship; a token does not.
         */
        writable: true,
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
        ...(outcome.sent === true ? { sent: true } : {}),
        ...(outcome.body === undefined ? {} : { body: outcome.body }),
      }),
    )
  }

  /**
   * The conversation named in the path, if this token reaches it.
   *
   * **Found in the scoped listing rather than fetched and then checked.** The
   * listing is already narrowed to this agent, so a thread of the person's
   * *other* agent is absent rather than refused — and the two cases produce the
   * same answer, which is the point.
   */
  const threadOf = async (
    request: FastifyRequest,
    at: { readonly agentId: AgentId; readonly humanId: HumanId },
  ): Promise<
    { readonly conversationId: ConversationId; readonly about: string | null } | undefined
  > => {
    const parsed = ConversationIdSchema.safeParse(
      (request.params as { conversationId?: string }).conversationId,
    )
    if (!parsed.success) return undefined

    const rows = await deps.operatorMessaging?.inbox?.(at.humanId, {
      agentId: at.agentId,
      view: 'all',
    })
    const row = rows?.find((one) => String(one.conversationId) === String(parsed.data))

    return row === undefined
      ? undefined
      : { conversationId: parsed.data, about: row.about?.label ?? null }
  }

  app.get('/operator/page/:token/inbox', async (request, reply) => {
    const at = await resolve(request)
    if (at === undefined) return closed(reply)

    return renderInbox(request, reply, at)
  })

  app.get('/operator/page/:token/inbox/:conversationId', async (request, reply) => {
    const at = await resolve(request)
    if (at === undefined) return closed(reply)

    const { said } = request.query as { said?: string }
    return renderThread(request, reply, at, { sent: said === 'sent' })
  })

  /**
   * The reply.
   *
   * **The console's rules, unchanged**, because they are the channel's rather
   * than the door's: the credential check runs here for `#236`'s reason — an
   * operator who has just created an account is holding a password and is one
   * paste away from putting it in a database — the body bounds are the same, and
   * a declaration carries no body of its own (`#1093`).
   */
  app.post('/operator/page/:token/inbox/:conversationId', async (request, reply) => {
    const at = await resolve(request)
    if (at === undefined) return closed(reply)

    const desk = deps.operatorMessaging
    if (desk === undefined) return closed(reply)

    const found = await threadOf(request, at)
    if (found === undefined) return closed(reply)

    const { body, fill } = (request.body ?? {}) as { body?: unknown; fill?: unknown }
    const written = typeof body === 'string' ? body.trim() : ''

    const refuse = (message: string) =>
      renderThread(request, reply, at, {
        error: message,
        status: ERROR_STATUS.validation_failed,
        body: written,
      })

    /**
     * **The same rule as the console's, because it is the channel's** (`#1548`).
     *
     * `#1547` made these one renderer so a change like this is one change; a
     * *fill* that worked on one door and not the other would be the two-surfaces
     * problem rebuilt one issue later, which is what D-134 rule 1 refuses.
     */
    const asked = OperatorAnswerKindSchema.safeParse(fill)
    if (fill !== undefined) {
      if (!asked.success) return refuse(messageDeclarationError.message)

      const sentence = OPERATOR_ANSWER_BODIES[asked.data]
      return renderThread(request, reply, at, {
        body: written === '' ? sentence : `${sentence}\n\n${written}`,
      })
    }

    if (written.length < MESSAGE_BODY_MIN_LENGTH || written.length > MESSAGE_BODY_MAX_LENGTH) {
      return refuse(messageBodyError.message)
    }

    const finding = credentialFinding(written)
    if (finding !== null) return refuse(credentialRefusalMessage(finding))

    // The tag follows the body, not the button. See `answerKindOfBody`.
    const declared = answerKindOfBody(written)

    const result = await desk.send(at.humanId, at.agentId, {
      ...(declared === undefined ? { body: written } : { answerKind: declared }),
      conversationId: found.conversationId,
    })

    if (result.outcome === 'refused') {
      return refuse(result.error.message)
    }

    return reply
      .status(303)
      .header(
        'location',
        `${baseFor(at.token)}/${String(result.response.conversationId)}?said=sent`,
      )
      .send()
  })

  /**
   * Saying something nobody asked for (`#239`), through the inbox's own compose.
   *
   * **The `agentId` the form posts is checked against the token and never
   * trusted.** The markup renders it as a hidden field because a menu of one is
   * a control that looks like a choice; a hidden field is still something a
   * person can edit, and the only thing standing between that and another
   * citizen's thread is this comparison.
   */
  app.post('/operator/page/:token/inbox/compose', async (request, reply) => {
    const at = await resolve(request)
    if (at === undefined) return closed(reply)

    const desk = deps.operatorMessaging
    if (desk === undefined) return closed(reply)

    const { agentId, body, about } = (request.body ?? {}) as {
      agentId?: unknown
      body?: unknown
      about?: unknown
    }
    if (typeof agentId === 'string' && agentId !== '' && agentId !== String(at.agentId)) {
      return closed(reply)
    }

    const written = typeof body === 'string' ? body.trim() : ''

    const refuse = (message: string) =>
      renderInbox(request, reply, at, {
        composeError: message,
        status: ERROR_STATUS.validation_failed,
      })

    /**
     * The token narrows both the picker and this check to one agent (`#1612`).
     * The address-scoped index may lead this person to other agents' pages, but
     * holding those links does not widen any one token's authority.
     */
    const named = typeof about === 'string' && about !== '' ? about : undefined
    let provenance: { accountId?: string; taskId?: TaskId } = {}

    if (named !== undefined) {
      const allowed = (await composeSubjects(deps, [{ id: at.agentId, name: at.agentName }])).find(
        (one) => one.value === named && one.agentId === String(at.agentId),
      )
      if (allowed === undefined) return closed(reply)

      provenance =
        allowed.kind === 'account'
          ? { accountId: allowed.subjectId }
          : { taskId: TaskIdSchema.parse(allowed.subjectId) }
    }

    if (written.length < MESSAGE_BODY_MIN_LENGTH || written.length > MESSAGE_BODY_MAX_LENGTH) {
      return refuse(messageBodyError.message)
    }

    const finding = credentialFinding(written)
    if (finding !== null) return refuse(credentialRefusalMessage(finding))

    const result = await desk.send(at.humanId, at.agentId, { body: written, ...provenance })

    if (result.outcome === 'refused') return refuse(result.error.message)

    return reply
      .status(303)
      .header(
        'location',
        `${baseFor(at.token)}/${String(result.response.conversationId)}?said=sent`,
      )
      .send()
  })

  /**
   * Archive and un-archive (`#1449`), on this door too.
   *
   * **Because the list here renders the button.** A surface offering a control
   * whose route only the other door has is the two-surfaces problem in
   * miniature, which is what this issue exists to end.
   */
  app.post('/operator/page/:token/inbox/:conversationId/state', async (request, reply) => {
    const at = await resolve(request)
    if (at === undefined) return closed(reply)

    const found = await threadOf(request, at)
    if (found === undefined) return closed(reply)

    const { act, back } = (request.body ?? {}) as { act?: unknown; back?: unknown }
    const outcome =
      act === 'archive'
        ? await deps.operatorMessaging?.archive?.(at.humanId, found.conversationId, true)
        : act === 'unarchive'
          ? await deps.operatorMessaging?.archive?.(at.humanId, found.conversationId, false)
          : undefined

    if (outcome === undefined || outcome.outcome === 'not-a-participant') return closed(reply)

    const base = baseFor(at.token)

    return reply
      .status(303)
      .header('location', typeof back === 'string' && back.startsWith(base) ? back : base)
      .send()
  })
}
