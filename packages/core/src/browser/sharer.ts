import {
  isRelayableCdpMethod,
  ShareOperatorMessageSchema,
  type ShareCloseReason,
  type ShareFrame,
} from './share.js'

/**
 * The agent side of a browser share: the thing that decides what an operator's
 * clicks are allowed to become (`#736`).
 *
 * ## Why this is in `core` and not in a runner
 *
 * The allowlist is the security boundary, and the decision record's whole
 * argument is that it lives **next to the CDP connection and not in the relay**,
 * so that a Colony which had been compromised still could not drive an agent's
 * browser past clicking and typing on the page it was offered. That argument is
 * about *where it is enforced*, which is agent-side either way — and it says
 * nothing about where the code is kept.
 *
 * Keeping it here buys the one thing that matters: the boundary is a pure
 * function of *(message in, calls out)*, so *"`Page.navigate` over the operator
 * socket does nothing"* is a unit test with no browser, no socket and no Chrome
 * in it, and it runs on every commit. A boundary whose test needs a running
 * browser is a boundary that gets tested once.
 *
 * There is no I/O in this file. The socket and the CDP connection are both
 * handed in, which is also what lets the runner be about fifty lines of glue in
 * whichever runtime an agent happens to have.
 */

/** What the session does to the browser: one CDP call against the shared target. */
export type CdpCall = (method: string, params: Record<string, unknown>) => void

/** What the session sends up the outbound socket to the Colony. */
export type ColonySend = (message: string) => void

export interface SharerSessionOptions {
  /**
   * The one target this share is bound to, as the offer named it.
   *
   * Checked against every frame the sharer is fed, so a sharer attached to the
   * wrong tab streams nothing rather than streaming the wrong thing. *One tab,
   * not a desktop* is the first of the decision's five limits and a mistake here
   * is the only way past it that does not require a code change.
   */
  readonly targetId: string
  readonly callCdp: CdpCall
  readonly sendToColony: ColonySend
  /**
   * Told about every operator message that was refused, with the method it
   * named. **The method and never the parameters** — a refused
   * `Input.insertText` carries whatever the operator typed, which may be a
   * password, and a log line is the last place that should turn up.
   */
  readonly onRefused?: ((method: string) => void) | undefined
}

export interface SharerSession {
  /**
   * A `Page.screencastFrame` arrived. Forwards the frame and nothing else.
   *
   * The ack is **not** sent here. It is sent when
   * {@link SharerSession.acknowledge} is called, which is what the runner does
   * once the socket has actually taken the bytes — that is the backpressure, and
   * acking on arrival would throw it away and build a queue of stale pictures
   * instead.
   */
  readonly onScreencastFrame: (frame: {
    data: string
    sessionId: number
    targetId?: string
  }) => void
  /** The socket has taken the frame; tell Chrome it may send the next one. */
  readonly acknowledge: (sessionId: number) => void
  /**
   * Something arrived from the Colony on the operator's behalf.
   *
   * Returns what was done with it, so the runner can count refusals without
   * having to re-derive the rule.
   */
  readonly onColonyMessage: (raw: string) => ColonyMessageOutcome
  /** Stop the screencast. Called on completion, on timeout and on the way down. */
  readonly stop: (reason: ShareCloseReason) => void
}

export type ColonyMessageOutcome =
  /** An input event, forwarded to the browser. */
  | { readonly outcome: 'relayed'; readonly method: string }
  /** A method that is not on the allowlist. Dropped, silently as far as the operator is concerned. */
  | { readonly outcome: 'refused'; readonly method: string }
  /** Not a message this protocol has. Dropped. */
  | { readonly outcome: 'unreadable' }
  /** The other end says it is over. */
  | { readonly outcome: 'closed'; readonly reason: ShareCloseReason }

/**
 * Build the session.
 *
 * It starts nothing: attaching to the target and calling `Page.startScreencast`
 * are the runner's, because they are I/O and because the runner is the only
 * thing that knows whether its CDP client is connected yet.
 */
export function createSharerSession(options: SharerSessionOptions): SharerSession {
  let stopped = false

  return {
    onScreencastFrame(frame) {
      if (stopped) return

      /**
       * A frame from a target this share does not name is dropped without a
       * word. It should be impossible — the runner attaches to one target — and
       * *should be impossible* is the reason to check rather than the reason not
       * to: the cost of being wrong is streaming a different tab of the agent's
       * browser to somebody.
       */
      if (frame.targetId !== undefined && frame.targetId !== options.targetId) return

      const message: ShareFrame = { type: 'frame', data: frame.data, ack: frame.sessionId }
      options.sendToColony(JSON.stringify(message))
    },

    acknowledge(sessionId) {
      if (stopped) return
      options.callCdp('Page.screencastFrameAck', { sessionId })
    },

    onColonyMessage(raw) {
      if (stopped) return { outcome: 'unreadable' }

      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        return { outcome: 'unreadable' }
      }

      const message = ShareOperatorMessageSchema.safeParse(parsed)
      if (!message.success) return { outcome: 'unreadable' }

      if (message.data.type === 'closed') {
        stopped = true
        options.callCdp('Page.stopScreencast', {})
        return { outcome: 'closed', reason: message.data.reason }
      }

      /**
       * **This is the boundary.** Everything above is parsing; this line is the
       * difference between an operator that can pass a captcha and an operator
       * that has a remote browser.
       */
      if (!isRelayableCdpMethod(message.data.method)) {
        options.onRefused?.(message.data.method)
        return { outcome: 'refused', method: message.data.method }
      }

      options.callCdp(message.data.method, message.data.params)
      return { outcome: 'relayed', method: message.data.method }
    },

    stop(reason) {
      if (stopped) return
      stopped = true
      options.callCdp('Page.stopScreencast', {})
      options.sendToColony(JSON.stringify({ type: 'closed', reason }))
    },
  }
}
