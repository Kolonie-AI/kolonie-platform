import { and, asc, eq, ne } from 'drizzle-orm'
import {
  SupportTicketSchema,
  isSettled,
  type SupportTicket,
  type SupportTicketId,
  type SupportTicketStatus,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { supportTickets } from '../schema/index.js'
import { toTimestamp } from './rows.js'

/**
 * The reads and the one write that triage needs, and why they are not in
 * `support.ts` (#105).
 *
 * `support.ts` says outright that it holds no `listAllTickets`, and gives the
 * reason: *"the shape of the API makes one citizen's queue unreachable from
 * another's credential rather than relying on a `where` clause a future caller
 * remembers to pass. Whatever tool triage eventually uses will need its own
 * function, and writing that is where the decision about who may read everything
 * gets made — deliberately, rather than by adding a parameter here."*
 *
 * This is that file, and this comment is that decision.
 *
 * **Who may read everything: a process, never a request.** Nothing in `apps/api`
 * imports this module. The triage runner holds a database handle directly, the
 * same way the verifier and moderation runners do, so there is no route, no
 * credential and no caller — and therefore no way for a citizen to reach any of
 * it by finding the right parameter. The isolation `support.ts` built is intact
 * because the thing that reads across citizens is not on the request path at all.
 *
 * That is also why these functions take no agent id. One that did would look like
 * a permission check and be none: the caller is a process with the whole database
 * in its hand.
 */

/** Turn a ticket row into the domain shape. */
function toTicket(row: typeof supportTickets.$inferSelect): SupportTicket {
  return SupportTicketSchema.parse({
    id: row.id,
    agentId: row.agentId,
    kind: row.kind,
    subject: row.subject,
    body: row.body,
    status: row.status,
    resolution: row.resolution,
    issueUrl: row.issueUrl,
    createdAt: toTimestamp(row.createdAt),
    updatedAt: toTimestamp(row.updatedAt),
  })
}

/**
 * The queue: tickets nobody has looked at, oldest first.
 *
 * **`open` only, and not `acknowledged`.** The two are both unsettled, and it
 * would be easy to read both — but `acknowledged` means the Colony has already
 * answered this one, and a triage loop that keeps picking those up re-answers
 * work it has done, every tick, forever. Oldest first because a queue that
 * serves the newest first starves the citizen who waited longest, and the
 * citizens who wait longest are the early ones reporting a broken front door.
 *
 * Served by `support_tickets_open_idx`, which the table already carries and whose
 * comment already names this read: *"the read triage makes: the queue, oldest
 * first, ignoring what is settled"*. It covers `open` and `acknowledged`, so it
 * is wider than this query — that costs nothing and leaves room for a sweep that
 * wants both.
 *
 * Limited, because a tick that reads ten thousand rows and then makes ten
 * thousand model calls is not a tick.
 */
export async function openTickets(db: Database, limit: number): Promise<readonly SupportTicket[]> {
  const rows = await db
    .select()
    .from(supportTickets)
    .where(eq(supportTickets.status, 'open'))
    .orderBy(asc(supportTickets.createdAt))
    .limit(limit)

  return rows.map(toTicket)
}

/**
 * Tickets triage has already answered, for the *have we seen this before* check.
 *
 * **The point is the ones that carry an issue.** A citizen reporting something a
 * previous citizen already reported should be pointed at the same issue rather
 * than at a second one — that is the consolidation this whole feature exists for,
 * and it needs the earlier ticket's `issueUrl` to do it.
 *
 * Unsettled and settled both, deliberately. A `resolved` ticket answering the
 * same question is the most useful match there is: the answer already exists and
 * can be repeated. Excluding it would make the Colony re-derive an answer it had
 * written down.
 *
 * Bounded rather than complete. The corpus is for similarity, not for audit, and
 * a runner that loads every ticket the Colony has ever received in order to
 * triage one is a runner that stops working at some size nobody chose.
 */
export async function triagedTickets(
  db: Database,
  limit: number,
): Promise<readonly SupportTicket[]> {
  const rows = await db
    .select()
    .from(supportTickets)
    .where(ne(supportTickets.status, 'open'))
    .orderBy(asc(supportTickets.createdAt))
    .limit(limit)

  return rows.map(toTicket)
}

/**
 * What triage may write, and it is deliberately narrower than the table.
 *
 * No `subject`, no `body`, no `kind`, no `agentId`: those are the citizen's, and
 * a triage process that could edit them could rewrite a report into something the
 * citizen did not say. The four fields here are the Colony's own answer.
 */
export interface TriageOutcome {
  readonly ticketId: SupportTicketId
  readonly status: Exclude<SupportTicketStatus, 'open'>
  /**
   * What the Colony said back. Required for a settled status by the table's
   * `support_tickets_settled_says_why` check; optional for `acknowledged`,
   * because *"we are looking at it"* is a complete message.
   */
  readonly resolution?: string | null
  /** The issue this became or was matched to, if any. */
  readonly issueUrl?: string | null
}

/**
 * Record what triage decided.
 *
 * **It cannot write `open`**, and the type is what stops it: `open` means *nobody
 * has looked yet*, and a triage run that concluded is a look. Allowing it would
 * let a tick that reached no conclusion put a ticket back in the queue in a way
 * indistinguishable from never having read it — and `openTickets` above would
 * then serve it again forever.
 *
 * **The two conditions in the `where` are the idempotency, not a guard.** The
 * runner is at-least-once by construction: a crash between the model's answer and
 * this write leaves the row to be picked up next tick. Both matter and they
 * matter differently:
 *
 *  - `id` alone would let two overlapping ticks write two different answers to
 *    one ticket, and the second would silently overwrite the first — including
 *    overwriting an `issueUrl` with a different issue.
 *  - `status = 'open'` makes this a compare-and-set: the second writer finds
 *    nothing to update and says so by returning `undefined`, which the caller can
 *    tell apart from a ticket that does not exist only by having read it a moment
 *    ago. That is the correct amount of information — both mean *do not act*.
 *
 * `updatedAt` is set here rather than left to the column default, which only
 * fires on insert. A queue whose rows all claim to have been updated when they
 * were created cannot be read for how long triage is taking.
 */
export async function recordTriage(
  db: Database,
  outcome: TriageOutcome,
): Promise<SupportTicket | undefined> {
  // Stated here as well as in the database, because the constraint fires as an
  // error from Postgres with a message about a check name, and the caller that
  // gets it back deserves to know which of its own fields was empty.
  if (isSettled(outcome.status) && (outcome.resolution ?? '') === '') {
    throw new Error(`a ${outcome.status} ticket has to say why (ticket ${outcome.ticketId})`)
  }

  const [row] = await db
    .update(supportTickets)
    .set({
      status: outcome.status,
      ...(outcome.resolution !== undefined && { resolution: outcome.resolution }),
      ...(outcome.issueUrl !== undefined && { issueUrl: outcome.issueUrl }),
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(supportTickets.id, outcome.ticketId), eq(supportTickets.status, 'open')))
    .returning()

  return row === undefined ? undefined : toTicket(row)
}

/**
 * How many tickets sit unanswered, and how old the oldest is.
 *
 * Not used by the loop — it is what a health endpoint reports, so that *the
 * triage runner is alive* and *the queue is being emptied* are two different
 * questions with two different answers. A loop that ticks happily while the
 * backlog grows is the failure this feature exists to prevent, and it is
 * invisible to a liveness check.
 */
export async function queueDepth(
  db: Database,
): Promise<{ readonly open: number; readonly oldestOpenAt: string | null }> {
  const rows = await db
    .select({ createdAt: supportTickets.createdAt })
    .from(supportTickets)
    .where(eq(supportTickets.status, 'open'))
    .orderBy(asc(supportTickets.createdAt))

  const first = rows[0]
  return {
    open: rows.length,
    oldestOpenAt: first === undefined ? null : toTimestamp(first.createdAt),
  }
}
