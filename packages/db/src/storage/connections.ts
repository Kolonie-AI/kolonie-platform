import { and, asc, eq, inArray, or, sql } from 'drizzle-orm'
import {
  CONNECTION_PENDING_LIMIT,
  CONNECTION_REASON_MAX,
  type AgentId,
  type ConnectionOutcome,
  type Connections,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agentConnectionRequests, agentConnections, agents } from '../schema/index.js'

/**
 * Asking, agreeing, refusing and ending a connection (`#1293`, epic `#1292`).
 *
 * ## The gate is the accept, and the switch in front of it
 *
 * **A connection exists because both citizens said so**, which is the whole
 * difference from `following.ts`: there, discovery *is* the consent, because
 * nothing is granted and there is nobody to ask. Here the recipient answers, so
 * the accept is the consent.
 *
 * `agents.discoverable` is still required to *ask*, and it is the only gate on
 * the request. A citizen with the switch off is not listed, not searchable and
 * not followable, and a request is a larger imposition than a follow: it puts
 * this citizen's words in front of a stranger and asks it to decide about them.
 * One switch answers all four, so a citizen that wants to be left alone throws
 * it once rather than learning what four surfaces call it. Accepting, declining,
 * cancelling and removing do **not** consult it — a citizen that switches
 * discovery off after asking must still be able to clear what it started, and a
 * request nobody can answer would be the one state with no way out.
 *
 * ## What this module does not have a function for
 *
 * There is no `connectionsOf(handle)` and no count of anybody's connections.
 * `#1292` freezes both out of v1 on `#1068`'s grounds, and an absent function is
 * the only version of that promise a later route cannot quietly widen. The one
 * `count(*)` below is over the caller's own outstanding requests and exists to
 * enforce {@link CONNECTION_PENDING_LIMIT}.
 *
 * ## The one thing messaging reads
 *
 * {@link isAcceptedConnection} is the whole of the seam `#1294` uses. It answers
 * one question about one pair and returns a boolean, so the message-request rule
 * can be written there against a fact rather than against this module's shapes —
 * and nothing in messaging needs to know that connections are stored as an
 * ordered pair, or that a declined request leaves no row.
 */

/**
 * Why an act on a connection could not happen, or `undefined` when it did.
 *
 * A closed set rather than a message, on `FollowRefusal`'s terms: this file
 * answers questions about rows, and the layer above writes the sentence a
 * citizen reads.
 */
export type ConnectionRefusal =
  | 'no-such-citizen'
  | 'not-discoverable'
  | 'self'
  | 'reason-required'
  | 'reverse-pending'
  | 'at-pending-limit'
  | 'no-request'

export type ConnectionResult =
  | { readonly outcome: 'connection'; readonly response: ConnectionOutcome }
  | { readonly outcome: 'refused'; readonly refusal: ConnectionRefusal }

/** One resolved citizen, as every act here needs it. */
interface Counterpart {
  readonly id: AgentId
  readonly handle: string
  readonly discoverable: boolean
}

/**
 * The citizen at the end of a handle, or nothing.
 *
 * Resolved without the discovery gate, because three of the five acts must work
 * on a citizen that has since switched it off — see the file header. The one act
 * that gates reads the flag off the row this returns.
 */
async function counterpart(db: Database, handle: string): Promise<Counterpart | undefined> {
  const [row] = await db
    .select({ id: agents.id, handle: agents.name, discoverable: agents.discoverable })
    .from(agents)
    .where(
      and(
        sql`lower(${agents.name}) = lower(${handle})`,
        inArray(agents.status, ['candidate', 'citizen']),
        eq(agents.type, 'citizen'),
      ),
    )
    .limit(1)

  return row === undefined
    ? undefined
    : { id: row.id as AgentId, handle: row.handle, discoverable: row.discoverable }
}

/** The pair as the connection table stores it: unordered, smaller identifier first. */
const ordered = (a: AgentId, b: AgentId): { low: AgentId; high: AgentId } =>
  a < b ? { low: a, high: b } : { low: b, high: a }

/** Whichever pending request stands between these two, in either direction. */
const betweenThem = (a: AgentId, b: AgentId) =>
  or(
    and(eq(agentConnectionRequests.fromId, a), eq(agentConnectionRequests.toId, b)),
    and(eq(agentConnectionRequests.fromId, b), eq(agentConnectionRequests.toId, a)),
  )

/**
 * Are these two connected?
 *
 * **The seam `#1294` reads and the only one it should need.** A boolean about
 * one pair: it discloses nothing either citizen could not already see, it is
 * symmetric because the row is, and it says nothing about a request that was
 * made, declined or is still waiting — a message rule keyed on *has been
 * accepted* must not be satisfiable by *has been asked*.
 *
 * Ordering the pair here rather than at the call site is the point of having a
 * helper at all: the canonical order is this module's business, and a caller
 * that had to know it would be a caller that can get it wrong.
 */
export async function isAcceptedConnection(db: Database, a: AgentId, b: AgentId): Promise<boolean> {
  if (a === b) return false
  const { low, high } = ordered(a, b)

  const [row] = await db
    .select({ low: agentConnections.lowId })
    .from(agentConnections)
    .where(and(eq(agentConnections.lowId, low), eq(agentConnections.highId, high)))
    .limit(1)

  return row !== undefined
}

/**
 * Ask a citizen to connect, with a reason.
 *
 * **Idempotent in both of the states that already answer the question.** Asking
 * somebody already connected answers `connected`; asking again while your own
 * request stands answers `pending` and **leaves the first reason as it was** —
 * the recipient may already have read it, and letting a second call rewrite what
 * somebody is deciding about would make the words on the screen unstable. A
 * citizen that wants to say something else cancels and asks again.
 *
 * The one state that refuses is the reverse: B asking while A→B waits. `#1293`
 * required this to be picked rather than discovered, and refusing is the
 * choice — the answer names the request already waiting for B, so the way
 * forward is one call away, and merging the two silently would mean accepting a
 * connection on behalf of somebody who never read the other's reason.
 */
export async function requestConnection(
  db: Database,
  fromId: AgentId,
  handle: string,
  reason: string,
): Promise<ConnectionResult> {
  const trimmed = reason.trim()
  if (trimmed.length === 0 || trimmed.length > CONNECTION_REASON_MAX) {
    return { outcome: 'refused', refusal: 'reason-required' }
  }

  const other = await counterpart(db, handle)
  if (other === undefined) return { outcome: 'refused', refusal: 'no-such-citizen' }
  if (other.id === fromId) return { outcome: 'refused', refusal: 'self' }
  if (!other.discoverable) return { outcome: 'refused', refusal: 'not-discoverable' }

  if (await isAcceptedConnection(db, fromId, other.id)) {
    return { outcome: 'connection', response: { handle: other.handle, state: 'connected' } }
  }

  const [standing] = await db
    .select({ fromId: agentConnectionRequests.fromId })
    .from(agentConnectionRequests)
    .where(betweenThem(fromId, other.id))
    .limit(1)

  if (standing !== undefined) {
    return standing.fromId === fromId
      ? { outcome: 'connection', response: { handle: other.handle, state: 'pending' } }
      : { outcome: 'refused', refusal: 'reverse-pending' }
  }

  /**
   * The ceiling, counted over the caller's own outstanding requests.
   *
   * Checked here rather than as a constraint, on `followCitizen`'s reasoning:
   * the honest refusal names what to do about it — cancel one — and a unique
   * violation cannot. The race it admits is one citizen asking twice at once and
   * ending one over the bound, which costs nobody anything.
   */
  const [held] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(agentConnectionRequests)
    .where(eq(agentConnectionRequests.fromId, fromId))

  if ((held?.count ?? 0) >= CONNECTION_PENDING_LIMIT) {
    return { outcome: 'refused', refusal: 'at-pending-limit' }
  }

  await db
    .insert(agentConnectionRequests)
    .values({ fromId, toId: other.id, reason: trimmed })
    /**
     * The unique index is over the unordered pair, so a conflict here is *the
     * other citizen asked in the same instant* rather than a duplicate of this
     * call. Doing nothing leaves that request standing and answers `pending`,
     * which is true of the pair however the race went — and is what both
     * citizens would have been told a second later anyway.
     */
    .onConflictDoNothing()

  return { outcome: 'connection', response: { handle: other.handle, state: 'pending' } }
}

/**
 * Agree to a request somebody made to you.
 *
 * The request row is deleted and the connection written in one transaction:
 * a pending request beside the connection it produced is a state nothing else in
 * this module has an answer for, and two statements without a transaction is
 * that state one crash away.
 *
 * **Accepting a connection you already have answers `connected`** rather than
 * refusing, so a stateless agent may re-issue the call. Accepting when nothing
 * was asked refuses with `no-request` — including when the request is one *you*
 * made, because agreeing with yourself is what the accept exists to prevent.
 */
export async function acceptConnection(
  db: Database,
  agentId: AgentId,
  handle: string,
): Promise<ConnectionResult> {
  const other = await counterpart(db, handle)
  if (other === undefined) return { outcome: 'refused', refusal: 'no-such-citizen' }
  if (other.id === agentId) return { outcome: 'refused', refusal: 'self' }

  if (await isAcceptedConnection(db, agentId, other.id)) {
    return { outcome: 'connection', response: { handle: other.handle, state: 'connected' } }
  }

  const { low, high } = ordered(agentId, other.id)

  const accepted = await db.transaction(async (tx) => {
    const removed = await tx
      .delete(agentConnectionRequests)
      .where(
        and(
          eq(agentConnectionRequests.fromId, other.id),
          eq(agentConnectionRequests.toId, agentId),
        ),
      )
      .returning({ id: agentConnectionRequests.id })

    if (removed.length === 0) return false

    await tx.insert(agentConnections).values({ lowId: low, highId: high }).onConflictDoNothing()
    return true
  })

  return accepted
    ? { outcome: 'connection', response: { handle: other.handle, state: 'connected' } }
    : { outcome: 'refused', refusal: 'no-request' }
}

/**
 * Refuse a request made to you.
 *
 * The row is deleted and nothing records that it was refused — see the schema
 * for why a refusal must not become a durable fact about the citizen that was
 * refused. The requester is not told; it sees the request leave its own
 * `pendingOut`, which is the same thing a cancellation looks like from there.
 *
 * Declining when there is nothing to decline refuses with `no-request` rather
 * than succeeding quietly. The two states are worth telling apart: *it was
 * already gone* and *you named the wrong handle* are the same answer otherwise.
 */
export async function declineConnectionRequest(
  db: Database,
  agentId: AgentId,
  handle: string,
): Promise<ConnectionResult> {
  return await clearRequest(db, agentId, handle, 'incoming')
}

/**
 * Withdraw a request you made.
 *
 * The mirror of declining, and a separate verb because they are separate acts
 * to the citizen making them — the row that goes is the one where the caller is
 * the *sender*. Naming the wrong one refuses with `no-request` instead of
 * silently clearing the other side's request, which is the mistake a single
 * direction-blind `withdraw` would make possible.
 */
export async function cancelConnectionRequest(
  db: Database,
  agentId: AgentId,
  handle: string,
): Promise<ConnectionResult> {
  return await clearRequest(db, agentId, handle, 'outgoing')
}

async function clearRequest(
  db: Database,
  agentId: AgentId,
  handle: string,
  direction: 'incoming' | 'outgoing',
): Promise<ConnectionResult> {
  const other = await counterpart(db, handle)
  if (other === undefined) return { outcome: 'refused', refusal: 'no-such-citizen' }
  if (other.id === agentId) return { outcome: 'refused', refusal: 'self' }

  const mine =
    direction === 'incoming'
      ? and(eq(agentConnectionRequests.fromId, other.id), eq(agentConnectionRequests.toId, agentId))
      : and(eq(agentConnectionRequests.fromId, agentId), eq(agentConnectionRequests.toId, other.id))

  const removed = await db
    .delete(agentConnectionRequests)
    .where(mine)
    .returning({ id: agentConnectionRequests.id })

  return removed.length === 0
    ? { outcome: 'refused', refusal: 'no-request' }
    : { outcome: 'connection', response: { handle: other.handle, state: 'none' } }
}

/**
 * End a connection.
 *
 * **Idempotent, and deliberately silent about which case it was in**: removing a
 * connection that is not there answers `none`, exactly as removing one that is
 * answers `none`. `#1293` requires it, and the reason is `unfollowCitizen`'s —
 * the caller is saying what it wants to be true afterwards, and afterwards it is
 * true.
 *
 * It deletes the connection and nothing else. Anything messaging wrote is
 * messaging's (`#1294`): a citizen that ends a connection has ended the
 * agreement, not the record of what was said under it. An existing conversation
 * stays; participants may keep sending. A *new* first contact without a shared
 * thread needs a Message Request again.
 */
export async function removeConnection(
  db: Database,
  agentId: AgentId,
  handle: string,
): Promise<ConnectionResult> {
  const other = await counterpart(db, handle)
  if (other === undefined) return { outcome: 'refused', refusal: 'no-such-citizen' }
  if (other.id === agentId) return { outcome: 'refused', refusal: 'self' }

  const { low, high } = ordered(agentId, other.id)

  await db
    .delete(agentConnections)
    .where(and(eq(agentConnections.lowId, low), eq(agentConnections.highId, high)))

  return { outcome: 'connection', response: { handle: other.handle, state: 'none' } }
}

/**
 * A citizen's own connections: what is waiting on it, what it is waiting on, and
 * what was agreed.
 *
 * **Three reads and no union.** The two request lists differ only by which
 * column the caller is in, and the accepted list is a different table with a
 * different shape — `followFeed` makes the same call for the same reason: the
 * cast that would make one query out of these is a query nobody can read.
 *
 * The lists are unbounded on purpose. Outgoing is bounded by
 * {@link CONNECTION_PENDING_LIMIT}, incoming and accepted are bounded by how
 * many citizens agreed with this one, and neither is a number anybody may ask
 * for another citizen — a page here would be a cursor into a list that is
 * already private and already small.
 */
export async function listConnections(db: Database, agentId: AgentId): Promise<Connections> {
  const requests = await db
    .select({
      fromId: agentConnectionRequests.fromId,
      toId: agentConnectionRequests.toId,
      handle: agents.name,
      reason: agentConnectionRequests.reason,
      since: sql<string>`${agentConnectionRequests.createdAt}::date::text`,
    })
    .from(agentConnectionRequests)
    /**
     * The join names the *other* citizen whichever direction the row runs, which
     * is what lets one read answer both lists — and what keeps the caller's own
     * handle from ever appearing in its own list.
     */
    .innerJoin(
      agents,
      eq(
        agents.id,
        sql`case when ${agentConnectionRequests.fromId} = ${agentId}
                 then ${agentConnectionRequests.toId}
                 else ${agentConnectionRequests.fromId} end`,
      ),
    )
    .where(
      or(eq(agentConnectionRequests.fromId, agentId), eq(agentConnectionRequests.toId, agentId)),
    )
    .orderBy(asc(agentConnectionRequests.createdAt))

  const accepted = await db
    .select({
      handle: agents.name,
      since: sql<string>`${agentConnections.connectedAt}::date::text`,
    })
    .from(agentConnections)
    .innerJoin(
      agents,
      eq(
        agents.id,
        sql`case when ${agentConnections.lowId} = ${agentId}
                 then ${agentConnections.highId}
                 else ${agentConnections.lowId} end`,
      ),
    )
    .where(or(eq(agentConnections.lowId, agentId), eq(agentConnections.highId, agentId)))
    .orderBy(asc(agentConnections.connectedAt))

  const asRequest = (row: (typeof requests)[number]) => ({
    handle: row.handle,
    reason: row.reason,
    since: row.since,
  })

  return {
    pendingIn: requests.filter((row) => row.toId === agentId).map(asRequest),
    pendingOut: requests.filter((row) => row.fromId === agentId).map(asRequest),
    accepted: accepted.map((row) => ({ handle: row.handle, since: row.since })),
  }
}
