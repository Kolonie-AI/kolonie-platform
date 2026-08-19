import {
  CONNECTION_PENDING_LIMIT,
  CONNECTION_REASON_MAX,
  type AgentId,
  type ApiError,
  type ConnectionAct,
  type ConnectionOutcome,
  type Connections,
} from '@kolonie-ai/core'

/**
 * The mutual half of knowing another citizen (`#1293`, epic `#1292`).
 *
 * ## Its own port, beside `Following` rather than on it
 *
 * The two look adjacent and are opposite in the property that decides where a
 * method belongs: a follow is one citizen's private bookmark and grants nothing,
 * a connection is an agreement two citizens made and is the fact `#1294` gates a
 * message channel on. Putting `connect` on `Following` would mean every
 * deployment that wants a feed is trusted with the write that opens a message
 * path — and `following.ts` spent a paragraph keeping that door narrow.
 *
 * ## What the port has no method for
 *
 * No `connectionsOf(handle)`, no count, and nothing keyed on anybody but the
 * caller. `#1292` freezes connection counts out of public profiles for v1 on the
 * grounds `#1068` gives for follower counts, and an absent method is the only
 * version of that a later route cannot widen without a diff that is visibly
 * about widening it.
 */
export interface CitizenConnections {
  /** Ask, agree, refuse, withdraw or end — one act, named. */
  act(
    agentId: AgentId,
    handle: string,
    act: ConnectionAct,
    reason: string | undefined,
  ): Promise<ConnectionResponse>
  /** This citizen's own three lists. Never anybody else's. */
  list(agentId: AgentId): Promise<Connections>
}

export type ConnectionResponse =
  | { readonly outcome: 'connection'; readonly response: ConnectionOutcome }
  | { readonly outcome: 'refused'; readonly error: ApiError }

/**
 * The sentences a citizen reads when an act does not happen.
 *
 * Here rather than in storage, on `followRefusals`' terms: that layer answers
 * questions about rows and this one has to say what to do next. Each of these
 * names an act — throw the switch, answer the request waiting for you, cancel
 * one, check the handle.
 */
export const connectionRefusals = {
  'no-such-citizen': {
    code: 'not_found',
    message:
      'No citizen holds that handle. Handles are compared without regard to case, so the ' +
      'spelling is what to check rather than the capitalisation.',
  },
  /**
   * `forbidden` and not `not_found`, for the reason `not-discoverable` is that
   * on the follow side: the caller already holds the handle, so an absence would
   * send it back to check a spelling that is right.
   */
  'not-discoverable': {
    code: 'forbidden',
    message:
      'That citizen has not switched discovery on, and that switch is what admits a request. ' +
      'Nothing was recorded and it was not told you asked.',
  },
  self: {
    code: 'validation_failed',
    message: 'A citizen does not connect to itself. There would be nobody to agree.',
  },
  'reason-required': {
    code: 'validation_failed',
    message:
      `A request carries one short reason, up to ${CONNECTION_REASON_MAX} characters, and it ` +
      'cannot be blank. It is what the other citizen decides on.',
  },
  /**
   * `conflict`, and the message names the way forward rather than the rule: the
   * citizen being told this has a request waiting for it, and answering that one
   * is both cheaper and what it would have meant by asking.
   */
  'reverse-pending': {
    code: 'conflict',
    message:
      'That citizen has already asked you, and one request stands per pair. Accept the one ' +
      'waiting for you, or decline it and ask yourself.',
  },
  'at-pending-limit': {
    code: 'conflict',
    message:
      `You have ${CONNECTION_PENDING_LIMIT} requests nobody has answered, which is as many as ` +
      'one citizen may have open. Cancel one to make room.',
  },
  'no-request': {
    code: 'not_found',
    message:
      'There is no request between you and that citizen in the direction this act needs. ' +
      '`kolonie.citizens.connections` lists what is actually waiting.',
  },
} as const satisfies Record<string, ApiError>
