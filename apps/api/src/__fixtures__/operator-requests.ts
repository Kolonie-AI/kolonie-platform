import { randomUUID } from 'node:crypto'
import type {
  AgentId,
  OperatorRequest,
  OperatorRequestAuthor,
  OperatorRequestId,
  TaskId,
} from '@kolonie-ai/core'
import type { OperatorRequestDependencies, OperatorRequestStore } from '../operator-requests.js'
import { fakeAutonomyMailer, fakeOperatorPages, type FakeOperatorPages } from './autonomy.js'
import { support } from '../support.js'
import { fakeSupportDesk } from './support.js'

export interface FakeOperatorRequestStore extends OperatorRequestStore {
  /** Give this citizen a live page, as `kolonie.operator.page` would. */
  readonly givePage: (agentId: AgentId, address?: string) => string
  /** Take it away again, as the citizen revoking it would. */
  readonly revokePage: (agentId: AgentId) => void
  /** Make a task exist, so `open` has something to attach a request to. */
  readonly giveTask: (title?: string) => TaskId
  /** What a `needs-operator` shelving looks like from here (`#234`). */
  readonly shelve: (agentId: AgentId, taskId: TaskId) => void
  readonly shelved: (agentId: AgentId, taskId: TaskId) => boolean
}

interface Row {
  readonly id: OperatorRequestId
  readonly agentId: AgentId
  readonly taskId: TaskId
  readonly openedAt: string
  closedAt: string | null
  readonly messages: { author: OperatorRequestAuthor; body: string; writtenAt: string }[]
}

/**
 * The operator channel's storage, in memory.
 *
 * **The invariants the database holds are held here too**, deliberately, because a
 * fake that is more permissive than PostgreSQL lets a test pass against behaviour
 * the real store refuses: one open exchange per citizen, no answer through a revoked
 * page, no write to a closed exchange, and no read of somebody else's.
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
  const shelvings = new Set<string>()

  const shelfKey = (agentId: AgentId, taskId: TaskId) => `${agentId}::${taskId}`

  const view = (row: Row): OperatorRequest => ({
    id: row.id,
    agentId: row.agentId,
    taskId: row.taskId,
    taskTitle: tasks.get(row.taskId) ?? '',
    openedAt: row.openedAt,
    closedAt: row.closedAt,
    answered: row.messages.some((message) => message.author === 'operator'),
    messages: row.messages.map((message) => ({ ...message })),
  })

  const openRowFor = (agentId: AgentId): Row | undefined =>
    [...rows.values()].find((row) => row.agentId === agentId && row.closedAt === null)

  return {
    open: ({ agentId, taskId, body }) => {
      if (!tasks.has(taskId)) return Promise.resolve({ outcome: 'no-such-task' as const })

      const alreadyOpen = openRowFor(agentId)
      if (alreadyOpen !== undefined) {
        return Promise.resolve({
          outcome: 'already-open' as const,
          openRequestId: alreadyOpen.id,
        })
      }

      if (pages.liveFor(agentId) === null) {
        return Promise.resolve({ outcome: 'no-operator' as const })
      }

      const row: Row = {
        id: randomUUID() as OperatorRequestId,
        agentId,
        taskId,
        openedAt: new Date().toISOString(),
        closedAt: null,
        messages: [{ author: 'citizen', body, writtenAt: new Date().toISOString() }],
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
      row.messages.push({ author: 'citizen', body, writtenAt: new Date().toISOString() })
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

    openExchangeForToken: (token) => {
      const agentId = pages.agentForToken(token)
      if (agentId === null) return Promise.resolve(undefined)

      const open = openRowFor(agentId)
      // The open exchange wins; a closed one appears only once the citizen has
      // answered into it after it closed (`#359`).
      const row =
        open ??
        [...rows.values()]
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
          .sort((a, b) => String(b.closedAt).localeCompare(String(a.closedAt)))[0]

      if (row === undefined) return Promise.resolve(undefined)

      return Promise.resolve({
        requestId: row.id,
        taskTitle: tasks.get(row.taskId) ?? '',
        openedAt: row.openedAt,
        messages: row.messages.map((message) => ({ ...message })),
        closed: row.closedAt !== null,
      })
    },

    answer: ({ token, requestId, body }) => {
      const agentId = pages.agentForToken(token)
      if (agentId === null) return Promise.resolve({ outcome: 'unreachable' as const })

      const row = rows.get(requestId)
      if (row === undefined || row.agentId !== agentId || row.closedAt !== null) {
        return Promise.resolve({ outcome: 'unreachable' as const })
      }

      row.messages.push({ author: 'operator', body, writtenAt: new Date().toISOString() })

      const key = shelfKey(row.agentId, row.taskId)
      const clearedSetAside = shelvings.delete(key)

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

    shelve: (agentId, taskId) => {
      shelvings.add(shelfKey(agentId, taskId))
    },

    shelved: (agentId, taskId) => shelvings.has(shelfKey(agentId, taskId)),
  }
}

/**
 * The operator channel wired for a test that does not care about it.
 *
 * **Mailer and base url present by default**, for the reason `fakeAutonomy` gives:
 * absent means *the Colony cannot send*, which is a 503, and a test that had not
 * thought about it would read that as a refusal.
 *
 * The allowance is a real `support()` surface rather than an always-allow stub, so
 * the sharing that `#236` requires is exercised by every test that opens a request
 * rather than only by the one that asserts it.
 */
export function fakeOperatorRequests(
  overrides: Partial<OperatorRequestDependencies> & { readonly pages?: FakeOperatorPages } = {},
): OperatorRequestDependencies & { readonly store: FakeOperatorRequestStore } {
  const { pages, ...rest } = overrides
  const store = fakeOperatorRequestStore(pages)

  return {
    store,
    allowance: support({ desk: fakeSupportDesk() }),
    mailer: fakeAutonomyMailer(),
    pageBaseUrl: 'https://console.example.org',
    ...rest,
  } as OperatorRequestDependencies & { readonly store: FakeOperatorRequestStore }
}
