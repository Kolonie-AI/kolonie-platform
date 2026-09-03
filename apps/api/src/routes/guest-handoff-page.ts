import { randomBytes, timingSafeEqual } from 'node:crypto'
import { GUEST_VAULT_HANDOFF_PASSPHRASE_MAX_LENGTH } from '@kolonie-ai/core'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  GUEST_HANDOFF_CSRF_COOKIE,
  GUEST_HANDOFF_HEADERS,
  GUEST_HANDOFF_PATH_PREFIX,
  guestHandoffClosedPage,
  guestHandoffPreviewPage,
  guestHandoffRetryPage,
  guestHandoffRevealPage,
} from '../guest-handoff-page.js'
import { observedOrigin } from '../observed-origin.js'
import { cookieValue } from './authenticated.js'
import { isAtlasRequest } from './atlas-pages.js'
import type { RouteDependencies } from './dependencies.js'

const path = `${GUEST_HANDOFF_PATH_PREFIX}:token`

const send = (reply: FastifyReply, status: number, body: string): FastifyReply =>
  reply.status(status).headers(GUEST_HANDOFF_HEADERS).type('text/html; charset=utf-8').send(body)

const closed = (reply: FastifyReply): FastifyReply => send(reply, 404, guestHandoffClosedPage())

const csrfCookie = (value: string): string =>
  `${GUEST_HANDOFF_CSRF_COOKIE}=${value}; Path=/; Max-Age=3600; Secure; HttpOnly; SameSite=Strict`

const clearedCsrfCookie = (): string =>
  `${GUEST_HANDOFF_CSRF_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict`

const same = (left: string | undefined, right: string | undefined): boolean => {
  if (left === undefined || right === undefined) return false
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

const expectedOrigin = (websiteUrl: string): string | undefined => {
  try {
    return new URL(websiteUrl).origin
  } catch {
    return undefined
  }
}

export function isGuestHandoffRequestUrl(url: string): boolean {
  const pathname = url.split('?', 1)[0] ?? url
  return (
    pathname === GUEST_HANDOFF_PATH_PREFIX.slice(0, -1) ||
    pathname.startsWith(GUEST_HANDOFF_PATH_PREFIX)
  )
}

export function redactedGuestHandoffUrl(url: string): string {
  if (!isGuestHandoffRequestUrl(url)) return url
  const query = url.indexOf('?')
  const pathname = query === -1 ? url : url.slice(0, query)
  const rest = pathname.slice(GUEST_HANDOFF_PATH_PREFIX.length)
  const slash = rest.indexOf('/')
  return `${GUEST_HANDOFF_PATH_PREFIX}:token${slash === -1 ? '' : rest.slice(slash)}`
}

export function registerGuestHandoffPage(app: FastifyInstance, deps: RouteDependencies): void {
  const preview = deps.vault.vault.previewGuestHandoff
  const consume = deps.vault.vault.consumeGuestHandoff
  const origin = expectedOrigin(deps.websiteUrl)
  const wrongHost = (request: FastifyRequest): boolean => !isAtlasRequest(request, deps.websiteUrl)

  app.head<{ Params: { token: string } }>(path, async (request, reply) => {
    if (wrongHost(request)) return reply.callNotFound()
    if (preview === undefined || consume === undefined) return closed(reply)
    const result = await preview(request.params.token)
    return send(reply, result.outcome === 'active' ? 200 : 404, '')
  })

  app.get<{ Params: { token: string } }>(path, async (request, reply) => {
    if (wrongHost(request)) return reply.callNotFound()
    if (preview === undefined || consume === undefined) return closed(reply)
    const result = await preview(request.params.token)
    if (result.outcome === 'closed') return closed(reply)

    const csrf = randomBytes(32).toString('base64url')
    reply.header('set-cookie', csrfCookie(csrf))
    return send(reply, 200, guestHandoffPreviewPage(result, csrf))
  })

  app.post<{
    Params: { token: string }
    Body: { csrf?: unknown; passphrase?: unknown }
  }>(path, async (request, reply) => {
    if (wrongHost(request)) return reply.callNotFound()
    if (preview === undefined || consume === undefined || origin === undefined) return closed(reply)

    const submitted = request.body ?? {}
    const csrf = typeof submitted.csrf === 'string' ? submitted.csrf : undefined
    const cookie = cookieValue(request.headers.cookie, GUEST_HANDOFF_CSRF_COOKIE)
    if (request.headers.origin !== origin || !same(csrf, cookie)) return closed(reply)

    const passphrase =
      typeof submitted.passphrase === 'string' &&
      submitted.passphrase.length <= GUEST_VAULT_HANDOFF_PASSPHRASE_MAX_LENGTH
        ? submitted.passphrase
        : undefined
    const result = await consume(
      request.params.token,
      passphrase,
      observedOrigin(request.headers, request.ip).fingerprint,
    )
    if (result.outcome === 'revealed') {
      deps.log.info('a guest vault handoff was consumed', {
        event: 'vault.guest-handoffs.consumed',
        handoffId: result.handoffId,
      })
      reply.header('set-cookie', clearedCsrfCookie())
      return send(reply, 200, guestHandoffRevealPage(result))
    }
    if (result.outcome === 'closed') return closed(reply)

    const stillActive = await preview(request.params.token)
    if (stillActive.outcome === 'closed') return closed(reply)
    return send(
      reply,
      result.outcome === 'rate-limited' ? 429 : 422,
      guestHandoffRetryPage(stillActive, csrf as string, result.outcome === 'rate-limited'),
    )
  })
}
