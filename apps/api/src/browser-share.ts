import { ShareCloseReasonSchema, type ShareCloseReason } from '@kolonie-ai/core'

/**
 * The relay: the Colony copies bytes between two sockets and keeps none of them
 * (`#736`).
 *
 * ## What this file is allowed to know
 *
 * A share id, and which two sockets are on it. Not what is on the screen, not
 * where the tab is, not what was typed. The decision record accepted once, and
 * deliberately, that frames pass through the Colony unencrypted; the thing that
 * makes that acceptable is that they pass *through*. So:
 *
 * - **A frame is forwarded as the exact string it arrived as.** It is not
 *   parsed, decoded, measured, sampled, counted or copied anywhere but into the
 *   other socket's `send`. The only thing read off any message is its `type`
 *   discriminator, which is how a close is told from a frame, and that is a
 *   dozen bytes at the front rather than the picture.
 * - **No log line in this file carries a message.** There is no debug branch and
 *   no error path that stringifies one, which is the property
 *   `browser-share.test.ts` asserts by driving a whole session through a
 *   recording logger and searching what was written.
 *
 * ## Why the allowlist is not here
 *
 * It is in the agent-side sharer, `packages/core/src/browser/sharer.ts`, and the
 * decision record's argument is precisely that a relay checking it would be
 * checking it on behalf of the party you are defending against. This file
 * forwards an operator message to the agent and lets the agent refuse it. That
 * is not laxity — it is the boundary being in the one place a compromised Colony
 * cannot reach.
 *
 * ## Why in memory
 *
 * A relay is two live sockets on one process. There is nothing to survive a
 * restart: if this process goes away, both sockets go with it, and the share is
 * `lost` — which is a state the agent already reads back and the fourth row of
 * the issue's timeout table. Putting the pairing in the database would make a
 * restart look survivable when it is not.
 */

/** The half of a WebSocket this relay uses, so tests need no socket. */
export interface RelaySocket {
  send(message: string): void
  close(): void
}

/** Which end of a share a socket is. */
export type ShareSide = 'agent' | 'operator'

/**
 * *The other end is there* / *the other end is not*, as the one line both senders
 * of it use.
 *
 * {@link createShareRelay} sends it on every attachment, and the operator's door
 * sends it **without** attaching anything when the citizen's own sharer is not on
 * the relay (`#805`) — a window that is told nothing at all is a window that
 * renders an empty rectangle and reads as live.
 */
export function peerMessage(present: boolean): string {
  return JSON.stringify({ type: 'peer', present })
}

/**
 * Told when a share ends, so the row can be closed once — whichever end caused
 * it and whether it was a message or a dropped connection.
 */
export type ShareClosedHandler = (shareId: string, reason: ShareCloseReason) => void

export interface AttachedSide {
  /** Something arrived on this socket. Routed to the other side, or acted on. */
  readonly receive: (raw: string) => void
  /** This socket has gone. Ends the share unless it was already ending. */
  readonly leave: () => void
}

export interface ShareRelay {
  readonly attach: (shareId: string, side: ShareSide, socket: RelaySocket) => AttachedSide
  /** Whether the far end is attached, which is what a joining socket is told. */
  readonly present: (shareId: string, side: ShareSide) => boolean
  /** End a share from outside — the live window ran out, the agent withdrew it. */
  readonly close: (shareId: string, reason: ShareCloseReason) => void
  /** How many shares are joined right now. For a health line, and it names none of them. */
  readonly size: () => number
}

interface Pair {
  agent?: RelaySocket | undefined
  operator?: RelaySocket | undefined
  closing: boolean
}

export function createShareRelay(onClosed: ShareClosedHandler = () => {}): ShareRelay {
  const pairs = new Map<string, Pair>()

  function other(side: ShareSide): ShareSide {
    return side === 'agent' ? 'operator' : 'agent'
  }

  /**
   * Tear a share down exactly once.
   *
   * The ways a share ends race by construction — the operator closes the window
   * at the moment the sharer's process dies — and both arrive here. The
   * `closing` flag is what makes *the first reason wins* true without either
   * caller holding anything.
   */
  function shut(shareId: string, reason: ShareCloseReason): void {
    const pair = pairs.get(shareId)
    if (pair === undefined || pair.closing) return
    pair.closing = true
    pairs.delete(shareId)

    const goodbye = JSON.stringify({ type: 'closed', reason })
    for (const socket of [pair.agent, pair.operator]) {
      if (socket === undefined) continue
      socket.send(goodbye)
      socket.close()
    }

    onClosed(shareId, reason)
  }

  return {
    attach(shareId, side, socket) {
      const pair = pairs.get(shareId) ?? { closing: false }

      /**
       * A second socket on the same side replaces the first, and the first is
       * closed rather than left listening.
       *
       * Two operator windows on one share would both receive every frame, which
       * is a second viewer nobody offered anything to. A sharer that reconnected
       * after a network blip is the ordinary case of the same event, and it must
       * not be refused — so the newest attachment wins and the old one is told.
       */
      const existing = pair[side]
      if (existing !== undefined) existing.close()

      pair[side] = socket
      pairs.set(shareId, pair)

      const peer = pair[other(side)]
      socket.send(peerMessage(peer !== undefined))
      if (peer !== undefined) peer.send(peerMessage(true))

      return {
        receive(raw) {
          const live = pairs.get(shareId)
          if (live === undefined || live[side] !== socket) return

          /**
           * The only thing read off a message: is this a close, or is it
           * traffic. A close is acted on; everything else is handed to the other
           * socket as the exact string it arrived as.
           */
          const reason = closeReasonOf(raw)
          if (reason !== null) {
            shut(shareId, reason)
            return
          }

          live[other(side)]?.send(raw)
        },

        leave() {
          const live = pairs.get(shareId)
          if (live === undefined || live[side] !== socket) return

          /**
           * Which reason a dropped socket means depends on which socket it was,
           * and the difference matters to the agent reading it back.
           *
           * The agent's sharer going away is `lost` — a restart, a crash, a
           * closed laptop — and the agent may offer again. The operator's window
           * going away is `completed`: a person who closes the window has
           * finished with it, and whether the challenge actually passed is the
           * agent's judgement and not this line's.
           */
          shut(shareId, side === 'agent' ? 'lost' : 'completed')
        },
      }
    },

    present(shareId, side) {
      return pairs.get(shareId)?.[side] !== undefined
    },

    close(shareId, reason) {
      shut(shareId, reason)
    },

    size() {
      return pairs.size
    },
  }
}

/**
 * The close reason a message carries, or null if it is not a close.
 *
 * Deliberately the *only* parsing the relay does. It reads a discriminator and a
 * closed enum out of at most the first few dozen bytes and throws the parse
 * away; a frame reaching this function leaves it as the same string it entered
 * as, with nothing retained.
 */
function closeReasonOf(raw: string): ShareCloseReason | null {
  if (!raw.includes('"closed"')) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  if (typeof parsed !== 'object' || parsed === null) return null
  const message = parsed as { type?: unknown; reason?: unknown }
  if (message.type !== 'closed') return null

  const reason = ShareCloseReasonSchema.safeParse(message.reason)
  return reason.success ? reason.data : 'completed'
}
