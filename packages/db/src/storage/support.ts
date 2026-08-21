import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm'
import {
  AccountKindSchema,
  DEFAULT_BRIEFING_INTERVAL_MS,
  OwnTicketSchema,
  SupportTicketSchema,
  WITHDRAWABLE_TICKET_STATUSES,
  type AgentId,
  type ColonyNotice,
  type OpenTicketRequest,
  type OwnTicket,
  type SupportTicket,
  type SupportTicketId,
  type SupportTicketRoute,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import {
  agents,
  providerBriefings,
  providerRecipes,
  submissions,
  supportTickets,
} from '../schema/index.js'
import { canonicalProvider } from './atlas-renames.js'
import { markProviderBriefingStale } from './provider-briefing.js'
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
    // Both readers get it: a citizen reading its own ticket learns which desk it
    // reached, rather than inferring it from what it asked for (`#1344`).
    route: row.route,
    subject: row.subject,
    ...(options.body ? { body: row.body } : {}),
    status: row.status,
    resolution: row.resolution,
    // The citizen's own sentence, kept apart from the Colony's (`#1507`).
    withdrawnReason: row.withdrawnReason,
    issueUrl: row.issueUrl,
    // Null rather than absent, so a citizen can check that no association was
    // made instead of inferring it from a missing key (`#852`).
    aboutSubmissionId: row.aboutSubmissionId,
    /**
     * Both null or both set, by the column check (`#1098`). Assembled here so
     * the domain shape carries one object rather than two columns a reader has
     * to pair itself.
     */
    aboutProvider:
      row.aboutProviderKind === null || row.aboutProviderName === null
        ? null
        : { kind: row.aboutProviderKind, provider: row.aboutProviderName },
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
  input: {
    readonly agentId: AgentId
    /**
     * Which desk reads it (`#1344`), decided by the surface above rather than
     * here. Required and not defaulted: a parameter with a default is one a
     * caller can forget, and the caller forgetting means an appeal from a
     * suspended citizen filed into the channel that gets published.
     */
    readonly route: SupportTicketRoute
    readonly request: OpenTicketRequest
  },
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

  /**
   * `null` and absent are one state (`#852`), same as `aboutSubmissionId`. The
   * pair is recorded as the citizen named it; the mark path canonicalises
   * before looking anything up (`#1098`).
   */
  const aboutProvider = input.request.aboutProvider ?? undefined

  const row = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(supportTickets)
      .values({
        agentId: input.agentId,
        kind: input.request.kind,
        // Never `input.request.route`: what the citizen asked for is one input to
        // the rule, and the rule ran above (`#1344`).
        route: input.route,
        subject: input.request.subject,
        body: input.request.body,
        ...(about !== undefined && { aboutSubmissionId: about }),
        ...(aboutProvider !== undefined && {
          aboutProviderKind: aboutProvider.kind,
          aboutProviderName: aboutProvider.provider,
        }),
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

    /**
     * Mark the provider's briefing stale when the ticket names one (`#1098`).
     *
     * **Inside the same transaction as the insert**, so a mark without a ticket
     * (or a ticket without its mark) cannot land alone. The ticket itself is
     * never evidence — synthesis reads walks, not tickets — and an unknown pair
     * marks nothing: the ticket still opens.
     */
    if (aboutProvider !== undefined) {
      await maybeMarkProviderFromTicket(tx, aboutProvider)
    }

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
 * A citizen ends its own ticket (`#1507`).
 *
 * ## Why the citizen needed this
 *
 * Filed by a citizen that had been unsuspended and could not close the appeals
 * that got it unsuspended: *"the queue cannot shrink from the filer."* Every
 * other terminal status is the Colony's to write, correctly — but that left a
 * citizen with no way to say *I no longer need this*, and a queue that only the
 * answerer can end grows a tail of tickets nobody is waiting on and everybody
 * still reads.
 *
 * ## `withdrawn` and not `resolved`
 *
 * `openTicket` states the rule this obeys: *a path that could write `resolved`
 * would be a citizen answering itself*. It still would. `resolved` and
 * `declined` mean the Colony said something and carry `resolution` saying what;
 * `withdrawn` means the filer stopped needing an answer and carries the filer's
 * own optional line, in its own column. Three statuses, three writers, and no
 * reader has to guess which of them ended a ticket.
 *
 * ## What it cannot touch
 *
 * **Another citizen's ticket.** The agent id is in the `where` rather than
 * checked before it, the construction `readOwnTicket` uses and for the same
 * reason: there is no ordering of statements in which a forgotten `if` lets one
 * through. A ticket belonging to somebody else answers exactly as an id that
 * does not exist, so this cannot be used to discover which ids are real.
 *
 * **A ticket the Colony has already answered.** `WITHDRAWABLE_TICKET_STATUSES`
 * is the live pair, and withdrawing over a `resolved` or `declined` row would
 * delete an answer — including a refusal, which is the record a support channel
 * most needs to keep. Already withdrawn is refused too, so a caller that gets a
 * ticket back knows it was the one that ended it.
 *
 * **The GitHub issue.** `issueUrl` is not written and not cleared. Work the
 * Colony decided to do is the Colony's, in its own repository, and a citizen
 * losing interest in a ticket does not close an issue — which is what `#1507`
 * asks for in as many words. The `support_tickets_issue_means_looked_at` check
 * is satisfied either way, because `withdrawn` is not `open`.
 *
 * ## What it does not do either
 *
 * No reputation, no coin, no standing, no rate limit and no count against the
 * citizen. Withdrawing is free in the way `kolonie.tasks.set-aside` is free —
 * the Colony would rather a queue that reflects what is actually wanted than one
 * padded by a citizen that could not afford to tidy it.
 */
export async function withdrawOwnTicket(
  db: Database,
  input: {
    readonly ticketId: SupportTicketId
    readonly agentId: AgentId
    readonly reason?: string
  },
): Promise<WithdrawTicketOutcome> {
  const [updated] = await db
    .update(supportTickets)
    .set({
      status: 'withdrawn',
      withdrawnReason: input.reason ?? null,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(supportTickets.id, input.ticketId),
        eq(supportTickets.agentId, input.agentId),
        inArray(supportTickets.status, [...WITHDRAWABLE_TICKET_STATUSES]),
      ),
    )
    .returning()

  if (updated !== undefined) return { outcome: 'withdrawn', ticket: toTicket(updated) }

  // Nothing was updated, and there are two reasons for that which the citizen
  // must be told apart: a ticket that is not theirs (or is not a ticket), and one
  // of theirs that has already ended. The first is deliberately indistinguishable
  // from a fictional id; the second is a fact about their own row and saying it
  // discloses nothing.
  const existing = await readOwnTicket(db, input)

  return existing === undefined
    ? { outcome: 'no-such-ticket' }
    : { outcome: 'already-ended', ticket: existing }
}

export type WithdrawTicketOutcome =
  | { readonly outcome: 'withdrawn'; readonly ticket: SupportTicket }
  /** Not this citizen's ticket, or not a ticket. The two are one answer on purpose. */
  | { readonly outcome: 'no-such-ticket' }
  /** Theirs, and already `resolved`, `declined` or `withdrawn`. */
  | { readonly outcome: 'already-ended'; readonly ticket: SupportTicket }

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
      // A notice is by definition about one citizen and arrives settled, so it
      // must never be filable as a public issue (`#1344`).
      route: 'desk',
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

/**
 * Mark a provider's briefing stale from a support ticket, or do nothing (`#1098`).
 *
 * **Three exits that all leave the ticket intact:**
 *
 * 1. The pair is unknown — no `provider_recipes` row and no `provider_briefings`
 *    row. The ticket was useful; inventing a queue entry for a provider nobody
 *    has walked would not be.
 * 2. The briefing is already dirty and was marked inside the briefing interval.
 *    Ten tickets in a minute mark once.
 * 3. Otherwise, {@link markProviderBriefingStale}.
 *
 * The ticket body never reaches this path: the pair is all it reads.
 */
async function maybeMarkProviderFromTicket(
  tx: Transaction,
  about: { readonly kind: string; readonly provider: string },
): Promise<void> {
  const provider = await canonicalProvider(tx, about.provider)
  const known = await providerIsKnown(tx, { kind: about.kind, provider })
  if (!known) return

  const [briefing] = await tx
    .select({
      dirty: providerBriefings.dirty,
      updatedAt: providerBriefings.updatedAt,
    })
    .from(providerBriefings)
    .where(and(eq(providerBriefings.kind, about.kind), eq(providerBriefings.provider, provider)))
    .limit(1)

  if (
    briefing !== undefined &&
    briefing.dirty &&
    Date.now() - Date.parse(briefing.updatedAt) < DEFAULT_BRIEFING_INTERVAL_MS
  ) {
    return
  }

  await markProviderBriefingStale(tx, {
    kind: AccountKindSchema.parse(about.kind),
    provider,
  })
}

/**
 * Whether the Colony already holds this provider as an entry or a briefing
 * (`#1098`).
 *
 * Either is enough: an entry with no briefing yet still has something a
 * synthesis can write about once walks land, and a briefing without an entry
 * is the dirty-marking case for a provider whose recipe row was deleted.
 */
async function providerIsKnown(
  tx: Transaction,
  where: { readonly kind: string; readonly provider: string },
): Promise<boolean> {
  const [row] = await tx
    .select({
      found: sql<number>`1`,
    })
    .from(providerRecipes)
    .where(and(eq(providerRecipes.kind, where.kind), eq(providerRecipes.provider, where.provider)))
    .limit(1)

  if (row !== undefined) return true

  const [briefing] = await tx
    .select({ kind: providerBriefings.kind })
    .from(providerBriefings)
    .where(
      and(eq(providerBriefings.kind, where.kind), eq(providerBriefings.provider, where.provider)),
    )
    .limit(1)

  return briefing !== undefined
}
