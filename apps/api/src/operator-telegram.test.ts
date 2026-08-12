import { describe, expect, it } from 'vitest'
import type { AgentId } from '@kolonie-ai/core'
import { randomUUID } from 'node:crypto'
import { deepLinkFor, handleTelegramUpdate, telegramFromEnv } from './operator-telegram.js'
import { fakeTelegramDesk } from './__fixtures__/operator-telegram.js'

const CHAT = 8811

const aPrivateMessage = (text: string, chatId = CHAT) => ({
  message: { chat: { id: chatId, type: 'private' }, text },
})

describe('the Telegram operator desk (#793)', () => {
  describe('what it is configured from', () => {
    const all = {
      TELEGRAM_OPERATOR_BOT_TOKEN: 'a-token',
      TELEGRAM_OPERATOR_BOT_USERNAME: 'KolonieDeskBot',
      TELEGRAM_WEBHOOK_SECRET: 'a-secret',
    }

    it('is configured when all three are set', () => {
      expect(telegramFromEnv(all)).toEqual({
        token: 'a-token',
        username: 'KolonieDeskBot',
        webhookSecret: 'a-secret',
      })
    })

    it.each(Object.keys(all))('is absent when %s is missing', (missing) => {
      // All three or none. A token with no webhook secret would mount a public
      // route with nothing guarding it, and a secret with no token would hand a
      // person a link into a bot that cannot answer.
      expect(telegramFromEnv({ ...all, [missing]: '' })).toBeUndefined()
    })

    it('is absent when nothing at all is set, which is what runs today', () => {
      expect(telegramFromEnv({})).toBeUndefined()
    })

    it('drops a leading @ from the username, because a deep link carrying one is dead', () => {
      expect(
        telegramFromEnv({ ...all, TELEGRAM_OPERATOR_BOT_USERNAME: '@KolonieDeskBot' })?.username,
      ).toBe('KolonieDeskBot')
    })
  })

  it('builds the deep link from the configured username and never from a constant', () => {
    const desk = fakeTelegramDesk()
    expect(deepLinkFor(desk.bot, 'the-payload')).toBe(
      'https://t.me/KolonieDeskBot?start=the-payload',
    )
  })

  describe('/start', () => {
    it('binds the chat that pressed the link and names the citizen back', async () => {
      const desk = fakeTelegramDesk()
      const agentId = randomUUID() as AgentId
      desk.store.named(agentId, 'canary')
      const { token } = await desk.store.issueStart(agentId)

      const outcome = await handleTelegramUpdate(aPrivateMessage(`/start ${token}`), desk)

      expect(outcome).toMatchObject({ action: 'reply', chatId: CHAT })
      expect(outcome).toHaveProperty('text', expect.stringContaining('canary'))
      expect(desk.store.boundChatFor(agentId)).toBe(CHAT)
    })

    it('binds nothing when the payload is not a live token', async () => {
      const desk = fakeTelegramDesk()
      const agentId = randomUUID() as AgentId
      await desk.store.issueStart(agentId)

      const outcome = await handleTelegramUpdate(aPrivateMessage('/start invented'), desk)

      expect(outcome).toHaveProperty('text', expect.stringContaining('used already or has expired'))
      expect(desk.store.boundChatFor(agentId)).toBeUndefined()
    })

    it('binds nothing the second time the same link is pressed', async () => {
      const desk = fakeTelegramDesk()
      const agentId = randomUUID() as AgentId
      const { token } = await desk.store.issueStart(agentId)
      await handleTelegramUpdate(aPrivateMessage(`/start ${token}`), desk)

      const again = await handleTelegramUpdate(aPrivateMessage(`/start ${token}`, 9999), desk)

      expect(again).toHaveProperty('text', expect.stringContaining('used already or has expired'))
      // The first binding stands, so a spent link cannot move a citizen's channel.
      expect(desk.store.boundChatFor(agentId)).toBe(CHAT)
    })

    it('explains itself to somebody who found the bot without a link', async () => {
      const desk = fakeTelegramDesk()

      const outcome = await handleTelegramUpdate(aPrivateMessage('/start'), desk)

      expect(outcome).toHaveProperty('text', expect.stringContaining('operator page'))
    })
  })

  describe('a group chat', () => {
    it('is ignored entirely, and not even answered', async () => {
      const desk = fakeTelegramDesk()
      const agentId = randomUUID() as AgentId
      const { token } = await desk.store.issueStart(agentId)

      const outcome = await handleTelegramUpdate(
        { message: { chat: { id: -100_222, type: 'supergroup' }, text: `/start ${token}` } },
        desk,
      )

      // Answering would be worse than silence: a reply in a group tells everybody
      // in it that this chat talks to the Colony, and which citizens a stranger
      // in the room operates.
      expect(outcome).toEqual({ action: 'ignored', why: 'not a private chat' })
      expect(desk.store.boundChatFor(agentId)).toBeUndefined()
    })
  })

  describe('/stop', () => {
    it('unbinds the chat and says what will happen instead', async () => {
      const desk = fakeTelegramDesk()
      const agentId = randomUUID() as AgentId
      desk.store.named(agentId, 'canary')
      desk.store.bind(agentId, CHAT)

      const outcome = await handleTelegramUpdate(aPrivateMessage('/stop'), desk)

      expect(outcome).toHaveProperty('text', expect.stringContaining('email'))
      expect(outcome).toHaveProperty('text', expect.stringContaining('canary'))
      expect(desk.store.boundChatFor(agentId)).toBeUndefined()
    })

    it('says so plainly when there was nothing to stop', async () => {
      const desk = fakeTelegramDesk()

      const outcome = await handleTelegramUpdate(aPrivateMessage('/stop'), desk)

      expect(outcome).toHaveProperty('text', expect.stringContaining('nothing to stop'))
    })
  })

  describe('anything else', () => {
    it('tells a bound operator how to aim an answer, rather than saying nothing', async () => {
      const desk = fakeTelegramDesk()
      const agentId = randomUUID() as AgentId
      desk.store.bind(agentId, CHAT)

      const outcome = await handleTelegramUpdate(aPrivateMessage('yes, go ahead'), desk)

      // Silence reads as *sent* to somebody who has just typed an answer, and
      // that is the failure they would not notice. Since `#795` a reply means
      // something, so the sentence says what is missing — the message it answers
      // — rather than sending them to the page. Resolving *which* exchange from
      // recency is the rule that breaks on four citizens in one evening.
      expect(outcome).toHaveProperty('text', expect.stringContaining('reply to the message'))
    })

    it('tells an unbound chat that it is not bound', async () => {
      const desk = fakeTelegramDesk()

      const outcome = await handleTelegramUpdate(aPrivateMessage('hello?'), desk)

      expect(outcome).toHaveProperty('text', expect.stringContaining('not bound'))
    })

    it('ignores an update that is not a text message at all', async () => {
      const desk = fakeTelegramDesk()

      // Everything not named in `TelegramUpdate` is an update type this bot has
      // no use for, and acting on the parts of one it was not written for is how
      // a bot's behaviour ends up decided by whoever sends it one.
      expect(await handleTelegramUpdate({}, desk)).toEqual({
        action: 'ignored',
        why: 'not a message this bot reads',
      })
    })
  })
})
