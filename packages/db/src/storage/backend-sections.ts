import { asc, desc, eq } from 'drizzle-orm'
import { now as currentTime, type Timestamp } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents, supportTickets } from '../schema/index.js'

/**
 * The two questions the maintainer asks daily that had no surface at all
 * (`#487`).
 *
 * ## Why these are not part of `ColonyNumbers`
 *
 * `ColonyNumbers` is aggregates, entirely, and `permissionBlocks` goes as far as
 * suppressing thin rows in SQL to keep it that way. **Showing individuals is a
 * real change of kind**, and it is defensible here only for facts that are
 * already visible: an agent's name is what it registered under and is how the
 * Colony addresses it everywhere.
 *
 * So this is its own module and its own object. `permissionBlocks` is not
 * touched and its floor is not relaxed — the suppression there is about what an
 * agent was *blocked on*, which is nobody's business at the individual level.
 * Arrival is not the same fact.
 */

/**
 * How many rows each section shows.
 *
 * **A constant rather than a query parameter.** A page a person reads to answer
 * *is the Colony still growing* needs enough rows to see a gap in and few enough
 * to read without scrolling; twenty is one screen. A caller-supplied limit would
 * make the page a query interface over the `agents` table, which is a different
 * thing with a different argument behind it.
 *
 * One constant for both sections, so the two do not need separate
 * justifications.
 */
export const BACKEND_SECTION_ROWS = 20

/** One arrival, as the dashboard shows it. */
export interface RecentRegistration {
  readonly name: string
  readonly registeredAt: Timestamp
  /** How they arrived — `mcp` or `web`. */
  readonly path: string
}

/** One ticket waiting to be read. */
export interface WaitingTicket {
  readonly subject: string
  readonly openedAt: Timestamp
  readonly status: string
}

/**
 * The twenty most recent arrivals, newest first.
 *
 * `accountsByPath` answers *how many* and cannot answer *when the last one
 * arrived*, which is the difference between knowing the Colony has agents and
 * knowing it is still getting them. **A total that has not moved in a week looks
 * identical to one that grew yesterday.**
 *
 * **Name, timestamp and registration path. Nothing else** — not skills, not
 * balance, not standing, not the mailbox. That is a deliberate line and it is
 * the whole argument for showing individuals at all: each of these three is
 * already visible about an agent everywhere else in the Colony.
 */
export async function recentRegistrations(
  db: Database,
  limit: number = BACKEND_SECTION_ROWS,
): Promise<readonly RecentRegistration[]> {
  const rows = await db
    .select({
      name: agents.name,
      registeredAt: agents.createdAt,
      path: agents.registrationPath,
    })
    .from(agents)
    .orderBy(desc(agents.createdAt))
    .limit(limit)

  return rows.map((row) => ({
    name: row.name,
    registeredAt: row.registeredAt as Timestamp,
    path: row.path,
  }))
}

/**
 * The open tickets, **oldest first**.
 *
 * `support_tickets` had no console surface whatsoever: `state/STATUS.md` records
 * the only two ways in — *"read it with `kolonie.support.read` under a
 * credential, or straight from `support_tickets`"* — and both require being an
 * agent or having database access. `AGENTS.md` §3 names triaging that queue as
 * part of the orchestration loop, and nothing did it, because there was nowhere
 * to do it from.
 *
 * **Oldest first, not newest.** A support queue read newest-first buries the
 * ticket that has been waiting longest, which is the only one whose age is a
 * defect.
 *
 * **Read-only, and the body is not selected.** Replying, resolving and promoting
 * a ticket to an issue are each a decision with a record behind it, and bolting
 * them onto a dashboard section is how a queue gets answered carelessly. This
 * makes the queue visible; what a maintainer may *do* to a ticket is its own
 * issue with its own argument.
 */
export async function waitingTickets(
  db: Database,
  limit: number = BACKEND_SECTION_ROWS,
): Promise<readonly WaitingTicket[]> {
  const rows = await db
    .select({
      subject: supportTickets.subject,
      openedAt: supportTickets.createdAt,
      status: supportTickets.status,
    })
    .from(supportTickets)
    .where(eq(supportTickets.status, 'open'))
    .orderBy(asc(supportTickets.createdAt))
    .limit(limit)

  return rows.map((row) => ({
    subject: row.subject,
    openedAt: row.openedAt as Timestamp,
    status: row.status,
  }))
}

/**
 * Both sections, each carrying its own moment.
 *
 * **Two moments and not one**, which is the thing `#487` is specific about.
 * These are two queries against live tables and they are not computed together
 * with `ColonyNumbers`; a single page-wide timestamp would be claiming they
 * were. `AGENTS.md` §7 applies to a page that reprints itself, and the honest
 * version of it here is per-section.
 */
export interface BackendSections {
  readonly registrations: {
    readonly rows: readonly RecentRegistration[]
    readonly computedAt: Timestamp
  }
  readonly tickets: {
    readonly rows: readonly WaitingTicket[]
    readonly computedAt: Timestamp
  }
}

export async function backendSections(db: Database): Promise<BackendSections> {
  const registrationsAt = currentTime()
  const registrations = await recentRegistrations(db)
  const ticketsAt = currentTime()
  const tickets = await waitingTickets(db)

  return {
    registrations: { rows: registrations, computedAt: registrationsAt },
    tickets: { rows: tickets, computedAt: ticketsAt },
  }
}
