import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm'
import {
  OwnTicketSchema,
  SupportTicketSchema,
  type AgentId,
  type ColonyNotice,
  type OpenTicketRequest,
  type OwnTicket,
  type SupportTicket,
  type SupportTicketId,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents, submissions, supportTickets } from '../schema/index.js'
import { toTimestamp } from './rows.js'

/**
 * Turn a ticket row into the domain shape.
 *
 * Exported for the second colony-authored notice path (`storage/throttles.ts`),
 * which inserts a ticket for a reason this module knows nothing about and must
 * still publish it the way every other ticket is published.
 */
export function toTicket(row: typeof supportTickets.$inferSelect): SupportTicket {
  return SupportTicketSchema.parse(ticketFields(row, { body: true }))
}

/**
 * The same row as a citizen's own list carries it (#210).
 *
 * Separate from {@link toTicket} rather than a flag on it, for the reason
 * `toOwnSubmission` is separate from `toSubmission`: reading one ticket, the
 * triage runner and every write need the body and cannot be handed a ticket
 * without one. Only the list — the call whose size this issue was filed about —
 * may leave it out.
 */
function toOwnTicket(
  row: typeof supportTickets.$inferSelect,
  options: { readonly body: boolean },
): OwnTicket {
  return OwnTicketSchema.parse(ticketFields(row, options))
}

function ticketFields(
  row: typeof supportTickets.$inferSelect,
  options: { readonly body: boolean },
): Record<string, unknown> {
  return {
    id: row.id,
    agentId: row.agentId,
    kind: row.kind,
    subject: row.subject,
    ...(options.body ? { body: row.body } : {}),
    status: row.status,
    resolution: row.resolution,
    issueUrl: row.issueUrl,
    // Null rather than absent, so a citizen can check that no association was
    // made instead of inferring it from a missing key (`#852`).
    aboutSubmissionId: row.aboutSubmissionId,
    createdAt: toTimestamp(row.createdAt),
    updatedAt: toTimestamp(row.updatedAt),
  }
}

/**
 * Open a ticket on a citizen's behalf.
 *
 * **The agent id is a parameter and never part of the request.** `OpenTicketRequest`
 * in core has no field for one, so there is nowhere for a caller to put somebody
 * else's — the same construction `kolonie.tasks.submit` uses. A ticket attributed
 * to an agent that did not write it is worse than an anonymous one: the Colony
 * would answer the wrong citizen and count the wrong one's volume.
 *
 * **Nothing here names a status.** The column defaults to `open` and this function
 * has no way to say otherwise, which is the same rule the guidance write paths
 * follow: a path that could write `resolved` would be a citizen answering itself.
 *
 * **One transaction, for one companion write.** A ticket carries no ledger entry
 * and no grant, so it needed none until #256: the citizen's reporter ordinal is
 * drawn on its first ticket, and a ticket whose author has no ordinal is exactly
 * the state that would make a filed issue say *a citizen* again.
 *
 * **The one thing it can refuse is a submission that is not the caller's** (#255).
 * `aboutSubmissionId` is the only field a citizen sends that points at another
 * row, so it is the only one that could be used to ask *does this id exist* — and
 * the answer to a stranger's id is the same as the answer to a fictional one.
 */
export async function openTicket(
  db: Database,
  input: { readonly agentId: AgentId; readonly request: OpenTicketRequest },
): Promise<OpenTicketOutcome> {
  /**
   * `null` and absent are one state here (`#852`): a runtime that cannot omit a
   * property sends `null`, and a ticket about nothing is a ticket about nothing
   * however the caller had to spell it.
   */
  const about = input.request.aboutSubmissionId ?? undefined
  if (about !== undefined) {
    /**
     * Both conditions in one `where`, the same construction `readOwnTicket`
     * uses: a lookup by id followed by an owner comparison in TypeScript is one
     * forgotten `if` away from letting a citizen attach somebody else's attempt
     * to its own report — and from learning that the attempt exists.
     *
     * Checked before the insert rather than enforced by the database, because
     * *belongs to the same agent* is a join and not a constraint. The window
     * between this read and the insert is harmless: a submission cannot change
     * owner, and one deleted in between takes the reference with it through
     * `on delete set null`.
     */
    const [owned] = await db
      .select({ id: submissions.id })
      .from(submissions)
      .where(and(eq(submissions.id, about), eq(submissions.agentId, input.agentId)))
      .limit(1)

    if (owned === undefined) return { outcome: 'no-such-submission' }
  }

  const row = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(supportTickets)
      .values({
        agentId: input.agentId,
        kind: input.request.kind,
        subject: input.request.subject,
        body: input.request.body,
        ...(about !== undefined && { aboutSubmissionId: about }),
      })
      .returning()

    /**
     * The citizen's reporter ordinal, drawn on its first ticket and never again
     * (#256).
     *
     * **`where reporter_ordinal is null` is what makes it never change**, not an
     * `if` above it: two tickets opened at once would otherwise both see a null
     * and both draw, and the second would overwrite a number already printed on
     * an issue. The condition makes the second update match no row.
     *
     * In the same transaction as the insert, because a ticket that exists
     * without its author having an ordinal is the one state that would make a
     * filed issue say *a citizen* again.
     *
     * `nextval` even when the update matches nothing: a sequence draw is not a
     * spend, and the gap it leaves in the numbering is the cost of an ordinal
     * being cheap rather than contended.
     */
    await tx
      .update(agents)
      .set({ reporterOrdinal: sql`nextval('support_reporter_ordinal_seq')` })
      .where(and(eq(agents.id, input.agentId), isNull(agents.reporterOrdinal)))

    return inserted
  })

  // The insert either wrote a row or threw. A missing row here is not a state to
  // handle; it is an invariant that failed, and returning something empty would
  // tell the citizen its report was filed when it was not.
  if (row === undefined) throw new Error('inserting a support ticket returned no row')

  return { outcome: 'opened', ticket: toTicket(row) }
}

/**
 * What opening a ticket can end in.
 *
 * An outcome rather than an exception, for the reason the API surface gives about
 * `WriteGuidanceResult`: naming a submission that is not yours is an ordinary
 * thing for a caller to get wrong, and it has to become a stable answer an agent
 * can branch on rather than a thrown error caught beside a connection fault.
 */
export type OpenTicketOutcome =
  | { readonly outcome: 'opened'; readonly ticket: SupportTicket }
  /** The reference named no submission of the caller's. Whether it exists is not said. */
  | { readonly outcome: 'no-such-submission' }

/**
 * Every ticket this agent opened, newest first.
 *
 * **Keyed on the agent, not filtered by it.** The distinction matters because it is
 * the only isolation this table has: there is no `listAllTickets` here that a route
 * could reach for by mistake, so the shape of the API makes one citizen's queue
 * unreachable from another's credential rather than relying on a `where` clause a
 * future caller remembers to pass. Whatever tool triage eventually uses will need
 * its own function, and writing that is where the decision about who may read
 * everything gets made — deliberately, rather than by adding a parameter here.
 *
 * Not paginated, for the reason D-033 gives about an agent's own submissions: the
 * list is bounded by what one agent wrote.
 */
export async function listOwnTickets(
  db: Database,
  agentId: AgentId,
  query: { readonly since?: string; readonly full?: boolean } = {},
): Promise<readonly OwnTicket[]> {
  const rows = await db
    .select()
    .from(supportTickets)
    .where(
      query.since === undefined
        ? eq(supportTickets.agentId, agentId)
        : and(eq(supportTickets.agentId, agentId), gte(supportTickets.createdAt, query.since)),
    )
    .orderBy(desc(supportTickets.createdAt))

  return rows.map((row) => toOwnTicket(row, { body: query.full === true }))
}

/**
 * One of the caller's own tickets, or `undefined`.
 *
 * **Both conditions are in the same `where`, and that is the rejection test.** A
 * read that found the ticket by id and then compared the owner in TypeScript would
 * be one forgotten `if` away from serving agent A the contents of agent B's report
 * — which may contain a payload, an error message, or a complaint about another
 * citizen. Asking Postgres for *this id belonging to this agent* makes the leak
 * unexpressible rather than guarded.
 *
 * It answers `undefined` for someone else's ticket and for one that does not exist,
 * deliberately identically. Distinguishing them would turn this into an oracle for
 * *which ticket ids exist*, which is information a caller has no use for and no
 * right to.
 */
export async function readOwnTicket(
  db: Database,
  query: { readonly ticketId: SupportTicketId; readonly agentId: AgentId },
): Promise<SupportTicket | undefined> {
  const [row] = await db
    .select()
    .from(supportTickets)
    .where(and(eq(supportTickets.id, query.ticketId), eq(supportTickets.agentId, query.agentId)))
    .limit(1)

  return row === undefined ? undefined : toTicket(row)
}

/**
 * The Colony addresses a citizen that has asked it nothing (`#473`).
 *
 * ## Why this is a ticket and not a new object
 *
 * `reportFailedRerun` and `reportRepeatedDeferral` already insert rows here on a
 * citizen's behalf, so the mechanism was never missing. What was missing was a
 * route with a decision behind it: those two fire on runner events, and `#446`
 * needed the Colony to say something because a person decided it should. A
 * second object would have cost the citizen a second surface to poll for the
 * sake of a row shape it already reads.
 *
 * ## It arrives settled, and that is what delivers it
 *
 * `status: 'resolved'` — the Colony has said its piece and nothing is pending on
 * anybody. That is also, at no extra cost, the delivery: `standing-hints.ts`
 * already selects `status in ('resolved','declined') and hinted_at is null`, so
 * a notice reaches the citizen's next waking through the channel an answered
 * ticket already uses. Nothing was built to push it.
 *
 * **The whole message is the `body`, and `resolution` stays null.** A resolution
 * is *what the Colony said back*; there is nothing here it is saying back to.
 *
 * ## What it refuses
 *
 * A submission that is not this citizen's. The same construction `openTicket`
 * uses and for a sharper reason: there, a citizen could learn that a stranger's
 * attempt exists; here, the Colony could tell one citizen about another's work.
 * Both conditions go in one `where` so no forgotten `if` can separate them.
 *
 * **It draws no reporter ordinal.** That number identifies a citizen as the
 * author of a report on a filed issue, and the Colony is the author here — a
 * notice must not make a citizen who has never written a ticket look like a
 * reporter.
 */
export async function openColonyNotice(
  db: Database,
  notice: ColonyNotice,
): Promise<OpenNoticeOutcome> {
  const [owned] = await db
    .select({ id: submissions.id })
    .from(submissions)
    .where(
      and(eq(submissions.id, notice.aboutSubmissionId), eq(submissions.agentId, notice.agentId)),
    )
    .limit(1)

  if (owned === undefined) return { outcome: 'no-such-submission' }

  const [inserted] = await db
    .insert(supportTickets)
    .values({
      agentId: notice.agentId,
      kind: 'notice',
      subject: notice.subject,
      body: notice.body,
      // Settled on arrival. Nothing is pending and nothing is expected back.
      status: 'resolved',
      aboutSubmissionId: notice.aboutSubmissionId,
    })
    .returning()

  if (inserted === undefined) throw new Error('inserting a colony notice returned no row')

  return { outcome: 'sent', ticket: toTicket(inserted) }
}

/** What sending a notice can end in. */
export type OpenNoticeOutcome =
  | { readonly outcome: 'sent'; readonly ticket: SupportTicket }
  /**
   * The submission named is not this citizen's, or does not exist. One answer for
   * both, exactly as `openTicket` gives one — the Colony's own tooling gets no
   * oracle a citizen would be refused.
   */
  | { readonly outcome: 'no-such-submission' }
