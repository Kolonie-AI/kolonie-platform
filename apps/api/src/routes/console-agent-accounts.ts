import {
  ERROR_STATUS,
  AccountEpisodeIdSchema,
  AccountKindSchema,
  ENTRY_BODY_MAX_LENGTH,
  EPISODE_TITLE_MAX_LENGTH,
  SLOT_LABEL_MAX_LENGTH,
  SLOT_MAX_READS,
  SLOT_VALUE_MAX_LENGTH,
  type AgentId,
  type HumanId,
} from '@kolonie-ai/core'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { zoneFrom } from '../console/time.js'
import { agentAccountsPage, heldAccountRows } from '../console/agent-accounts.js'
import {
  accountThreadPage,
  type Conversation,
  type ConversationSlot,
} from '../console/account-thread.js'
import { atlasCatalogue, atlasStateAt } from '../provider-recipes.js'
import { markWishWanted, putOnWishList, selectBundle } from '../account-wishes.js'
import type { SealedSecret } from '../console/agent-accounts.js'

import {
  atlasPickerIndex,
  atlasPickerPath,
  atlasPickerShelf,
  pickerCategory,
} from '../console/atlas-picker.js'
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
import { consoleNotFound, html, navFor, wantsHtml, wishCatalogue } from './console-shared.js'
import { THREAD_CLOSED_NOTICE } from './console-shared.js'

import type { ConsolePageContext } from './console-page-context.js'

/**
 * Split out of `console-pages.ts` by `#1500`'s sibling `#1498`, which is a move
 * and not a rewrite — every route body below is the bytes that were in that
 * file. The closures they capture arrive as `ctx`, which is the shape
 * `registerSponsorPages` in that file already used for the quest routes.
 */
export function registerConsoleAgentAccounts(
  app: FastifyInstance,
  deps: RouteDependencies,
  ctx: ConsolePageContext,
): void {
  const { guard, operatedAgent, agentNavFor } = ctx
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
   * The per-agent messages page (`#1453`, `#1447` frozen decision 6).
   *
   * **The route stays and its builder goes.** `operatorThreadPage` concatenated
   * every thread onto one page with a reply form each — which was the only way
   * to see a conversation before `/inbox` existed, and is now a second renderer
   * of the same data that can drift from the first. This redirects into the
   * inbox narrowed to this agent, which is the same page with one filter on.
   *
   * **A redirect rather than a render**, so the address bar says what is being
   * looked at. Somebody who arrived here from the agent's own navigation and
   * then wants a second agent is one control away rather than one back button.
   */
}
