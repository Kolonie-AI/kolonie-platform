import { randomUUID } from 'node:crypto'
import { MAX_UNREAD_OPERATOR_NOTES, type AgentId, type OperatorNoteId } from '@kolonie-ai/core'
import type { OperatorNoteDependencies, OperatorNoteStore } from '../operator-notes.js'
import { operatorNoteLimiter, type RateLimiter } from '../rate-limit.js'
import { fakeOperatorPages, type FakeOperatorPages } from './autonomy.js'

export interface FakeOperatorNoteStore extends OperatorNoteStore {
  /**
   * Every note this citizen has, read or not — for asserting nothing was lost.
   *
   * Still here after `#927`, and still worth having: `includeDelivered` answers
   * *what may the citizen see*, and this answers *what is in the store*. A test
   * that checked the first would no longer be able to tell a row that was kept
   * from a row that was handed back.
   */
  readonly allFor: (agentId: AgentId) => readonly {
    readonly id: OperatorNoteId
    readonly body: string
    readonly writtenAt: string
    readonly readAt: string | null
  }[]
  /** Fill the inbox to the wall without writing through the page, for one test. */
  readonly fill: (agentId: AgentId, count?: number) => void
}

interface Row {
  readonly id: OperatorNoteId
  readonly agentId: AgentId
  readonly body: string
  readonly writtenAt: string
  readAt: string | null
}

/**
 * The unsolicited channel's storage, in memory (#239).
 *
 * **The invariants the database holds are held here too**, for the reason the
 * exchange's fake states: a fixture more permissive than PostgreSQL lets a test
 * pass against behaviour the real store refuses. Here that means the unread
 * ceiling, the revoked page resolving to nothing, and reading marking read — the
 * last of which is the one a permissive fake would hide, by handing the same note
 * back twice and letting a test assert on the second read.
 */
export function fakeOperatorNoteStore(
  /**
   * The durable pages, shared rather than duplicated — same argument as
   * `fakeOperatorThreadStore`. In production a note is resolved through
   * `operator_pages` by token, so an independent token map here would let a test
   * write through a page the revoke path had never heard of, and would hide the
   * one thing worth checking: that revoking the page closes this channel too.
   */
  pages: FakeOperatorPages = fakeOperatorPages(),
): FakeOperatorNoteStore {
  const rows = new Map<OperatorNoteId, Row>()

  const unreadFor = (agentId: AgentId): Row[] =>
    [...rows.values()]
      .filter((row) => row.agentId === agentId && row.readAt === null)
      .sort((left, right) => (left.writtenAt < right.writtenAt ? -1 : 1))

  const insert = (agentId: AgentId, body: string): void => {
    const id = randomUUID() as OperatorNoteId
    rows.set(id, {
      id,
      agentId,
      body,
      // Distinct and ordered without depending on the clock's resolution: two
      // notes written in the same millisecond must still read back in the order
      // they were written, and on this box they routinely are.
      writtenAt: new Date(Date.now() + rows.size).toISOString(),
      readAt: null,
    })
  }

  return {
    write: (input) => {
      const agentId = pages.agentForToken(input.token)
      if (agentId === null) return Promise.resolve({ outcome: 'unreachable' as const })

      const unread = unreadFor(agentId).length
      if (unread >= MAX_UNREAD_OPERATOR_NOTES) {
        return Promise.resolve({ outcome: 'inbox-full' as const, unread })
      }

      insert(agentId, input.body)
      return Promise.resolve({ outcome: 'written' as const, unread: unread + 1, agentId })
    },

    read: (agentId, options) => {
      const waiting = unreadFor(agentId)
      const readAt = new Date().toISOString()
      for (const row of waiting) row.readAt = readAt

      // The same two predicates the real store uses, and in the same order:
      // marking first and unconditionally, then either what was just marked or
      // every delivered row. A fake that answered `includeDelivered` without
      // marking would let a test pass against a store that never empties.
      const answered =
        options?.includeDelivered === true
          ? [...rows.values()]
              .filter((row) => row.agentId === agentId && row.readAt !== null)
              .sort((left, right) => (left.writtenAt < right.writtenAt ? -1 : 1))
          : waiting

      return Promise.resolve(
        answered.map((row) => ({
          id: row.id,
          body: row.body,
          writtenAt: row.writtenAt,
          deliveredAt: row.readAt,
        })),
      )
    },

    countUnread: (agentId) => Promise.resolve(unreadFor(agentId).length),

    roomForToken: (token) => {
      const agentId = pages.agentForToken(token)
      if (agentId === null) return Promise.resolve(undefined)
      return Promise.resolve({ unread: unreadFor(agentId).length })
    },

    allFor: (agentId) =>
      [...rows.values()]
        .filter((row) => row.agentId === agentId)
        .sort((left, right) => (left.writtenAt < right.writtenAt ? -1 : 1))
        .map((row) => ({
          id: row.id,
          body: row.body,
          writtenAt: row.writtenAt,
          readAt: row.readAt,
        })),

    fill: (agentId, count = MAX_UNREAD_OPERATOR_NOTES) => {
      for (let index = 0; index < count; index += 1) {
        insert(agentId, `something your operator said, number ${index + 1}`)
      }
    },
  }
}

/** The dependencies, with a real limiter unless a test wants to exhaust one. */
export function fakeOperatorNotes(options?: {
  readonly pages?: FakeOperatorPages
  readonly limiter?: RateLimiter
  readonly store?: FakeOperatorNoteStore
}): OperatorNoteDependencies & { readonly store: FakeOperatorNoteStore } {
  return {
    store: options?.store ?? fakeOperatorNoteStore(options?.pages),
    limiter: options?.limiter ?? operatorNoteLimiter(),
  }
}
