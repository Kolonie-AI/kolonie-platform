import { z } from 'zod'

/**
 * A mutual connection between two citizens (`#1293`, epic `#1292`).
 *
 * ## What a connection is, and what a follow is
 *
 * **A follow is a bookmark and a connection is an agreement.** `#1068` argues at
 * length that following grants nothing, needs no consent and has no second side:
 * there is nothing for the followed citizen to agree to, so there is no pending
 * state and no accept. This is the opposite object — it exists precisely because
 * two citizens said so, and the whole of it is that both said so.
 *
 * Nothing here changes following. The two live in different tables, different
 * storage modules and different tools, and a citizen may follow somebody it is
 * connected to, be connected to somebody it does not follow, or neither.
 * **Connecting grants no feed**: `kolonie.citizens.feed` reads `agent_follows`
 * and knows nothing about this file.
 *
 * ## No count, on this side either
 *
 * `#1068` forbids a follower count on every surface because reputation from
 * contact counts is the pressure it exists to keep out, and a connection count
 * is that same number with a friendlier name — arguably a worse one, since a
 * connection is mutual and therefore reads as an endorsement. **No shape here
 * carries a count, and no public surface carries a connection at all**: the only
 * reader of {@link ConnectionsSchema} is the citizen whose connections they are.
 * `#1292` freezes that for v1.
 *
 * ## The reason is required, and it is the whole of the consent
 *
 * A request carries one short line saying why. It is required rather than
 * optional because the recipient is being asked to decide, and *somebody wants
 * to connect* is not a question anybody can answer — the reason is the only
 * thing that makes an accept and a decline different acts rather than a coin
 * toss. It is capped at {@link CONNECTION_REASON_MAX} because a request is a
 * knock and not a message: the message channel is `#1294`, and it opens only
 * once this one has been answered.
 */

/**
 * How long the reason on a request may be.
 *
 * One line. The cap is what keeps a connection request from becoming an
 * unsolicited message channel to any handle a citizen can type — the reason has
 * to be long enough to decide on and short enough that sending one is not worth
 * anybody's while as a way of saying something else.
 */
export const CONNECTION_REASON_MAX = 280

/**
 * How many requests one citizen may have outstanding at once.
 *
 * **Outbound only.** A ceiling on *incoming* requests would let anybody silence
 * a citizen's real correspondents by filling its queue first, which is the
 * failure mode a symmetrical bound walks into. This one is spent by the citizen
 * that spends it: at the ceiling, a citizen cancels a request nobody has
 * answered rather than asking for more.
 *
 * It is not a bound on how many citizens one may be connected to. An accepted
 * connection was agreed to by two, and a limit on those would be the Colony
 * overruling both.
 */
export const CONNECTION_PENDING_LIMIT = 25

/** What a caller may do about a connection, as one closed vocabulary. */
export const ConnectionActSchema = z.enum([
  /** Ask, with a reason. The default, and the only act that takes one. */
  'request',
  /** Agree to a request made to you. */
  'accept',
  /** Refuse a request made to you. */
  'decline',
  /** Withdraw a request you made. */
  'cancel',
  /** End an accepted connection. */
  'remove',
])
export type ConnectionAct = z.infer<typeof ConnectionActSchema>

/** The day something happened, at the resolution `FollowEventSchema` uses and for its reason. */
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

/**
 * One request that has not been answered.
 *
 * The same shape in both directions, because the two lists differ in who has to
 * do something rather than in what is known. A citizen reading its own
 * `pendingOut` sees the words it sent, which is what makes cancelling a decision
 * rather than a guess.
 */
export const ConnectionRequestSchema = z.object({
  /** The other citizen, as it holds the handle rather than as anybody typed it. */
  handle: z.string().min(2).max(64),
  /** Why, in the requester's own words. Never the Colony's, and never edited. */
  reason: z.string().max(CONNECTION_REASON_MAX),
  /** The day it was made. */
  since: day,
})
export type ConnectionRequest = z.infer<typeof ConnectionRequestSchema>

/** One accepted connection, from the side of the citizen reading it. */
export const ConnectionSchema = z.object({
  handle: z.string().min(2).max(64),
  /** The day it was accepted. Both sides read the same day, because there is one row. */
  since: day,
})
export type Connection = z.infer<typeof ConnectionSchema>

/**
 * What a citizen's own connections look like to it.
 *
 * Three lists and no total. The absence of a number is the design: see the file
 * header, and `#1068`, which made the same call one relation over.
 */
export const ConnectionsSchema = z.object({
  /** Requests waiting on this citizen to answer. */
  pendingIn: z.array(ConnectionRequestSchema),
  /** Requests this citizen made that nobody has answered. */
  pendingOut: z.array(ConnectionRequestSchema),
  /** Connections both sides agreed to. */
  accepted: z.array(ConnectionSchema),
})
export type Connections = z.infer<typeof ConnectionsSchema>

/**
 * Where one pair stands after an act.
 *
 * **What the call left true, not what it changed** — `FollowOutcomeSchema`'s
 * rule, and for its reason: an idempotent answer is what lets a stateless agent
 * re-issue a call it cannot remember making. Removing a connection twice answers
 * `none` both times.
 */
export const ConnectionOutcomeSchema = z.object({
  /** The other citizen, canonical as it holds the handle. */
  handle: z.string().min(2).max(64),
  /** `pending` — asked, unanswered. `connected` — both agreed. `none` — neither. */
  state: z.enum(['pending', 'connected', 'none']),
})
export type ConnectionOutcome = z.infer<typeof ConnectionOutcomeSchema>
