import websocket from '@fastify/websocket'
import { API_BASE_PATH, type AgentId, type HumanId } from '@kolonie-ai/core'
import type { ShareForRelay } from '@kolonie-ai/db'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { bearerToken } from '../authentication.js'
import {
  createShareRelay,
  peerMessage,
  type RelaySocket,
  type ShareSide,
} from '../browser-share.js'
import { admitOperator } from '../browser-shares.js'
import { consoleHost } from './console-pages.js'
import { sessionCookie } from './authenticated.js'
import type { RouteDependencies } from './dependencies.js'

/**
 * The two doors of a browser share (`#736`).
 *
 * They are two rather than one because the two ends of a share are two different
 * kinds of caller, holding two different proofs, on two different hosts:
 *
 * | | The agent's sharer | The operator's window |
 * |---|---|---|
 * | Where | `${API_BASE_PATH}/browser/share/relay` | the console host |
 * | Proves it with | the share token, in `Authorization` | the console session cookie |
 * | Names the share by | the token, which *is* the name | its id, read off its own queue |
 *
 * **The operator's socket is on the console host and could not be anywhere
 * else.** `__Host-kolonie_session` is `SameSite=Lax`, so it does not travel on a
 * cross-site upgrade — an operator socket under `/v1/` would arrive with no
 * cookie and no way to say who was on it. The session is the whole of that end's
 * authentication, so it has to be same-origin with the page that opens it.
 *
 * **The agent's socket carries the token in a header and never in the query
 * string.** A URL turns up in access logs, in error reports and in anything that
 * proxies; a header does not, and the sharer is a program rather than a browser,
 * so it can set one.
 *
 * Neither handler reads a frame. What passes between them is
 * `../browser-share.ts`, and the reasoning for what the Colony is allowed to know
 * about a share is at the top of that file.
 */
export function registerBrowserShareRoutes(app: FastifyInstance, deps: RouteDependencies): void {
  const { shares } = deps
  if (shares === undefined) return

  /**
   * Who is on each live share, for the one question the relay cannot answer
   * (`#738`).
   *
   * `ShareClosedHandler` is given an id and a reason, which is everything the
   * *row* needs and one thing short of what the *wake* needs: whose agent it is,
   * and whether a person was ever actually on it. Both are known at join time
   * and neither is worth a second read of a row that is being closed anyway.
   *
   * **Process-local, and correct because a socket is too.** A share only ends
   * through the relay in the process holding both its sockets, so the entry is
   * always here when the handler runs. An entry the process loses to a restart
   * loses a knock, not a close — the row is closed by `expireStaleShares` at its
   * window either way, and the citizen reads what happened on its next waking.
   */
  const attending = new Map<string, { readonly agentId: AgentId; seenByOperator: boolean }>()

  /**
   * One relay for the process, closing the row whenever a share ends.
   *
   * The write is deliberately not awaited into the socket's path: by the time it
   * happens both sockets are already shut, and making a person's window wait on
   * a database round trip to finish closing would buy nothing. A failure is
   * logged and the row is closed by {@link expireStaleShares} at its window, so
   * the worst case is a share that reads as `expired` rather than `completed`.
   */
  const relay = createShareRelay((shareId, reason) => {
    const attended = attending.get(shareId)
    attending.delete(shareId)

    void shares.close(shareId, reason).catch((error: unknown) => {
      deps.log.error('a browser share could not be closed', error, {
        event: 'browser.share.close-failed',
        shareId,
        reason,
      })
    })

    /**
     * The knock, on the two endings that are worth one (`#738`, `#518`).
     *
     * **Only where a person actually arrived**, and only where the agent did not
     * already know. `completed` is the operator closing the window and `expired`
     * with somebody on it is the live minutes running out under them: in both,
     * the agent is sitting waiting on a tab that is its own again, and hours of
     * rhythm is the wrong amount of time to find that out.
     *
     * `lost` is the agent's own sharer going away, and `cancelled` is the agent
     * withdrawing — waking a citizen to tell it what it just did is noise on a
     * channel with a ceiling. An unattended offer that lapsed is not here at
     * all: nothing is `attending` it, because nobody came.
     */
    if (attended === undefined || !attended.seenByOperator) return
    if (reason === 'lost' || reason === 'cancelled') return

    /**
     * **The operator channel's own sender, and not a second one.** `#580` wired
     * one per agent across every operator event together precisely so that the
     * ceiling is one ceiling; a share that knocked through a sender of its own
     * would be a fourth channel quietly exempt from it.
     *
     * Nothing readable comes back and nothing is awaited into a socket's path —
     * `WakeSender.wake` returns nothing on purpose, and an operator is never
     * told whether their agent was reached.
     */
    void deps.operatorRequests.wake?.wake(attended.agentId, 'share-ended')
  })

  app.register(async (scope) => {
    /**
     * Registered in its own scope rather than on the app.
     *
     * The plugin adds an upgrade handler, and confining it here means the two
     * routes below are the only paths in the Colony that can be upgraded at all.
     * A WebSocket is the one request shape none of the existing hooks — the
     * credential check, the rate limiter, the error mapper — were written for,
     * so the smallest surface it can have is the right one.
     */
    await scope.register(websocket)

    /**
     * The agent's sharer dials in with the token its offer returned.
     *
     * **Every refusal is the same close and says nothing.** An unknown token, an
     * expired one, one belonging to a share that has already ended: all of them
     * are `1008` with no body, exactly as `shareForToken` returns null for all of
     * them. A socket that could distinguish them would be a way to ask whether a
     * guessed token ever named anything.
     */
    scope.get(
      `${API_BASE_PATH}/browser/share/relay`,
      { websocket: true },
      async (socket: WebSocketish, request: FastifyRequest) => {
        const token = bearerToken(request.headers.authorization)
        const share = token === undefined ? null : await shares.forToken(token)

        if (share === null) {
          socket.close(POLICY_VIOLATION)
          return
        }

        join(socket, share, 'agent')
        deps.log.info('an agent joined a browser share', {
          event: 'browser.share.joined',
          shareId: share.id,
          side: 'agent',
        })
      },
    )

    const host = consoleHost(deps.console.consoleUrl)
    if (host === undefined) return

    /**
     * The operator's window joins the share its queue showed it.
     *
     * Accepting and joining are one act here rather than two. A person who opens
     * the window has accepted — there is nothing else the window is for — and a
     * separate `POST /accept` would mean a share could sit accepted with nobody
     * watching it, burning the live window on a page that was never opened.
     *
     * **And joining needs somebody to join** (`#805`). The one act above was one
     * act too many when the citizen's own sharer had never dialled in: the offer
     * was spent, the live clock started, the agent was knocked, and the person
     * looked at black. {@link admitOperator} asks the relay first, and the third
     * answer it can give — real, theirs, and nothing on the far end — is told
     * with a `peer` line and an ordinary close rather than with a refusal.
     */
    scope.get(
      '/browser/share/:shareId/socket',
      { websocket: true },
      async (socket: WebSocketish, request: FastifyRequest) => {
        if ((request.headers.host ?? '').split(':')[0]?.toLowerCase() !== host) {
          socket.close(POLICY_VIOLATION)
          return
        }

        const cookie = sessionCookie(request.headers.cookie)
        const person = cookie === undefined ? null : await deps.humans.store.authenticate(cookie)

        if (person === null || person.outcome !== 'authenticated') {
          socket.close(POLICY_VIOLATION)
          return
        }

        const { shareId } = request.params as { shareId?: string }
        const admission = await admitOperator(shareId, person.human.id as HumanId, shares, (id) =>
          relay.present(id, 'agent'),
        )

        if (admission.outcome === 'refused') {
          socket.close(POLICY_VIOLATION)
          return
        }

        /**
         * Nobody is on the other end, so this is not a session and is not
         * pretended to be one (`#805`).
         *
         * **A normal close and not `1008`.** The person did nothing wrong and
         * the share is still theirs to open — what the page does with the `peer`
         * line is say so and stop looking live, and a policy violation would
         * have it say the opposite. Nothing is written: the row stays `offered`,
         * the six hours keep running, and the link in their inbox still works
         * once the citizen attaches.
         */
        if (admission.outcome === 'nothing-to-show') {
          socket.send(peerMessage(false))
          socket.close()
          deps.log.info('an operator arrived at a share whose sharer was not attached', {
            event: 'browser.share.no-sharer',
            shareId,
          })
          return
        }

        const accepted = admission
        join(socket, accepted.share, 'operator')
        deps.log.info('an operator joined a browser share', {
          event: 'browser.share.joined',
          shareId: accepted.share.id,
          side: 'operator',
        })

        /**
         * And knock, because the citizen asked for this and then went to sleep
         * (`#774`).
         *
         * **After `accept` has committed and after the socket is on the relay**,
         * in that order: an agent woken by this and calling straight back gets a
         * share that says `live`, and a sharer reconnecting has something to
         * attach to. Raising it before either would be knocking about a state
         * that is not yet true.
         *
         * Unconditional here, unlike the `share-ended` knock above, which asks
         * whether anybody ever came. Here somebody just did — that is the whole
         * event — and both a refused admission and one with nothing on the far
         * end have already returned. That second branch is what makes this knock
         * honest (`#805`): it used to fire for a person who was about to spend
         * fifteen minutes looking at nothing, waking a citizen to be told a
         * session had started that had not.
         *
         * `void` and never awaited, the same as its neighbour: this is a
         * courtesy on top of a socket that is already open, and a wake endpoint
         * that is slow or down must not hold up a person who is waiting to see
         * the page.
         */
        void deps.operatorRequests.wake?.wake(accepted.share.agentId as AgentId, 'share-joined')
      },
    )
  })

  /**
   * Put one socket on the relay and arm the clock that ends it.
   *
   * The timer is what makes the live window real. Nothing else would end a share
   * whose operator wandered off with the window open and whose agent is sitting
   * patiently on the other side — both sockets stay healthy, no message arrives,
   * and the exposure the decision record bounded *in minutes* would last as long
   * as the tab did.
   */
  function join(socket: WebSocketish, share: ShareForRelay, side: ShareSide): void {
    const { id: shareId, expiresAt } = share
    const attached = relay.attach(shareId, side, asRelaySocket(socket))

    /**
     * Who this share belongs to, and whether anybody came (`#738`).
     *
     * Written on **both** joins rather than only on the agent's, because either
     * end may arrive first and the wake needs the agent id in both orders. The
     * operator's arrival is the flag: it is what turns *this offer lapsed* into
     * *somebody was working on this and it ended under them*.
     */
    const attended = attending.get(shareId)
    attending.set(shareId, {
      agentId: share.agentId as AgentId,
      seenByOperator: side === 'operator' || (attended?.seenByOperator ?? false),
    })

    const remaining = Date.parse(expiresAt) - Date.now()
    const clock = setTimeout(() => relay.close(shareId, 'expired'), Math.max(remaining, 0))
    // The process must not be held open by a share nobody is on.
    clock.unref?.()

    socket.on('message', (data: unknown) => {
      attached.receive(textOf(data))
    })
    socket.on('close', () => {
      clearTimeout(clock)
      attached.leave()
    })
    socket.on('error', () => {
      clearTimeout(clock)
      attached.leave()
    })
  }
}

/** `1008`, policy violation: the one answer every refusal on these sockets gets. */
const POLICY_VIOLATION = 1008

/**
 * The half of `ws`'s socket these two routes use.
 *
 * Written out rather than imported so that `../browser-share.ts` — where the
 * behaviour is, and where the tests are — needs no WebSocket implementation to
 * be exercised at all.
 */
interface WebSocketish {
  send(data: string): void
  close(code?: number): void
  on(event: string, listener: (...args: never[]) => void): void
}

function asRelaySocket(socket: WebSocketish): RelaySocket {
  return {
    send: (message) => socket.send(message),
    close: () => socket.close(),
  }
}

/**
 * A message as the string it was sent as.
 *
 * `ws` hands over a `Buffer` for a text frame unless it is asked not to, and the
 * relay forwards strings. This is the one place a frame is touched at all, and it
 * is touched to change its container and not its contents.
 */
function textOf(data: unknown): string {
  if (typeof data === 'string') return data
  if (data instanceof Uint8Array) return Buffer.from(data).toString('utf8')
  return String(data)
}
