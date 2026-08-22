import { randomUUID } from 'node:crypto'
import type {
  AgentId,
  ConversationId,
  HumanId,
  OperatorAnswerKind,
  TaskId,
  WishId,
} from '@kolonie-ai/core'
import type { OperatorThreadDependencies, OperatorThreadStore } from '../operator-threads.js'
import { fakeOperatorPages, type fakeAutonomyMailer, type FakeOperatorPages } from './autonomy.js'

export interface FakeOperatorThreadStore extends OperatorThreadStore {
  /** Give this citizen a live page, as `kolonie.operator.page` would. */
  readonly givePage: (agentId: AgentId, address?: string) => string
  /** Take it away again, as the citizen revoking it would. */
  readonly revokePage: (agentId: AgentId) => void
  /** Open a thread on this citizen's behalf, as `kolonie.messages.send` would. */
  readonly giveThread: (
    agentId: AgentId,
    input?: { readonly context?: string; readonly taskId?: TaskId; readonly wishId?: WishId },
  ) => ConversationId
  /** Make the operator link end, which is what turns a thread read-only (`#1288`). */
  readonly unlink: (agentId: AgentId) => void
  /** What is in one thread, for a test asserting on what an answer recorded. */
  readonly messagesIn: (threadId: ConversationId) => readonly {
    readonly author: 'citizen' | 'operator'
    readonly body: string
    readonly kind: OperatorAnswerKind | null
  }[]
  /**
   * Say which person this citizen's page speaks as (`#1547`).
   *
   * In production `pageSubject` resolves it out of `human_agents` and the
   * address the page was issued to. Here it is stated, because what a test of
   * the mailed link is exercising is the routes above that resolution rather
   * than the resolution itself — which is asserted in `packages/db` against a
   * real database.
   *
   * Without it `subjectForPageToken` answers `undefined`, which is the honest
   * fake of a citizen with several operators and no address match: the page
   * renders and the inbox behind it is unreachable.
   */
  readonly operatedBy: (agentId: AgentId, humanId: string) => void
  /** What a `needs-operator` shelving looks like from here (`#234`). */
  readonly shelve: (agentId: AgentId, taskId: TaskId) => void
  readonly shelved: (agentId: AgentId, taskId: TaskId) => boolean
}

interface Thread {
  readonly id: ConversationId
  readonly agentId: AgentId
  readonly context: string
  readonly taskId: TaskId | null
  readonly wishId: WishId | null
  readonly openedAt: string
  readonly messages: {
    author: 'citizen' | 'operator'
    body: string
    /** What a pressed control declared, `null` for everything typed (`#1093`). */
    kind: OperatorAnswerKind | null
    writtenAt: string
  }[]
}

/**
 * The durable page's side of the operator channel, in memory (`#1325`).
 *
 * **The invariants the database holds are held here too**, deliberately, because
 * a fake that is more permissive than PostgreSQL lets a test pass against
 * behaviour the real store refuses: no answer through a revoked page, no write
 * into a thread whose operator link has ended, and no reach into somebody else's
 * conversation.
 *
 * **What is gone with the exchange is the ceiling**, and its absence is
 * modelled rather than merely unimplemented: epic `#1318` decision 11 abolished
 * *one open request at a time*, so this fake opens as many threads as it is
 * asked for and a test that expected a refusal is testing a rule that no longer
 * exists.
 *
 * What is *not* modelled is anything about the queries themselves — that one
 * citizen cannot reach another's row is asserted in `packages/db` against a real
 * database, where the `where` clauses actually run.
 */
export function fakeOperatorThreadStore(
  /**
   * The durable pages, shared with the autonomy module's fake rather than
   * duplicated.
   *
   * In production the page resolves through `operator_pages` by token, so a
   * fixture with two independent token maps would let a test answer through a
   * page this path had never heard of — and would hide the one thing worth
   * checking, which is that revoking the page closes this channel.
   */
  pages: FakeOperatorPages = fakeOperatorPages(),
): FakeOperatorThreadStore {
  const threads = new Map<ConversationId, Thread>()
  const unlinked = new Set<AgentId>()
  const shelvings = new Set<string>()
  const operators = new Map<AgentId, string>()

  const shelfKey = (agentId: AgentId, taskId: TaskId) => `${agentId}::${taskId}`

  return {
    forPageToken: (token) => {
      const agentId = pages.agentForToken(token)
      if (agentId === null) return Promise.resolve([])

      /**
       * **Oldest first, with the id breaking a tie** (`#593`). The fake orders
       * the way the SQL does, because a fake that returned them in insertion
       * order would let a page test pass against an ordering the database does
       * not give.
       */
      const mine = [...threads.values()]
        .filter((thread) => thread.agentId === agentId)
        .sort((a, b) => a.openedAt.localeCompare(b.openedAt) || a.id.localeCompare(b.id))

      return Promise.resolve(
        mine.map((thread) => ({
          threadId: thread.id,
          context: thread.context,
          openedAt: thread.openedAt,
          messages: thread.messages.map((message) => ({ ...message })),
          closed: unlinked.has(thread.agentId),
          // The fake carries no account and no shares (`#1442`): both are joins
          // the database makes, and a fixture that invented one would let a page
          // test pass against an assembly nothing produces.
          accountIdentifier: null,
          shares: [],
          shareEvents: [],
        })),
      )
    },

    /**
     * The token, resolved to one agent and one person (`#1547`).
     *
     * **A revoked page answers `undefined`**, like every other read here, so a
     * test that revokes the page and expects the inbox to close is testing the
     * rule the database holds rather than one this fake invented.
     */
    subjectForPageToken: (token) => {
      const agentId = pages.agentForToken(token)
      if (agentId === null) return Promise.resolve(undefined)

      const humanId = operators.get(agentId)
      return Promise.resolve(
        humanId === undefined ? undefined : { agentId, humanId: humanId as HumanId },
      )
    },

    wishesWaiting: (agentId) =>
      Promise.resolve(
        [...threads.values()]
          .filter(
            (thread) =>
              thread.agentId === agentId &&
              thread.wishId !== null &&
              !thread.messages.some((message) => message.author === 'operator'),
          )
          .map((thread) => ({ wishId: String(thread.wishId), threadId: thread.id })),
      ),

    answerOnPage: ({ token, threadId, body, kind }) => {
      const agentId = pages.agentForToken(token)
      if (agentId === null) return Promise.resolve({ outcome: 'unreachable' as const })

      const thread =
        typeof threadId === 'string' ? threads.get(threadId as ConversationId) : undefined
      if (thread === undefined || thread.agentId !== agentId || unlinked.has(agentId)) {
        return Promise.resolve({ outcome: 'unreachable' as const })
      }

      thread.messages.push({
        author: 'operator',
        body,
        kind: kind ?? null,
        writtenAt: new Date().toISOString(),
      })

      // Storage clears a `needs-operator` set-aside on the operator's message
      // (`#234`, `#1319`), so the fake does too — a test that asserted the
      // clearing would otherwise be asserting the fixture's silence.
      if (thread.taskId !== null) shelvings.delete(shelfKey(thread.agentId, thread.taskId))

      return Promise.resolve({
        outcome: 'answered' as const,
        agentId,
        threadId: thread.id,
      })
    },

    givePage: (agentId, address = 'operator@example.org') => {
      const existing = pages.liveFor(agentId)
      if (existing !== null) return existing.token

      return pages.issueNow(agentId, address)
    },

    revokePage: (agentId) => {
      const page = pages.liveFor(agentId)
      if (page === null) return
      void pages.revoke(agentId, page.address)
    },

    giveThread: (agentId, input = {}) => {
      const id = randomUUID() as ConversationId
      threads.set(id, {
        id,
        agentId,
        context: input.context ?? 'github-account',
        taskId: input.taskId ?? null,
        wishId: input.wishId ?? null,
        openedAt: new Date().toISOString(),
        messages: [
          {
            author: 'citizen',
            body: 'Could you help me with this?',
            kind: null,
            writtenAt: new Date().toISOString(),
          },
        ],
      })
      return id
    },

    unlink: (agentId) => {
      unlinked.add(agentId)
    },

    messagesIn: (threadId) =>
      (threads.get(threadId)?.messages ?? []).map((message) => ({
        author: message.author,
        body: message.body,
        kind: message.kind,
      })),

    operatedBy: (agentId, humanId) => {
      operators.set(agentId, humanId)
    },

    shelve: (agentId, taskId) => {
      shelvings.add(shelfKey(agentId, taskId))
    },

    shelved: (agentId, taskId) => shelvings.has(shelfKey(agentId, taskId)),
  }
}

export type FakeOperatorMailer = ReturnType<typeof fakeAutonomyMailer>

/**
 * The channel wired for a test that does not care about it.
 *
 * **No notifier and no allowance**, unlike the exchange fixture this replaces:
 * both belonged to the *asking* half, which is `kolonie.messages.send` now. What
 * is left is what the page reads and writes, so a test that says nothing about
 * the operator channel gets a store and a wake sender and nothing else to
 * misconfigure.
 */
export function fakeOperatorThreads(
  overrides: Partial<OperatorThreadDependencies> & {
    readonly pages?: FakeOperatorPages
  } = {},
): OperatorThreadDependencies & { readonly store: FakeOperatorThreadStore } {
  const { pages, ...rest } = overrides
  const store = fakeOperatorThreadStore(pages)

  return { store, ...rest } as OperatorThreadDependencies & {
    readonly store: FakeOperatorThreadStore
  }
}
