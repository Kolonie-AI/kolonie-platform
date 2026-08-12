import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { AgentId } from '@kolonie-ai/core'
import { buildApp } from '../app.js'
import { fakeColony } from '../__fixtures__/colony/index.js'
import {
  fakeAutonomyMailer,
  fakeAutonomyStore,
  fakeOperatorPages,
} from '../__fixtures__/autonomy.js'
import { fakeOperatorNotes } from '../__fixtures__/operator-notes.js'
import { fakeOperatorRequests } from '../__fixtures__/operator-requests.js'
import { fakeStore } from '../__fixtures__/store.js'
import { fakeTelegramDesk } from '../__fixtures__/operator-telegram.js'

const UPDATES = '/v1/internal/telegram-updates'
const CHAT = 5150

/**
 * The webhook and the two surfaces that offer the link (`#793`).
 *
 * What is asserted here rather than in `operator-telegram.test.ts` is everything
 * that is a property of the *wiring*: that the route does not exist without a
 * bot, that the header is checked before anything is read, that the page carries
 * a button rather than a payload, and that a deployment with none of the three
 * variables behaves exactly as it did before this existed.
 */
describe('the Telegram webhook (#793)', () => {
  let app: FastifyInstance
  let pages: ReturnType<typeof fakeOperatorPages>
  let desk: ReturnType<typeof fakeTelegramDesk>
  let store: ReturnType<typeof fakeAutonomyStore>
  let agentId: AgentId

  const colony = (withDesk: boolean) => {
    pages = fakeOperatorPages()
    desk = fakeTelegramDesk(pages)
    const agents = fakeStore()
    store = fakeAutonomyStore()

    const built = buildApp({
      ...fakeColony(),
      store: agents,
      autonomy: {
        store,
        pages,
        mailer: fakeAutonomyMailer(),
        formBaseUrl: 'https://console.example.org',
      },
      operatorRequests: fakeOperatorRequests({ pages }),
      operatorNotes: fakeOperatorNotes({ pages }),
      ...(withDesk ? { telegram: desk } : {}),
    })

    agentId = agents.issue().agent.id
    return built
  }

  afterEach(async () => {
    await app?.close()
  })

  const anUpdate = (payload: Record<string, unknown>, secret?: string) =>
    app.inject({
      method: 'POST',
      url: UPDATES,
      payload,
      headers: secret === undefined ? {} : { 'x-telegram-bot-api-secret-token': secret },
    })

  describe('with a bot configured', () => {
    beforeEach(async () => {
      app = colony(true)
      await app.ready()
    })

    it('acts on an update carrying the secret header', async () => {
      const { token } = await desk.store.issueStart(agentId)

      const response = await anUpdate(
        { message: { chat: { id: CHAT, type: 'private' }, text: `/start ${token}` } },
        desk.webhookSecret,
      )

      expect(response.statusCode).toBe(200)
      expect(desk.store.boundChatFor(agentId)).toBe(CHAT)
      expect(desk.bot.sent).toHaveLength(1)
    })

    it('refuses an update with no secret header, before reading the body', async () => {
      const { token } = await desk.store.issueStart(agentId)

      const response = await anUpdate({
        message: { chat: { id: CHAT, type: 'private' }, text: `/start ${token}` },
      })

      expect(response.statusCode).toBe(401)
      // The path is public; the header is the whole of what makes a request ours.
      expect(desk.store.boundChatFor(agentId)).toBeUndefined()
    })

    it('refuses a wrong secret, and says nothing about how wrong it was', async () => {
      const response = await anUpdate({ message: {} }, 'not-the-secret')

      expect(response.statusCode).toBe(401)
      expect(response.json()).toEqual({
        code: 'unauthorized',
        message: 'This endpoint is not for you.',
      })
    })

    it('answers 200 to an update it will not act on, so Telegram does not retry', async () => {
      // A non-2xx over an update type this bot has no use for is a retry storm
      // the Colony aimed at itself.
      const response = await anUpdate(
        { edited_channel_post: { text: 'whatever' } },
        desk.webhookSecret,
      )

      expect(response.statusCode).toBe(200)
      expect(desk.bot.sent).toHaveLength(0)
    })

    it('marks a chat unreachable when the answer bounces, and still answers 200', async () => {
      desk.store.bind(agentId, CHAT)
      desk.bot.block()

      const response = await anUpdate(
        { message: { chat: { id: CHAT, type: 'private' }, text: 'hello' } },
        desk.webhookSecret,
      )

      expect(response.statusCode).toBe(200)
      expect((await desk.store.bindingFor(agentId))?.unreachableAt).not.toBeNull()
    })
  })

  describe('where the link is offered', () => {
    beforeEach(async () => {
      app = colony(true)
      await app.ready()
    })

    it('puts a button on the durable page, and no payload in the page itself', async () => {
      const token = pages.issueNow(agentId, 'op@example.org')

      const response = await app.inject({ method: 'GET', url: `/operator/page/${token}` })

      expect(response.body).toContain('name="intent" value="telegram"')
      // A payload rendered into every page is one sitting in whatever tab the
      // operator left open, and re-minting on each reload would kill the link in
      // the tab beside it.
      expect(response.body).not.toContain('t.me')
    })

    it('mints a payload when the button is pressed and sends the person straight there', async () => {
      const token = pages.issueNow(agentId, 'op@example.org')

      const response = await app.inject({
        method: 'POST',
        url: `/operator/page/${token}`,
        payload: new URLSearchParams({ intent: 'telegram' }).toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      })

      // `303`, so pressing back does not re-post the form.
      expect(response.statusCode).toBe(303)
      expect(response.headers['location']).toMatch(/^https:\/\/t\.me\/KolonieDeskBot\?start=.+/)
    })

    it('refuses the button on a page the citizen has taken away', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/operator/page/never-issued',
        payload: new URLSearchParams({ intent: 'telegram' }).toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      })

      expect(response.statusCode).toBe(404)
    })

    it('offers the link once, on the page that confirms a contract was recorded', async () => {
      const { token } = await store.invite(agentId, 'op@example.org')

      const response = await app.inject({
        method: 'POST',
        url: `/operator/autonomy/${token}`,
        payload: new URLSearchParams({
          level: 'accompanied',
          challengesAllowed: 'no',
          defaultRule: 'ask',
          operatorRoute: 'email me',
        }).toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      })

      // On the page *after* the answer, never beside the form: pressing it
      // navigates away, and the form's own link is single-use.
      expect(response.statusCode).toBe(200)
      expect(response.body).toMatch(/https:\/\/t\.me\/KolonieDeskBot\?start=/)
    })

    it('says what the Colony will do, with email named as the fallback', async () => {
      desk.store.bind(agentId, CHAT)
      const token = pages.issueNow(agentId, 'op@example.org')

      const response = await app.inject({ method: 'GET', url: `/operator/page/${token}` })

      expect(response.body).toContain('messages you on Telegram')
      expect(response.body).toContain('falls back to email')
      // Bound already, so nothing offers to bind again.
      expect(response.body).not.toContain('name="intent" value="telegram"')
    })

    it('says so when the bound chat has stopped accepting messages', async () => {
      desk.store.bind(agentId, CHAT)
      await desk.store.markUnreachable(CHAT)
      const token = pages.issueNow(agentId, 'op@example.org')

      const response = await app.inject({ method: 'GET', url: `/operator/page/${token}` })

      expect(response.body).toContain('could not')
      expect(response.body).toContain('Bind Telegram again')
    })
  })

  /**
   * **The rejection case `#793` names**, and the one that decides whether this
   * feature can ship at all: with the three variables unset, nothing about the
   * Colony changes.
   */
  describe('with no bot configured, which is what runs today', () => {
    beforeEach(async () => {
      app = colony(false)
      await app.ready()
    })

    it('does not mount the webhook route at all', async () => {
      const response = await anUpdate({ message: {} }, 'anything')

      // Absent, not open. The same rule `/internal/email-inbound` follows.
      expect(response.statusCode).toBe(404)
    })

    it('offers no deep link on the durable page', async () => {
      const token = pages.issueNow(agentId, 'op@example.org')

      const response = await app.inject({ method: 'GET', url: `/operator/page/${token}` })

      expect(response.statusCode).toBe(200)
      expect(response.body).not.toContain('Telegram')
      expect(response.body).not.toContain('t.me')
    })

    it('offers no deep link after a contract form is answered', async () => {
      const { token } = await store.invite(agentId, 'op@example.org')

      const response = await app.inject({
        method: 'POST',
        url: `/operator/autonomy/${token}`,
        payload: new URLSearchParams({
          level: 'accompanied',
          challengesAllowed: 'no',
          defaultRule: 'ask',
          operatorRoute: 'email me',
        }).toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      })

      // The answer is recorded exactly as it was before this feature existed,
      // and nothing mentions a channel this deployment does not have.
      expect(response.statusCode).toBe(200)
      expect(response.body).toContain('Recorded')
      expect(response.body).not.toContain('Telegram')
    })
  })
})
