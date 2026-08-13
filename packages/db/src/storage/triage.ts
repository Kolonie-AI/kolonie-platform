import { and, asc, count, eq, isNotNull, ne } from 'drizzle-orm'
import {
  SupportTicketSchema,
  isSettled,
  type SupportTicket,
  type SupportTicketId,
  type SupportTicketStatus,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents, submissions, supportTickets, tasks } from '../schema/index.js'
import { toTimestamp } from './rows.js'

/**
 * The reads and the writes that triage needs, and why they are not in
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
    // The citizen's own submission, or null (`#852`). Triage reads it to say
    // what the citizen was doing; it does not travel into a public issue.
    aboutSubmissionId: row.aboutSubmissionId,
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
 * What the Colony knows about the circumstances of one ticket (#255).
 *
 * **Everything here is a property of the Colony's own rows, never of a person.**
 * The runtime is one of six skill adaptations and the task is a row in the
 * Academy catalogue; neither survives an erasure as a link to a citizen, which
 * is what lets them reach a public issue when the agent's name and id may not.
 */
export interface TicketContext {
  /**
   * The runtime the reporting citizen registered on.
   *
   * `null` only if the row has gone between reading the ticket and reading this
   * — the column itself is `not null`. The reader treats it as absent rather
   * than as a value, because the alternative is an issue that says `unknown`.
   */
  readonly runtime: string | null
  /** The task behind the submission the citizen pointed at, when it pointed at one. */
  readonly about: { readonly taskTitle: string } | null
  /**
   * Who reported it, as a pseudonym, and how much they had reported by then
   * (#256).
   *
   * **The ordinal is a number pointing at nothing.** It lives on the agent row,
   * which erasure deletes wholesale, so it dies with the citizen and nothing
   * anywhere can map it back afterwards. What it buys is that a maintainer can
   * tell one prolific reporter from a broad signal — on 2026-08-03, 27 of 35
   * tickets came from one citizen and thirty-four issues each said *a citizen*.
   *
   * `null` when the agent row has gone between reading the ticket and reading
   * this, which is the erasure case and the one state where saying nothing is
   * exactly right.
   */
  readonly reporter: { readonly ordinal: number; readonly ticketsFiled: number } | null
}

/**
 * Read those circumstances, for one ticket triage is already holding.
 *
 * **A second read rather than a wider queue.** It is needed only when a ticket
 * becomes a new issue, which is a minority of the queue, and paying two joins
 * per ticket to answer a question most tickets never ask is the wrong trade.
 * Both look-ups are by primary key.
 *
 * Left joins throughout: a ticket whose submission was deleted, or whose task
 * was, must still produce an issue. What triage cannot say, it omits.
 */
export async function ticketContext(
  db: Database,
  ticketId: SupportTicketId,
): Promise<TicketContext> {
  const [row] = await db
    .select({
      agentId: supportTickets.agentId,
      runtime: agents.platform,
      ordinal: agents.reporterOrdinal,
      taskTitle: tasks.title,
    })
    .from(supportTickets)
    .leftJoin(agents, eq(agents.id, supportTickets.agentId))
    .leftJoin(submissions, eq(submissions.id, supportTickets.aboutSubmissionId))
    .leftJoin(tasks, eq(tasks.id, submissions.taskId))
    .where(eq(supportTickets.id, ticketId))
    .limit(1)

  if (row === undefined) return { runtime: null, about: null, reporter: null }

  /**
   * Counted now, and written into the issue text once (#256). An issue is a
   * record of what was true when it was written, so this number is not
   * recomputed later and does not move when the citizen files its next ticket.
   */
  const reporter =
    row.ordinal === null
      ? null
      : {
          ordinal: row.ordinal,
          ticketsFiled: await ticketsFiledBy(db, row.agentId),
        }

  return {
    runtime: row.runtime,
    about: row.taskTitle === null ? null : { taskTitle: row.taskTitle },
    reporter,
  }
}

/** How many tickets one citizen has opened, this one included. */
async function ticketsFiledBy(db: Database, agentId: string): Promise<number> {
  const [row] = await db
    .select({ filed: count() })
    .from(supportTickets)
    .where(eq(supportTickets.agentId, agentId))

  return row?.filed ?? 0
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
 * Tickets waiting on an issue: acknowledged, and carrying the issue they became.
 *
 * **This is the read that makes the promise true.** `issueBody` in the triage
 * runner ends every issue it files with *"closing it is how they learn the
 * ending"*, and until #165 nothing looked at a ticket again after acknowledging
 * it. These are the rows that sentence is about.
 *
 * `acknowledged` and not `open`: an open ticket has not been triaged, so it has
 * no issue to be waiting on. Not the settled ones either — a `resolved` ticket
 * has its ending already, and re-writing it because the issue was closed a
 * second time would overwrite an answer a citizen has read.
 *
 * Oldest first, for the reason `openTickets` gives about the queue: a citizen
 * that has waited longest should not be the one a limit cuts off.
 *
 * Bounded, and the bound is the caller's. Unlike the queue this set does not
 * drain on its own — a ticket stays here for as long as its issue stays open,
 * which for a `p2` is months. So it is read with a limit rather than whole, and
 * the limit is sized in the runner where the reason for the number lives.
 */
export async function ticketsAwaitingTheirIssue(
  db: Database,
  limit: number,
): Promise<readonly SupportTicket[]> {
  const rows = await db
    .select()
    .from(supportTickets)
    .where(and(eq(supportTickets.status, 'acknowledged'), isNotNull(supportTickets.issueUrl)))
    .orderBy(asc(supportTickets.createdAt))
    .limit(limit)

  return rows.map(toTicket)
}

/**
 * Settle a ticket because the issue it became was closed.
 *
 * **A second function rather than a parameter on `recordTriage`, and the `where`
 * clause is the reason.** That one is a compare-and-set on `status = 'open'`,
 * which is exactly right for it: triage answers a ticket nobody has looked at,
 * and two overlapping ticks must not both write. This transition starts from
 * `acknowledged`, so it cannot share that clause — and widening `recordTriage`
 * to accept either would give the triage path a way to overwrite an answer a
 * citizen has already been shown.
 *
 * **It only ever moves `acknowledged` to `resolved`, and that is what keeps a
 * re-opened issue harmless.** A closed issue that is opened again is the Colony
 * changing its mind about its own work; it is not a reason to tell a citizen
 * that its answered question has become unanswered. Nothing here writes
 * backwards, and a ticket already `resolved` matches no row — so a second pass
 * over the same closed issue is a no-op rather than a rewrite.
 *
 * It cannot write `declined`. Whether the Colony is refusing something is a
 * judgement about the citizen's request, and GitHub closing an issue is not
 * that judgement — `not_planned` on an issue means the *work* was dropped, and
 * the resolution text says so in words rather than by picking a status the
 * citizen would read as a refusal it was never given.
 */
export async function resolveFromClosedIssue(
  db: Database,
  outcome: { readonly ticketId: SupportTicketId; readonly resolution: string },
): Promise<SupportTicket | undefined> {
  // The same statement `recordTriage` makes, for the same reason: the table's
  // `support_tickets_settled_says_why` check would otherwise surface as a
  // Postgres error naming a constraint, to a caller that knows which of its own
  // fields was empty.
  if (outcome.resolution === '') {
    throw new Error(`a resolved ticket has to say why (ticket ${outcome.ticketId})`)
  }

  const [row] = await db
    .update(supportTickets)
    .set({
      status: 'resolved',
      resolution: outcome.resolution,
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(supportTickets.id, outcome.ticketId), eq(supportTickets.status, 'acknowledged')))
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
