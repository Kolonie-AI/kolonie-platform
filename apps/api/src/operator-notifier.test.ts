import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { AgentId, ConversationId } from '@kolonie-ai/core'
import { createLog } from '@kolonie-ai/core'
import {
  mailingOperatorNotifier,
  operatorMessageNotificationSubject,
  operatorMessageNotificationText,
  operatorNotifierFor,
  telegramNotificationText,
  telegramOrMailingOperatorNotifier,
} from './operator-notifier.js'
import { fakeAutonomyMailer } from './__fixtures__/autonomy.js'
import { httpTelegramBot } from './operator-telegram.js'
import { fakeTelegramDesk } from './__fixtures__/operator-telegram.js'

const CHAT = 3141

const anAsk = (agentId: AgentId) => ({
  agentId,
  subject: { kind: 'conversation' as const, conversationId: randomUUID() as ConversationId },
  agentName: 'canary',
  context: 'browser-capability',
  link: 'https://console.example.org/operator/page/a-token#exchange-1',
  address: 'op@example.org',
})

/** The same ping, about a messaging thread rather than an exchange (`#1321`). */
const aThread = (agentId: AgentId) => ({
  agentId,
  subject: { kind: 'conversation' as const, conversationId: randomUUID() as ConversationId },
  agentName: 'canary',
  context: 'browser-capability',
  link: 'https://console.example.org/operator/page/a-token',
  address: 'op@example.org',
})

/** Silent, so a fallback under test does not print through the suite. */
const quiet = () => ({ ...createLog({ service: 'test' }), warn: vi.fn(), info: vi.fn() })

describe('how an operator is reached about one ask (#794)', () => {
  describe('which implementation gets built', () => {
    /**
     * **The rejection case `#794` names**: with the environment unset the mail
     * path is the only one constructed. Asserted by reaching the bot — a desk
     * that had been built and merely declined would still have been asked.
     */
    it('builds the mail path and nothing else', async () => {
      const mailer = fakeAutonomyMailer()
      const desk = fakeTelegramDesk()
      const agentId = randomUUID() as AgentId
      desk.store.bind(agentId, CHAT)

      const notifier = operatorNotifierFor({ mailer, log: quiet() })
      const sent = await notifier.notify(anAsk(agentId))

      // Bound in a desk this notifier was never handed. If the construction had
      // branched at send time instead, this would have gone to Telegram.
      expect(sent.transport).toBe('email')
      expect(desk.bot.sent).toHaveLength(0)
    })

    it('takes the Telegram path when it is handed a desk', async () => {
      const mailer = fakeAutonomyMailer()
      const desk = fakeTelegramDesk()
      const agentId = randomUUID() as AgentId
      desk.store.bind(agentId, CHAT)

      const sent = await operatorNotifierFor({ mailer, telegram: desk, log: quiet() }).notify(
        anAsk(agentId),
      )

      expect(sent.transport).toBe('telegram')
    })
  })

  describe('with no Telegram desk, which is what runs today', () => {
    it('sends the mail, exactly as before', async () => {
      const mailer = fakeAutonomyMailer()
      const agentId = randomUUID() as AgentId

      const sent = await mailingOperatorNotifier(mailer).notify(anAsk(agentId))

      expect(sent).toMatchObject({ delivered: true, transport: 'email' })
      expect(mailer.sent()).toHaveLength(1)
      expect(mailer.sent()[0]?.to).toBe('op@example.org')
    })

    it('reports an undelivered mail as undelivered', async () => {
      const mailer = fakeAutonomyMailer(false)

      const sent = await mailingOperatorNotifier(mailer).notify(anAsk(randomUUID() as AgentId))

      expect(sent.delivered).toBe(false)
      expect(sent.transport).toBe('email')
    })
  })

  describe('with a desk', () => {
    const wired = () => {
      const desk = fakeTelegramDesk()
      const mailer = fakeAutonomyMailer()
      const log = quiet()
      return {
        desk,
        mailer,
        log,
        notifier: telegramOrMailingOperatorNotifier({ telegram: desk, mailer, log }),
      }
    }

    it('messages a bound operator on Telegram, and sends no mail', async () => {
      const { desk, mailer, notifier } = wired()
      const agentId = randomUUID() as AgentId
      desk.store.bind(agentId, CHAT)

      const sent = await notifier.notify(anAsk(agentId))

      expect(sent).toMatchObject({ delivered: true, transport: 'telegram' })
      expect(desk.bot.sent).toHaveLength(1)
      // One channel per ask, never both. A second copy on another channel is a
      // reminder by another name, and the rule is exactly one per ask.
      expect(mailer.sent()).toHaveLength(0)
    })

    /**
     * **The rejection case `#794` names.** An operator who never bound anything
     * is mailed exactly as today, and the Telegram implementation is not reached
     * at all — not called and told no, not called.
     */
    it('mails an operator with no binding, and never calls the bot', async () => {
      const { desk, mailer, notifier } = wired()

      const sent = await notifier.notify(anAsk(randomUUID() as AgentId))

      expect(sent).toMatchObject({ delivered: true, transport: 'email' })
      expect(desk.bot.sent).toHaveLength(0)
      expect(mailer.sent()).toHaveLength(1)
    })

    it('mails an operator whose chat is already known to be unreachable', async () => {
      const { desk, mailer, notifier } = wired()
      const agentId = randomUUID() as AgentId
      desk.store.bind(agentId, CHAT)
      await desk.store.markUnreachable(CHAT)

      const sent = await notifier.notify(anAsk(agentId))

      expect(sent.transport).toBe('email')
      expect(desk.bot.sent).toHaveLength(0)
      expect(mailer.sent()).toHaveLength(1)
    })

    describe('when Telegram refuses', () => {
      it('falls back to mail for the same ask, and ends the channel', async () => {
        const { desk, mailer, notifier } = wired()
        const agentId = randomUUID() as AgentId
        desk.store.bind(agentId, CHAT)
        desk.bot.block()

        const sent = await notifier.notify(anAsk(agentId))

        // The same ask and not the next one: a recorded failure that only logged
        // would leave this operator un-notified while the flag sat in a column.
        expect(sent).toMatchObject({ delivered: true, transport: 'email' })
        expect(mailer.sent()).toHaveLength(1)
        expect((await desk.store.bindingFor(agentId))?.unreachableAt).not.toBeNull()
      })

      it('sends the next ask by mail without anybody intervening', async () => {
        const { desk, mailer, notifier } = wired()
        const agentId = randomUUID() as AgentId
        desk.store.bind(agentId, CHAT)
        desk.bot.block()

        await notifier.notify(anAsk(agentId))
        await notifier.notify(anAsk(agentId))

        expect(mailer.sent()).toHaveLength(2)
        expect(desk.bot.sent).toHaveLength(0)
      })

      it('logs the fallback at warn, with a reason class and no address', async () => {
        const { desk, log, notifier } = wired()
        const agentId = randomUUID() as AgentId
        desk.store.bind(agentId, CHAT)
        desk.bot.block()

        await notifier.notify(anAsk(agentId))

        // `gateway.ts`'s rule: a fallback is not routine, and every one is
        // answerable afterwards rather than invisible.
        expect(log.warn).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ event: 'operator.notify.fallback', reason: 'blocked' }),
        )
        const [, fields] = (log.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!
        expect(JSON.stringify(fields)).not.toContain('op@example.org')
        expect(JSON.stringify(fields)).not.toContain(String(CHAT))
      })
    })

    /**
     * **A thread is the same ping over a different subject** (`#1321`). The
     * notifier does not care which, and the one thing that has to differ is
     * where a reply resolves to — recorded against the conversation rather than
     * against an exchange, so `answerMessageFromChat` can find it.
     */
    describe('about a messaging thread', () => {
      it('records the message against the conversation, not against an exchange', async () => {
        const { desk, notifier } = wired()
        const agentId = randomUUID() as AgentId
        desk.store.bind(agentId, CHAT)
        const ping = aThread(agentId)
        desk.store.ownsThread(ping.subject.conversationId, agentId)

        const sent = await notifier.notify(ping)
        expect(sent).toMatchObject({ delivered: true, transport: 'telegram' })

        const messageId = desk.bot.sent.length
        const answered = await desk.store.answerMessageFromChat({
          chatId: CHAT,
          replyToMessageId: messageId,
          body: 'Go ahead.',
        })

        expect(answered).toMatchObject({ outcome: 'answered', agentId })
      })
    })
  })

  /**
   * **The frozen default the mail may not break** (epic `#1318`, decision 5):
   * an unread ping and never the body. A citizen writes to its operator through
   * an inbox now, so a mail that quoted the message would put those words in a
   * third party's mail store forever.
   */
  describe('what the mail about a thread says', () => {
    it('names the citizen and the subject, and carries no message text', async () => {
      const mailer = fakeAutonomyMailer()
      const agentId = randomUUID() as AgentId

      await mailingOperatorNotifier(mailer).notify(aThread(agentId))

      const [mail] = mailer.sent()
      expect(mail?.subject).toContain('canary')
      expect(mail?.text).toContain('browser-capability')
      expect(mail?.text).toContain('https://console.example.org/operator/page/a-token')
    })

    it('says nothing about being stuck, which is the exchange mail', async () => {
      const mailer = fakeAutonomyMailer()

      await mailingOperatorNotifier(mailer).notify(aThread(randomUUID() as AgentId))

      expect(mailer.sent()[0]?.subject).not.toContain('stuck')
    })
  })

  /**
   * The Bot API itself, behind a `fetch` double — no test here talks to Telegram.
   *
   * **The token is in the URL because the Bot API has no other way to carry it**,
   * which makes *never log a URL* a property worth asserting rather than
   * assuming: a `warn` line naming the address it failed to reach would publish a
   * live credential into a public log, and it would be one line of well-meant
   * debugging away at any time.
   */
  describe('the Bot API', () => {
    const TOKEN = '1234567:a-secret-bot-token'

    const withFetch = (response: Response) => {
      const calls: string[] = []
      const log = quiet()
      const fetching = vi.fn(async (url: unknown) => {
        calls.push(String(url))
        return response
      })
      vi.stubGlobal('fetch', fetching)
      return { calls, log, bot: httpTelegramBot({ token: TOKEN, username: 'KolonieDeskBot', log }) }
    }

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('reports a 403 as blocked, and puts no token in the log', async () => {
      const { bot, log } = withFetch(new Response('', { status: 403 }))

      const sent = await bot.send({ chatId: CHAT, text: 'anything' })

      expect(sent).toMatchObject({ delivered: false, blocked: true })
      expect(log.warn).toHaveBeenCalled()
      expect(
        JSON.stringify((log.warn as unknown as { mock: { calls: unknown[] } }).mock.calls),
      ).not.toContain(TOKEN)
    })

    it('reports a 500 as a failure that is not the person blocking anything', async () => {
      const { bot } = withFetch(new Response('', { status: 500 }))

      // A server error is not a decision the operator made, so the channel stays
      // on. Marking a working chat dead on one outage would be worse than it.
      expect(await bot.send({ chatId: CHAT, text: 'anything' })).toMatchObject({
        delivered: false,
        blocked: false,
      })
    })

    it('carries the token to Telegram and nowhere else', async () => {
      const { bot, calls } = withFetch(new Response('{}', { status: 200 }))

      await bot.send({ chatId: CHAT, text: 'anything' })

      expect(calls).toHaveLength(1)
      expect(calls[0]).toContain('api.telegram.org')
    })
  })

  describe('what a Telegram message carries', () => {
    const text = telegramNotificationText({
      agentName: 'canary',
      context: 'browser-capability',
      link: 'https://console.example.org/operator/page/a-token#exchange-1',
    })

    it('names the citizen, what it is about, and the page', () => {
      expect(text).toContain('canary')
      expect(text).toContain('browser-capability')
      expect(text).toContain('/operator/page/a-token')
    })

    it('reads as the Colony writing about a citizen, never as the citizen writing', () => {
      // An operator must be able to tell those apart, which is the same rule the
      // citizen's own side has.
      expect(text).toContain('has run into something it cannot do without you')
      expect(text).not.toMatch(/^I /m)
    })

    it('promises a ceiling rather than a total, as the mail does (#1451)', () => {
      /**
       * It used to say *the only message the Colony will send about it*, which
       * was true and was the defect: sixteen threads had an agent message newer
       * than the operator's last reply and nobody had been told. What is
       * promised now is *at most one a day per thread*.
       */
      expect(text).toContain('at most one of these a day per thread')
      expect(text).not.toContain('only message the Colony will send')
    })
  })
})

/**
 * What the mail says, after `#1451` changed the rule behind it.
 *
 * The issue asks for a mail that names *the agent, the thread and one line of
 * what was said*. **The first two are here and the third deliberately is not**,
 * and that is a conflict between two decisions rather than an omission:
 * `#1318` decision 5 keeps a citizen's words out of a third party's mail store
 * for ever, and quoting a line of every message would undo it on every send.
 * What the issue wanted the line *for* — *a person who gets three of these
 * should be able to tell from the subject lines alone which to open first* — is
 * what the subject line now does, by naming the thread instead of the words.
 */
describe('what the mail says (#1451)', () => {
  const notification = {
    agentName: 'canary',
    context: 'a mailbox at mail.example',
    link: 'https://console.example.org/inbox',
    pageLink: 'https://console.example.org/operator/page/a-token',
  }

  it('tells three apart by their subject lines', () => {
    const one = operatorMessageNotificationSubject(notification)
    const two = operatorMessageNotificationSubject({ ...notification, context: 'the domain' })
    const three = operatorMessageNotificationSubject({ ...notification, agentName: 'ariadne' })

    expect(one).toContain('canary')
    expect(one).toContain('a mailbox at mail.example')
    expect(new Set([one, two, three]).size).toBe(3)
  })

  it('does not quote what the citizen said', () => {
    const text = operatorMessageNotificationText(notification)

    // The one thing this text may not do (`#1318` decision 5). There is no
    // parameter to put a message body in, which is a stronger statement than
    // not using one.
    expect(text).not.toContain('what it said in this mail. It is on')
    expect(text).toContain('does not put what it said in this mail')
  })

  it('leads with the inbox and carries the page for somebody with no account', () => {
    const text = operatorMessageNotificationText(notification)

    expect(text.indexOf('/inbox')).toBeLessThan(text.indexOf('/operator/page/a-token'))
    expect(text).toContain('needs no account')
  })

  it('names only the inbox when there is no page to name', () => {
    const text = operatorMessageNotificationText({ ...notification, pageLink: undefined })

    expect(text).toContain('/inbox')
    expect(text).not.toContain('/operator/page/')
    // And no dangling sentence introducing a link that is not there.
    expect(text).not.toContain('needs no account')
  })

  it('promises a ceiling rather than a total', () => {
    const text = operatorMessageNotificationText(notification)

    expect(text).toContain('not mail you about this thread more than once a day')
    expect(text).toContain('once you have read it, or if you mute it')
    expect(text).not.toContain('there is no reminder and no follow-up')
  })
})
