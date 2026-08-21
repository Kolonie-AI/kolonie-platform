import { ERROR_STATUS, type AgentId, type HumanId } from '@kolonie-ai/core'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { authenticate } from '../authentication.js'
import { CONSOLE_HEADERS, signInPage } from '../console/html.js'
import type { ConsoleNav } from '../console/navigation.js'
import { emptyAgentPages } from '../console/agent-page.js'
import { sessionCookie } from './authenticated.js'
import { type OperatorPageView } from '@kolonie-ai/db'

import { OFFERED_PROVIDERS } from '../humans/humans.js'
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
import { consoleNotFound, html, wantsHtml } from './console-shared.js'

/**
 * What every console page closes over, built once (`#1498`).
 *
 * ## Why a context and not a module of helpers
 *
 * `registerConsolePages` was one 5,221-line function, and these eleven values
 * were declared *inside* it — so every route handler captured them from scope.
 * There was nothing at module level to extract, which is the opposite of what
 * `#1500` found in `mcp/tools/accounts.ts` next door, and it is the thing
 * `#1498` named as most of the work and as what turns a move into a rewrite.
 *
 * **The shape is not an invention.** `registerSponsorPages` in that same file
 * already took `(app, deps, ctx)` with `guard`, `caller` and `person` on the
 * object, for the quest routes. The other six groups now do what it did.
 *
 * ## Four were declared far from where they are used
 *
 * `maintainer` at 1189, `signInRequired` at 2526, `operatorDoor` at 2645,
 * `operatedAgent` at 2728 and `agentNavFor` at 2764 — each in the middle of one
 * group's territory while three or four other groups used them. That is the line
 * `#1498` predicted the helpers would argue for, and it is why the split could
 * not simply follow the route order.
 *
 * Every line below is the bytes that were in `console-pages.ts`, unchanged.
 */
export function consolePageContext(deps: RouteDependencies, host: string) {
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
  return {
    host,
    onConsoleHost,
    guard,
    providers,
    person,
    caller,
    maintainer,
    signInRequired,
    operatorDoor,
    operatedAgent,
    agentNavFor,
  }
}

/**
 * **Derived rather than declared.** Writing the eleven signatures by hand is
 * eleven chances to describe a closure as something it is not, and the compiler
 * already knows each one exactly. A context that cannot drift from what it
 * returns is the whole reason this is a `ReturnType` and not an `interface`.
 */
export type ConsolePageContext = ReturnType<typeof consolePageContext>
