import { isSettled } from '@kolonie-ai/core'
import type { DeskTicketDetail } from '@kolonie-ai/db'
import type { TicketAnswer, TicketDesk } from '../support-desk.js'

/**
 * A tickets-to-answer desk holding whatever a test handed it (`#1347`).
 *
 * **Empty by default, and that is the state the page has to render well.** A
 * desk with nothing waiting is the reading to hope for, so the default fixture
 * is the one that would catch a renderer which only works with rows.
 *
 * **It answers for real, unlike `fakeWalkRefusalDesk`.** The refusals desk only
 * reports back, because whether a suspension lifts is decided by SQL. Here the
 * write is a status and a sentence, and a route test asserting that *Answer &
 * decline* reached the desk with the words the form carried is the whole point
 * of the four buttons — so the fake keeps the rows and applies the answer.
 */
export interface FakeTicketDesk extends TicketDesk {
  /** Every answer the routes handed over, in order. */
  readonly answers: readonly TicketAnswer[]
  /** Every ticket the routes asked to promote, in order. */
  readonly promotions: readonly string[]
}

export function fakeTicketDesk(seed: readonly DeskTicketDetail[] = []): FakeTicketDesk {
  const rows = [...seed]
  const answers: TicketAnswer[] = []
  const promotions: string[] = []

  const find = (ticketId: string): DeskTicketDetail | undefined =>
    rows.find((row) => row.id === ticketId)

  return {
    answers,
    promotions,
    tickets: async () => rows,
    ticket: async (ticketId) => find(ticketId),
    answer: async (answer) => {
      answers.push(answer)
      /**
       * The one rule the fake keeps, because the route has a repair path for
       * it: a fake that accepts what the store rejects leaves that path with no
       * way to be reached from a test.
       */
      if (isSettled(answer.status) && (answer.resolution ?? '').trim() === '') {
        throw new Error(`a ${answer.status} ticket has to say why (ticket ${answer.ticketId})`)
      }
      const held = find(answer.ticketId)
      if (held === undefined) return undefined
      const written: DeskTicketDetail = {
        ...held,
        status: answer.status,
        answered: isSettled(answer.status),
        resolution: answer.resolution ?? held.resolution,
      }
      rows.splice(rows.indexOf(held), 1, written)
      return written
    },
    promote: async (ticketId) => {
      promotions.push(ticketId)
      const held = find(ticketId)
      if (held === undefined) return false
      rows.splice(rows.indexOf(held), 1)
      return true
    },
    depth: async () => {
      const waiting = rows.filter((row) => !row.answered)
      const oldest = waiting
        .map((row) => row.openedAt)
        .sort((left, right) => left.localeCompare(right))[0]
      return { unanswered: waiting.length, oldestOpenedAt: oldest ?? null }
    },
  }
}
