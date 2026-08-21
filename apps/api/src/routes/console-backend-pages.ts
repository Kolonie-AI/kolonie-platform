import {
  ERROR_STATUS,
  AccountKindSchema,
  AccountProviderSchema,
  RECIPE_REFUSAL_MAX_LENGTH,
  routeFromWording,
  type ProviderRecipe,
  solFromLamports,
  whyNotPublishable,
  type ApiError,
  type TaskId,
  questCommitment,
  ProposalActionSchema,
} from '@kolonie-ai/core'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { errorPage, accountDeletedPage, accountPage } from '../console/html.js'
import { relative, zoneFrom } from '../console/time.js'
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
import { atlasCuration } from '../provider-recipes.js'
import { COLONY_QUEST_LIMIT, DIAGNOSES_PAGE } from '@kolonie-ai/db'

import { OFFERED_PROVIDERS, clearedSessionCookie } from '../humans/humans.js'
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
import { consoleNotFound, html, navFor, wantsHtml, wordingIn } from './console-shared.js'
import { CONSULTATION_WINDOW_DAYS } from './console-shared.js'

import type { ConsolePageContext } from './console-page-context.js'

/**
 * Split out of `console-pages.ts` by `#1500`'s sibling `#1498`, which is a move
 * and not a rewrite — every route body below is the bytes that were in that
 * file. The closures they capture arrive as `ctx`, which is the shape
 * `registerSponsorPages` in that file already used for the quest routes.
 */
export function registerConsoleBackendPages(
  app: FastifyInstance,
  deps: RouteDependencies,
  ctx: ConsolePageContext,
): void {
  const { guard, person, maintainer, signInRequired } = ctx

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
    /**
     * Whether anybody has a working day (`#1423`). A third read rather than a
     * field inside `ColonyNumbers`, on the same rule the desk follows: that
     * object is one query of aggregates about the Colony's own state, and this
     * is three queries about behaviour over time.
     */
    const workingDay = await deps.quests.workingDay()

    return wantsHtml(request)
      ? html(
          reply,
          backendPage({
            nav: navFor(request, ['maintainer']),
            numbers,
            workingDay,
            ...(desk === undefined ? {} : { desk }),
          }),
        )
      : reply.send({ numbers, workingDay, ...(desk === undefined ? {} : { desk }) })
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
}
