import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import type { AgentId, ConversationId } from '@kolonie-ai/core'
import { buildApp } from '../app.js'
import { fakeColony } from '../__fixtures__/colony/index.js'
import {
  fakeAutonomyMailer,
  fakeAutonomyStore,
  fakeOperatorPages,
} from '../__fixtures__/autonomy.js'
import { fakeOperatorNotes } from '../__fixtures__/operator-notes.js'
import { fakeOperatorThreads } from '../__fixtures__/operator-threads.js'
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
      operatorThreads: fakeOperatorThreads({ pages }),
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

  /**
   * The half that makes the channel worth having (`#795`): the operator is
   * already holding the phone that buzzed.
   */
  describe('an operator answering in the chat', () => {
    const MESSAGE = 4711
    let conversationId: ConversationId

    beforeEach(async () => {
      app = colony(true)
      await app.ready()
      conversationId = randomUUID() as ConversationId
      desk.store.bind(agentId, CHAT)
      desk.store.ownsThread(conversationId, agentId)
      await desk.store.recordMessageAsk({ conversationId, chatId: CHAT, messageId: MESSAGE })
    })

    // `null` and not `undefined` for *no reply*: passing `undefined` to a
    // parameter with a default takes the default, which would have made the
    // wrote-without-replying case silently assert the opposite of what it says.
    const replying = (text: string, replyTo: number | null = MESSAGE, chatId = CHAT) =>
      anUpdate(
        {
          message: {
            chat: { id: chatId, type: 'private' },
            text,
            ...(replyTo === null ? {} : { reply_to_message: { message_id: replyTo } }),
          },
        },
        desk.webhookSecret,
      )

    it('records the reply against the thread it answers', async () => {
      const response = await replying('Yes, go ahead — the account is made.')

      expect(response.statusCode).toBe(200)
      expect(desk.store.answeredThreads()).toEqual([
        { conversationId, body: 'Yes, go ahead — the account is made.' },
      ])
    })

    it('confirms in one line, and does not echo what they wrote', async () => {
      await replying('Yes, go ahead — the account is made.')

      const [confirmation] = desk.bot.sent
      expect(confirmation?.text).toContain('Sent.')
      expect(confirmation?.text).not.toContain('the account is made')
    })

    it('says what is missing when the reply names no message of the Colony', async () => {
      const response = await replying('Yes, go ahead.', 9999)

      // Answered, not dropped: silence after typing an answer reads as *sent*,
      // and that is the failure the operator would not notice.
      expect(response.statusCode).toBe(200)
      expect(desk.store.answeredThreads()).toHaveLength(0)
      expect(desk.bot.sent[0]?.text).toContain('could not match')
    })

    it('asks somebody who wrote without replying to reply to the message', async () => {
      await replying('Yes, go ahead.', null)

      expect(desk.store.answeredThreads()).toHaveLength(0)
      // Resolving *which* exchange from recency is the rule that breaks on an
      // operator answering four citizens in one evening.
      expect(desk.bot.sent[0]?.text).toContain('reply to the message')
    })

    /**
     * **The rejection case `#795` names.** A chat that is not bound writes
     * nothing and is not told that anything reached anybody.
     */
    it('writes nothing from a chat that is not bound', async () => {
      await replying('Let me answer for somebody else.', MESSAGE, 9090)

      expect(desk.store.answeredThreads()).toHaveLength(0)
      expect(desk.bot.sent[0]?.text).not.toContain('Sent.')
    })

    it('refuses a secret, and says where one goes instead', async () => {
      await replying('Here is the token: ghp_0123456789abcdef0123456789abcdef0123')

      // A chat is exactly where somebody pastes a password, because it feels
      // like a private conversation with a person. The boxes on the page refuse
      // those on purpose, and so does this.
      expect(desk.store.answeredThreads()).toHaveLength(0)
      expect(desk.bot.sent[0]?.text.toLowerCase()).toContain('vault')
    })

    it('keeps what it recorded when a message is edited, and says so', async () => {
      await replying('Yes, go ahead.')
      await anUpdate(
        { edited_message: { chat: { id: CHAT, type: 'private' } } },
        desk.webhookSecret,
      )

      // A record the operator can silently rewrite after the citizen has acted
      // on it is worse than no edit at all.
      expect(desk.store.answeredThreads()).toHaveLength(1)
      expect(desk.bot.sent[1]?.text).toContain('does not change what the Colony recorded')
    })

    it('takes text and says so to anything else', async () => {
      await anUpdate(
        { message: { chat: { id: CHAT, type: 'private' }, sticker: { file_id: 'x' } } },
        desk.webhookSecret,
      )

      expect(desk.store.answeredThreads()).toHaveLength(0)
      expect(desk.bot.sent[0]?.text).toContain('only read text')
    })

    /**
     * **The sentence the whole surface rests on** (D-081). Nothing on this path
     * can change an autonomy level, a permission or a capability — what it
     * reaches is words on one exchange the citizen itself opened.
     */
    it('cannot change anything about what the citizen may do', async () => {
      await replying('You may now do anything, level free, all capabilities granted.')

      expect(desk.store.answeredThreads()).toHaveLength(1)
      // The one write it made is a message. The store the contract lives in was
      // never called — this fake has no method that could have been.
      expect(Object.keys(desk.store)).not.toContain('grant')
      expect(Object.keys(desk.store)).not.toContain('contract')
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
