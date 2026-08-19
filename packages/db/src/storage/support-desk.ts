import { and, asc, count, eq, inArray, min, sql } from 'drizzle-orm'
import {
  SETTLED_TICKET_STATUSES,
  isSettled,
  type AgentId,
  type CitizenshipStatus,
  type SupportTicketId,
  type SupportTicketKind,
  type SupportTicketStatus,
  type Timestamp,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents, supportTickets } from '../schema/index.js'
import { toTimestamp } from './rows.js'

/**
 * The maintainers' desk: the tickets `#1344` routed away from triage, and the
 * four things a person may do to one (`#1347`).
 *
 * ## Why this is not in `triage.ts`
 *
 * That module's own header draws the line this would be on the wrong side of:
 * *"who may read everything: a process, never a request"*. Everything there is
 * reached by a runner holding a database handle, with no route and no credential
 * anywhere near it. This module is the opposite — read and written from
 * `/backend`, by a signed-in maintainer, over HTTP. Putting a console's write
 * path through the seam a headless runner is isolated behind would make that
 * sentence false, and the isolation is worth more than a shared `toTicket`.
 *
 * It is also not in `backend-sections.ts`, which said what this is: *"replying,
 * resolving and promoting a ticket are each a decision with a record behind it
 * ... what a maintainer may do to a ticket is its own issue with its own
 * argument"*. This is that argument.
 *
 * ## Every query here says `route = 'desk'`
 *
 * The clause is repeated rather than factored into a helper a caller could
 * forget, because it is the whole of what makes this a desk. A read that dropped
 * it would put the colony queue in front of a person answering by hand; a write
 * that dropped it would let this page answer a ticket triage is about to answer
 * too. `promoteToColony` is the single exception, and it says so.
 */

/** A ticket on the desk, as the queue lists it. */
export interface DeskTicketRow {
  readonly id: SupportTicketId
  readonly subject: string
  readonly kind: SupportTicketKind
  readonly status: SupportTicketStatus
  readonly agentId: AgentId
  readonly agentName: string
  /**
   * How the Colony stands with whoever opened it.
   *
   * **On the row because it changes how the ticket reads.** A desk ticket from a
   * suspended citizen is usually an appeal — `#1344` routes one here without
   * being asked — and a maintainer who has to open every row to find that out
   * works the queue in the wrong order.
   */
  readonly agentStatus: CitizenshipStatus
  readonly openedAt: Timestamp
  /** Whether the desk has finished with it: `resolved` or `declined`. */
  readonly answered: boolean
}

/** One ticket in full, for the page that answers it. */
export interface DeskTicketDetail extends DeskTicketRow {
  readonly body: string
  readonly resolution: string | null
  readonly issueUrl: string | null
  readonly aboutSubmissionId: string | null
  readonly aboutProvider: { readonly kind: string; readonly provider: string } | null
  readonly updatedAt: Timestamp
}

/**
 * How many rows the desk lists.
 *
 * The judgement `BACKEND_SECTION_ROWS` makes, at the size of a queue somebody
 * works through rather than glances at: a person answering by hand wants the
 * whole of what is unanswered on one page, and the settled tail is history.
 */
export const DESK_ROWS = 50

/**
 * The desk queue: **unanswered first, and oldest first inside that.**
 *
 * Two orderings, one argument. `waitingTickets` already made the age half —
 * *"a support queue read newest-first buries the ticket that has been waiting
 * longest, which is the only one whose age is a defect"* — and the settled half
 * is what keeps that true on a desk which, unlike the triage queue, never
 * drains. Sorting purely by age would put a ticket answered in March above one
 * opened this morning, and the page would stop being a queue.
 *
 * **`acknowledged` counts as unanswered.** It means *I have read this and it
 * will take a while*, which is a promise the desk still owes. Only `resolved`
 * and `declined` are endings, which is exactly what `SETTLED_TICKET_STATUSES`
 * already says — so the ordering asks core rather than listing statuses again.
 */
export async function deskTickets(
  db: Database,
  limit: number = DESK_ROWS,
): Promise<readonly DeskTicketRow[]> {
  const settled = inArray(supportTickets.status, [...SETTLED_TICKET_STATUSES])

  const rows = await db
    .select({
      id: supportTickets.id,
      subject: supportTickets.subject,
      kind: supportTickets.kind,
      status: supportTickets.status,
      agentId: supportTickets.agentId,
      agentName: agents.name,
      agentStatus: agents.status,
      openedAt: supportTickets.createdAt,
    })
    .from(supportTickets)
    .innerJoin(agents, eq(agents.id, supportTickets.agentId))
    .where(eq(supportTickets.route, 'desk'))
    .orderBy(asc(sql`case when ${settled} then 1 else 0 end`), asc(supportTickets.createdAt))
    .limit(limit)

  return rows.map((row) => ({
    id: row.id as SupportTicketId,
    subject: row.subject,
    kind: row.kind,
    status: row.status,
    agentId: row.agentId as AgentId,
    agentName: row.agentName,
    agentStatus: row.agentStatus,
    openedAt: toTimestamp(row.openedAt),
    answered: isSettled(row.status),
  }))
}

/**
 * One desk ticket, whole.
 *
 * **The body is here and not in the list**, which is the split `#1347` asked
 * for: a queue of twelve-thousand-character defect reports rendered inline is
 * not scannable, and the ceiling that allows those was raised deliberately.
 *
 * `undefined` for a ticket that is not there and for one on the colony route
 * alike — one answer for both, so this page cannot be used to read the queue
 * triage is working through by guessing at ids.
 */
export async function deskTicket(
  db: Database,
  ticketId: SupportTicketId,
): Promise<DeskTicketDetail | undefined> {
  const [row] = await db
    .select({
      ticket: supportTickets,
      agentName: agents.name,
      agentStatus: agents.status,
    })
    .from(supportTickets)
    .innerJoin(agents, eq(agents.id, supportTickets.agentId))
    .where(and(eq(supportTickets.id, ticketId), eq(supportTickets.route, 'desk')))
    .limit(1)

  if (row === undefined) return undefined

  const { ticket } = row

  return {
    id: ticket.id as SupportTicketId,
    subject: ticket.subject,
    kind: ticket.kind,
    status: ticket.status,
    agentId: ticket.agentId as AgentId,
    agentName: row.agentName,
    agentStatus: row.agentStatus,
    openedAt: toTimestamp(ticket.createdAt),
    answered: isSettled(ticket.status),
    body: ticket.body,
    resolution: ticket.resolution,
    issueUrl: ticket.issueUrl,
    aboutSubmissionId: ticket.aboutSubmissionId,
    aboutProvider:
      ticket.aboutProviderKind === null || ticket.aboutProviderName === null
        ? null
        : { kind: ticket.aboutProviderKind, provider: ticket.aboutProviderName },
    updatedAt: toTimestamp(ticket.updatedAt),
  }
}

/** What a maintainer wrote, and which ending it is. */
export interface DeskAnswer {
  readonly ticketId: SupportTicketId
  readonly status: Exclude<SupportTicketStatus, 'open'>
  readonly resolution?: string | undefined
}

/**
 * Answer a desk ticket.
 *
 * **`open` is not writable here either**, for `recordTriage`'s reason and one of
 * its own: `open` is how a ticket reaches the *colony* queue, so a desk form
 * that could write it would be a second, unlabelled promote — and promoting is a
 * decision with a route change behind it, which is the next function.
 *
 * **No compare-and-set, unlike `recordTriage`.** That guard exists because two
 * overlapping ticks of an at-least-once runner would otherwise write two answers
 * to one ticket. Here the writer is a person who pressed a button, and a second
 * press correcting the first is the point rather than a race: a maintainer who
 * resolves a ticket and then realises it should have been declined has to be
 * able to say so without the form silently doing nothing.
 *
 * `undefined` for a ticket that is not on this desk — the same one answer
 * `deskTicket` gives.
 */
export async function answerDeskTicket(
  db: Database,
  answer: DeskAnswer,
): Promise<DeskTicketDetail | undefined> {
  // The same rule `recordTriage` enforces, for the same reason: a citizen told
  // their ticket is closed and not told why has been answered with silence. It
  // is checked here rather than left to the form, because the form is not the
  // only caller a console grows.
  if (isSettled(answer.status) && (answer.resolution ?? '').trim() === '') {
    throw new Error(`a ${answer.status} ticket has to say why (ticket ${answer.ticketId})`)
  }

  const [row] = await db
    .update(supportTickets)
    .set({
      status: answer.status,
      // Left alone when the maintainer wrote nothing, rather than nulled. An
      // acknowledgement that adds no words to an answer already written should
      // not erase the answer.
      ...(answer.resolution === undefined ? {} : { resolution: answer.resolution }),
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(supportTickets.id, answer.ticketId), eq(supportTickets.route, 'desk')))
    .returning({ id: supportTickets.id })

  return row === undefined ? undefined : deskTicket(db, answer.ticketId)
}

/**
 * Send a ticket back to the colony queue (`#1347`).
 *
 * **The only route from `desk` to `colony`, and only a person may take it.**
 * `#1343` made the override one-directional on the way in — triage may write
 * `'desk'` and has no `'colony'` to write — and this is the other half: the way
 * back exists, costs one click, and sits behind a maintainer session rather than
 * on any tool.
 *
 * It writes `open` as well as the route, which is what puts the ticket in front
 * of `openTickets` again. One promoted while `acknowledged` would sit on the
 * colony route being read by nothing.
 *
 * **The resolution is left exactly as it was.** If a maintainer acknowledged it
 * before deciding it was a defect after all, that sentence has already been read
 * by the citizen, and erasing it would unsay something already said.
 */
export async function promoteToColony(db: Database, ticketId: SupportTicketId): Promise<boolean> {
  const [row] = await db
    .update(supportTickets)
    .set({ route: 'colony', status: 'open', updatedAt: new Date().toISOString() })
    .where(and(eq(supportTickets.id, ticketId), eq(supportTickets.route, 'desk')))
    .returning({ id: supportTickets.id })

  return row !== undefined
}

/** How much the desk owes, and how long the oldest of it has waited. */
export interface DeskDepth {
  readonly unanswered: number
  /** When the oldest unanswered ticket was opened, or `null` if there are none. */
  readonly oldestOpenedAt: Timestamp | null
}

/**
 * The count `/backend` carries (`#1347`).
 *
 * **Without it the desk is a page somebody has to remember to open**, and a
 * queue nobody is reminded of is a queue that grows. The age of the oldest is
 * beside the count because the count alone cannot tell *four arrived this
 * morning* from *four have been waiting a fortnight*, and only one of those is a
 * defect.
 *
 * One query rather than two, so the number and the age cannot disagree about
 * which moment they describe.
 */
export async function deskDepth(db: Database): Promise<DeskDepth> {
  const [row] = await db
    .select({ unanswered: count(), oldest: min(supportTickets.createdAt) })
    .from(supportTickets)
    .where(
      and(
        eq(supportTickets.route, 'desk'),
        inArray(supportTickets.status, ['open', 'acknowledged']),
      ),
    )

  const oldest = row?.oldest ?? null

  return {
    unanswered: row?.unanswered ?? 0,
    oldestOpenedAt: oldest === null ? null : toTimestamp(oldest),
  }
}
