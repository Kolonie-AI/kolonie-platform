import {
  ERROR_STATUS,
  solFromLamports,
  platformFeePercentFromEnv,
  reportAudience,
  type Agent,
  type AgentId,
  type ApiError,
  type HumanId,
  type QuestTier,
  type TaskId,
  type Timestamp,
  questCanHaveAnswers,
  questCommitment,
} from '@kolonie-ai/core'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { errorPage } from '../console/html.js'
import {
  operatedQuestsPage,
  questDraftPage,
  pairAnAgentPage,
  questFormPage,
  questResultsPage,
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
import { audienceOf, html, navFor, wantsHtml } from './console-shared.js'

/**
 * The sponsor pages — the quest routes (`#1498`).
 *
 * **Moved verbatim.** This function already took `(app, deps, ctx)` before the
 * split, which is where the shape the other six groups now use came from.
 */
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
export function registerSponsorPages(
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
