import { randomUUID } from 'node:crypto'
import type {
  AgentId,
  OperatorAnswerKind,
  OperatorRequest,
  OperatorRequestAuthor,
  OperatorRequestId,
  TaskId,
  WishId,
} from '@kolonie-ai/core'
import { DEFAULT_OPERATOR_REQUEST_OPEN_MAX } from '@kolonie-ai/db'
import type { OperatorRequestDependencies, OperatorRequestStore } from '../operator-requests.js'
import { fakeAutonomyMailer, fakeOperatorPages, type FakeOperatorPages } from './autonomy.js'
import { mailingOperatorNotifier } from '../operator-notifier.js'
import { support } from '../support.js'
import { fakeSupportDesk } from './support.js'

export interface FakeOperatorRequestStore extends OperatorRequestStore {
  /** Give this citizen a live page, as `kolonie.operator.page` would. */
  readonly givePage: (agentId: AgentId, address?: string) => string
  /** Take it away again, as the citizen revoking it would. */
  readonly revokePage: (agentId: AgentId) => void
  /** Make a task exist, so `open` has something to attach a request to. */
  readonly giveTask: (title?: string) => TaskId
  /** Make a wanted wish exist for this citizen. */
  readonly giveWish: (agentId: AgentId, provider?: string, wishId?: WishId) => WishId
  /** What a `needs-operator` shelving looks like from here (`#234`). */
  readonly shelve: (agentId: AgentId, taskId: TaskId) => void
  readonly shelved: (agentId: AgentId, taskId: TaskId) => boolean
}

interface Row {
  readonly id: OperatorRequestId
  readonly agentId: AgentId
  readonly taskId: TaskId | null
  readonly wishId: WishId | null
  readonly openedAt: string
  closedAt: string | null
  readonly messages: {
    author: OperatorRequestAuthor
    body: string
    /** What a pressed control declared, `null` for everything typed (`#1093`). */
    kind: OperatorAnswerKind | null
    writtenAt: string
  }[]
}

/**
 * The operator channel's storage, in memory.
 *
 * **The invariants the database holds are held here too**, deliberately, because a
 * fake that is more permissive than PostgreSQL lets a test pass against behaviour
 * the real store refuses: a bounded number of open exchanges per citizen, no
 * answer through a revoked page, no write to a closed exchange, and no read of
 * somebody else's.
 *
 * What is *not* modelled is anything about the queries themselves — that one citizen
 * cannot reach another's row is asserted in `packages/db` against a real database,
 * where the `where` clauses actually run.
 */
export function fakeOperatorRequestStore(
  /**
   * The durable pages, shared with the autonomy module's fake rather than
   * duplicated.
   *
   * In production both sides resolve a request through `operator_pages` by token,
   * so a fixture with two independent token maps would let a test answer through a
   * page the request path had never heard of — and would hide the one thing worth
   * checking, which is that revoking the page closes this channel.
   */
  pages: FakeOperatorPages = fakeOperatorPages(),
): FakeOperatorRequestStore {
  const rows = new Map<OperatorRequestId, Row>()
  const tasks = new Map<TaskId, string>()
  const wishes = new Map<WishId, { agentId: AgentId; provider: string }>()
  const shelvings = new Set<string>()

  const shelfKey = (agentId: AgentId, taskId: TaskId) => `${agentId}::${taskId}`

  const view = (row: Row): OperatorRequest => ({
    id: row.id,
    agentId: row.agentId,
    taskId: row.taskId,
    wishId: row.wishId,
    context:
      row.taskId === null
        ? (wishes.get(row.wishId!)?.provider ?? '')
        : (tasks.get(row.taskId) ?? ''),
    openedAt: row.openedAt,
    closedAt: row.closedAt,
    answered: row.messages.some((message) => message.author === 'operator'),
    /**
     * **The last declaration wins, and most exchanges have none** (`#1093`). Derived
     * here exactly as the real store derives it, because a fake that declared what
     * the words looked like would be guessing — which is the defect the column
     * closes.
     */
    declared: row.messages.reduce<OperatorAnswerKind | null>(
      (latest, message) => message.kind ?? latest,
      null,
    ),
    messages: row.messages.map((message) => ({ ...message })),
  })

  return {
    open: (input) => {
      if (input.taskId !== undefined && !tasks.has(input.taskId)) {
        return Promise.resolve({ outcome: 'no-such-task' as const })
      }
      if (input.wishId !== undefined) {
        const wish = wishes.get(input.wishId)
        if (wish === undefined || wish.agentId !== input.agentId) {
          return Promise.resolve({ outcome: 'no-such-wish' as const })
        }
      }

      const open = [...rows.values()].filter(
        (row) => row.agentId === input.agentId && row.closedAt === null,
      )
      if (open.length >= DEFAULT_OPERATOR_REQUEST_OPEN_MAX) {
        return Promise.resolve({
          outcome: 'at-ceiling' as const,
          openRequests: open.map((row) => ({ requestId: row.id, context: view(row).context })),
        })
      }

      if (pages.liveFor(input.agentId) === null) {
        return Promise.resolve({ outcome: 'no-operator' as const })
      }

      const row: Row = {
        id: randomUUID() as OperatorRequestId,
        agentId: input.agentId,
        taskId: input.taskId ?? null,
        wishId: input.wishId ?? null,
        openedAt: new Date().toISOString(),
        closedAt: null,
        messages: [
          { author: 'citizen', body: input.body, kind: null, writtenAt: new Date().toISOString() },
        ],
      }
      rows.set(row.id, row)

      return Promise.resolve({ outcome: 'opened' as const, request: view(row) })
    },

    // A closed exchange takes a reply too (`#359`), and it does not reopen: the
    // fixture mirrors that rather than the old refusal, or every test of the new
    // path would be testing the fixture's opinion of it.
    reply: ({ agentId, requestId, body }) => {
      const row = rows.get(requestId)
      if (row === undefined || row.agentId !== agentId) return Promise.resolve(undefined)
      row.messages.push({
        author: 'citizen',
        body,
        kind: null,
        writtenAt: new Date().toISOString(),
      })
      return Promise.resolve(view(row))
    },

    close: ({ agentId, requestId }) => {
      const row = rows.get(requestId)
      if (row === undefined || row.agentId !== agentId || row.closedAt !== null) {
        return Promise.resolve(undefined)
      }
      row.closedAt = new Date().toISOString()
      return Promise.resolve(view(row))
    },

    read: ({ agentId, requestId }) => {
      const row = rows.get(requestId)
      if (row === undefined || row.agentId !== agentId) return Promise.resolve(undefined)
      return Promise.resolve(view(row))
    },

    list: (agentId) =>
      Promise.resolve(
        [...rows.values()]
          .filter((row) => row.agentId === agentId)
          .sort((a, b) => b.openedAt.localeCompare(a.openedAt))
          .map(view),
      ),

    recipient: (agentId) => {
      const page = pages.liveFor(agentId)
      return Promise.resolve(
        page === null ? undefined : { operatorAddress: page.address, pageToken: page.token },
      )
    },

    exchangesForToken: (token) => {
      const agentId = pages.agentForToken(token)
      if (agentId === null) return Promise.resolve([])

      /**
       * **Every open one, oldest first, then a closed one answered into since**
       * (`#593`, `#359`). The fake orders the way the SQL does, because a fake
       * that returned them in insertion order would let a page test pass against
       * an ordering the database does not give.
       */
      const open = [...rows.values()]
        .filter((row) => row.agentId === agentId && row.closedAt === null)
        .sort((a, b) => a.openedAt.localeCompare(b.openedAt) || a.id.localeCompare(b.id))

      const answered = [...rows.values()]
        .filter(
          (candidate) =>
            candidate.agentId === agentId &&
            candidate.closedAt !== null &&
            candidate.messages.some(
              (message) =>
                message.author === 'citizen' &&
                candidate.closedAt !== null &&
                // `>=` where the database says `>`: both timestamps here are
                // `toISOString()` at millisecond resolution, and a close
                // followed immediately by a reply lands on the same
                // millisecond. Postgres records microseconds, so the two
                // statements are never equal there.
                message.writtenAt >= candidate.closedAt,
            ),
        )
        .sort((a, b) => String(b.closedAt).localeCompare(String(a.closedAt)))
        .slice(0, 1)

      return Promise.resolve(
        [...open, ...answered].map((row) => ({
          requestId: row.id,
          context: view(row).context,
          openedAt: row.openedAt,
          messages: row.messages.map((message) => ({ ...message })),
          closed: row.closedAt !== null,
        })),
      )
    },

    answer: ({ token, requestId, body, kind }) => {
      const agentId = pages.agentForToken(token)
      if (agentId === null) return Promise.resolve({ outcome: 'unreachable' as const })

      const row = rows.get(requestId)
      if (row === undefined || row.agentId !== agentId || row.closedAt !== null) {
        return Promise.resolve({ outcome: 'unreachable' as const })
      }

      row.messages.push({
        author: 'operator',
        body,
        kind: kind ?? null,
        writtenAt: new Date().toISOString(),
      })

      const clearedSetAside =
        row.taskId === null ? false : shelvings.delete(shelfKey(row.agentId, row.taskId))

      return Promise.resolve({ outcome: 'answered' as const, clearedSetAside, agentId })
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

    giveTask: (title = 'github-account') => {
      const taskId = randomUUID() as TaskId
      tasks.set(taskId, title)
      return taskId
    },

    giveWish: (agentId, provider = 'github.com', existingId) => {
      const wishId = existingId ?? (randomUUID() as WishId)
      wishes.set(wishId, { agentId, provider })
      return wishId
    },

    shelve: (agentId, taskId) => {
      shelvings.add(shelfKey(agentId, taskId))
    },

    shelved: (agentId, taskId) => shelvings.has(shelfKey(agentId, taskId)),
  }
}

/**
 * The operator channel wired for a test that does not care about it.
 *
 * **Notifier and base url present by default**, for the reason `fakeAutonomy`
 * gives: absent means *the Colony cannot send*, which is a 503, and a test that
 * had not thought about it would read that as a refusal.
 *
 * **The default notifier is the mail one** (`#794`), which is what every
 * deployment without a Telegram bot gets — so a test that says nothing about
 * transport is testing the transport that runs in production. The recording
 * mailer behind it is returned as `mailer`, so the many tests that assert on what
 * was sent read the same object they always did.
 *
 * The allowance is a real `support()` surface rather than an always-allow stub, so
 * the sharing that `#236` requires is exercised by every test that opens a request
 * rather than only by the one that asserts it.
 */
export type FakeOperatorMailer = ReturnType<typeof fakeAutonomyMailer>

export function fakeOperatorRequests(
  overrides: Partial<OperatorRequestDependencies> & {
    readonly pages?: FakeOperatorPages
    /** The recording mailer to put behind the default notifier. */
    readonly mailer?: FakeOperatorMailer
  } = {},
): OperatorRequestDependencies & {
  readonly store: FakeOperatorRequestStore
  readonly mailer: FakeOperatorMailer
} {
  const { pages, mailer: given, ...rest } = overrides
  const store = fakeOperatorRequestStore(pages)
  const mailer = given ?? fakeAutonomyMailer()

  return {
    store,
    allowance: support({ desk: fakeSupportDesk() }),
    notifier: mailingOperatorNotifier(mailer),
    mailer,
    pageBaseUrl: 'https://console.example.org',
    ...rest,
  } as OperatorRequestDependencies & {
    readonly store: FakeOperatorRequestStore
    readonly mailer: FakeOperatorMailer
  }
}
