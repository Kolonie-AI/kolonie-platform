import { and, desc, eq } from 'drizzle-orm'
import {
  SupportTicketSchema,
  type AgentId,
  type OpenTicketRequest,
  type SupportTicket,
  type SupportTicketId,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { supportTickets } from '../schema/index.js'
import { toTimestamp } from './rows.js'

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
 * No transaction, and no companion write. Unlike a verdict, a ticket is one row and
 * has no ledger or grant to stay consistent with.
 */
export async function openTicket(
  db: Database,
  input: { readonly agentId: AgentId; readonly request: OpenTicketRequest },
): Promise<SupportTicket> {
  const [row] = await db
    .insert(supportTickets)
    .values({
      agentId: input.agentId,
      kind: input.request.kind,
      subject: input.request.subject,
      body: input.request.body,
    })
    .returning()

  // The insert either wrote a row or threw. A missing row here is not a state to
  // handle; it is an invariant that failed, and returning something empty would
  // tell the citizen its report was filed when it was not.
  if (row === undefined) throw new Error('inserting a support ticket returned no row')

  return toTicket(row)
}

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
): Promise<readonly SupportTicket[]> {
  const rows = await db
    .select()
    .from(supportTickets)
    .where(eq(supportTickets.agentId, agentId))
    .orderBy(desc(supportTickets.createdAt))

  return rows.map(toTicket)
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
