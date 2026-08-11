import websocket from '@fastify/websocket'
import { API_BASE_PATH, type HumanId } from '@kolonie-ai/core'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { bearerToken } from '../authentication.js'
import { createShareRelay, type RelaySocket, type ShareSide } from '../browser-share.js'
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
   * One relay for the process, closing the row whenever a share ends.
   *
   * The write is deliberately not awaited into the socket's path: by the time it
   * happens both sockets are already shut, and making a person's window wait on
   * a database round trip to finish closing would buy nothing. A failure is
   * logged and the row is closed by {@link expireStaleShares} at its window, so
   * the worst case is a share that reads as `expired` rather than `completed`.
   */
  const relay = createShareRelay((shareId, reason) => {
    void shares.close(shareId, reason).catch((error: unknown) => {
      deps.log.error('a browser share could not be closed', error, {
        event: 'browser.share.close-failed',
        shareId,
        reason,
      })
    })
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

        join(socket, share.id, 'agent', share.expiresAt)
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
        const accepted =
          shareId === undefined
            ? { outcome: 'refused' as const, reason: 'unknown' as const }
            : await shares.accept(shareId, person.human.id as HumanId)

        if (accepted.outcome === 'refused') {
          socket.close(POLICY_VIOLATION)
          return
        }

        join(socket, accepted.share.id, 'operator', accepted.share.expiresAt)
        deps.log.info('an operator joined a browser share', {
          event: 'browser.share.joined',
          shareId: accepted.share.id,
          side: 'operator',
        })
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
  function join(socket: WebSocketish, shareId: string, side: ShareSide, expiresAt: string): void {
    const attached = relay.attach(shareId, side, asRelaySocket(socket))

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
