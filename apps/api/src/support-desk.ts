import type { DeskAnswer, DeskDepth, DeskTicketDetail, DeskTicketRow } from '@kolonie-ai/db'

/**
 * An answer as it arrives off a form (`#1347`).
 *
 * The same shape the store takes, except that the id is a plain string: it
 * came out of a URL and nothing has yet said it is a ticket id. Parsing it is
 * the concrete desk's job, in `server.ts`, where a string that is not one
 * answers `undefined` rather than reaching SQL.
 */
export interface TicketAnswer extends Omit<DeskAnswer, 'ticketId'> {
  readonly ticketId: string
}

/**
 * What the console's desk page reads, and the three things it may write
 * (`#1347`).
 *
 * ## Why this is not on the triage seam
 *
 * `packages/db/src/storage/triage.ts` says nothing in `apps/api` imports it, and
 * gives the reason: the thing that reads across every citizen's tickets is a
 * process holding a database handle, never a request. That stays true. This
 * interface reaches a different set of functions, every one of which is scoped
 * to `route = 'desk'` — the tickets a citizen addressed to a person rather than
 * to the queue that files public issues.
 *
 * ## Why it is a desk beside the stores rather than a method on one
 *
 * The same argument `WalkRefusalDesk` makes. A maintainer's page and a citizen's
 * route are two surfaces, and widening a store an agent's own request goes
 * through would put them on one seam — and make every fake of that store grow
 * methods it never calls.
 *
 * ## Optional, like every other backend dependency
 *
 * A deployment without it serves the rest of the console and answers 404 for
 * `/backend/desk`, which is what `app.ts` already does for the refusals desk.
 * The nav table is what makes that visible rather than silent.
 */
export interface TicketDesk {
  /** The queue: unanswered first, oldest first inside that. */
  tickets(): Promise<readonly DeskTicketRow[]>
  /** One ticket in full, or `undefined` — including for a ticket on the colony route. */
  ticket(ticketId: string): Promise<DeskTicketDetail | undefined>
  /**
   * Write an answer and settle, acknowledge, or correct an earlier answer.
   *
   * Rejects a settled status with nothing written: a citizen told their ticket
   * is closed and not told why has been answered with silence.
   */
  answer(answer: TicketAnswer): Promise<DeskTicketDetail | undefined>
  /**
   * Hand the ticket to the colony queue instead (`#1343`).
   *
   * The only route back, and deliberately a person's to take: triage may write
   * `desk` and has no `colony` to write.
   */
  promote(ticketId: string): Promise<boolean>
  /** How much the desk owes, for the count on `/backend`. */
  depth(): Promise<DeskDepth>
}
