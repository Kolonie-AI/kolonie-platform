import { capabilitiesFromForm } from '@kolonie-ai/core'
import { type AgentId, type HumanId } from '@kolonie-ai/core'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ConsoleNav } from '../console/navigation.js'
import { zoneFrom } from '../console/time.js'
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
import { autonomyFormPage, autonomyRevisedPage } from '../autonomy-page.js'

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
export function registerConsoleAgentPages(
  app: FastifyInstance,
  deps: RouteDependencies,
  ctx: ConsolePageContext,
): void {
  const { guard, operatedAgent, agentNavFor } = ctx

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
}
