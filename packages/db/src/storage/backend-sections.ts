import { asc, eq } from 'drizzle-orm'
import { now as currentTime, type Timestamp } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { supportTickets } from '../schema/index.js'

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

/**
 * **`RecentRegistration` and `recentRegistrations` are gone — `#607`.**
 *
 * They answered with a name, a time and one of two words, and nothing on that
 * row could distinguish a citizen that is going to do something from forty
 * accounts opened by one script in an afternoon. `recentArrivals` in
 * `arrivals.ts` replaces them on both representations of `/backend`, so the page
 * and its JSON cannot disagree about who arrived.
 */

/** One ticket waiting to be read. */
export interface WaitingTicket {
  readonly subject: string
  readonly openedAt: Timestamp
  readonly status: string
  /**
   * The provider the citizen named, or `null` (`#1098`).
   *
   * Shown on `/backend/tickets` so a maintainer reading the queue can open the
   * Atlas entry beside the ticket. Never inferred — only what the citizen sent.
   */
  readonly aboutProvider: { readonly kind: string; readonly provider: string } | null
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
      aboutProviderKind: supportTickets.aboutProviderKind,
      aboutProviderName: supportTickets.aboutProviderName,
    })
    .from(supportTickets)
    .where(eq(supportTickets.status, 'open'))
    .orderBy(asc(supportTickets.createdAt))
    .limit(limit)

  return rows.map((row) => ({
    subject: row.subject,
    openedAt: row.openedAt as Timestamp,
    status: row.status,
    aboutProvider:
      row.aboutProviderKind === null || row.aboutProviderName === null
        ? null
        : { kind: row.aboutProviderKind, provider: row.aboutProviderName },
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
  readonly tickets: {
    readonly rows: readonly WaitingTicket[]
    readonly computedAt: Timestamp
  }
}

export async function backendSections(db: Database): Promise<BackendSections> {
  const ticketsAt = currentTime()
  const tickets = await waitingTickets(db)

  return { tickets: { rows: tickets, computedAt: ticketsAt } }
}
