import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { AgentId } from '@kolonie-ai/core'
import { fakeAutonomyMailer } from './__fixtures__/autonomy.js'
import { recordingLog } from './__fixtures__/console.js'
import { fakeTelegramDesk } from './__fixtures__/operator-telegram.js'
import { operatorVaultShareNotifier, vaultShareNotificationText } from './vault-share-notifier.js'

const AGENT_ID = randomUUID() as AgentId
const CHAT_ID = 3141
const PAGE_TOKEN = 'page-token-for-test'
const PLAINTEXT = 'sealed-value-sentinel'

const notification = {
  agentId: AGENT_ID,
  agentName: 'canary',
  purpose: 'Put a billing card on the account.',
}

const allowing = { charge: () => ({ allowed: true as const, remaining: 4 }) }

function notifierWith(over: Partial<Parameters<typeof operatorVaultShareNotifier>[0]> = {}) {
  return operatorVaultShareNotifier({
    recipient: async () => ({ email: 'mail-target' }),
    pageToken: async () => PAGE_TOKEN,
    mailer: fakeAutonomyMailer(),
    consoleUrl: '/console',
    allowance: allowing,
    log: recordingLog(),
    ...over,
  })
}

describe('telling an operator that a vault share is waiting', () => {
  it('uses a bound Telegram chat once, with the agent, purpose and durable link', async () => {
    const telegram = fakeTelegramDesk()
    const mailer = fakeAutonomyMailer()
    telegram.store.bind(AGENT_ID, CHAT_ID)

    const status = await notifierWith({ telegram, mailer }).notify(notification)

    expect(status).toBe('delivered')
    expect(telegram.bot.sent).toHaveLength(1)
    expect(mailer.sent()).toHaveLength(0)
    expect(telegram.bot.sent[0]?.text).toContain('canary')
    expect(telegram.bot.sent[0]?.text).toContain(notification.purpose)
    expect(telegram.bot.sent[0]?.text).toContain(`/operator/page/${PAGE_TOKEN}`)
    expect(telegram.bot.sent[0]?.text).not.toContain(PLAINTEXT)
  })

  it("uses the linked person's mail when no Telegram chat is bound", async () => {
    const mailer = fakeAutonomyMailer()

    expect(await notifierWith({ mailer }).notify(notification)).toBe('delivered')
    expect(mailer.sent()).toHaveLength(1)
    expect(mailer.sent()[0]?.text).toContain(notification.purpose)
    expect(mailer.sent()[0]?.text).toContain(`/operator/page/${PAGE_TOKEN}`)
    expect(mailer.sent()[0]?.text).not.toContain(PLAINTEXT)
  })

  it('reports no-address without sending when neither channel is bound', async () => {
    const mailer = fakeAutonomyMailer()

    const status = await notifierWith({ recipient: async () => ({ email: null }), mailer }).notify(
      notification,
    )

    expect(status).toBe('no-address')
    expect(mailer.sent()).toHaveLength(0)
  })

  it('reports capped without sending when the shared outbound allowance is spent', async () => {
    const mailer = fakeAutonomyMailer()

    const status = await notifierWith({
      mailer,
      allowance: { charge: () => ({ allowed: false, retryAfterSeconds: 900 }) },
    }).notify(notification)

    expect(status).toBe('capped')
    expect(mailer.sent()).toHaveLength(0)
  })

  it('does not spend the allowance when this deployment has no usable transport', async () => {
    let charged = 0

    expect(
      await notifierWith({
        mailer: undefined,
        allowance: {
          charge: () => {
            charged += 1
            return { allowed: true, remaining: 4 }
          },
        },
      }).notify(notification),
    ).toBe('undeliverable')
    expect(charged).toBe(0)
  })

  it('falls back to mail when Telegram refuses the same notification', async () => {
    const telegram = fakeTelegramDesk()
    const mailer = fakeAutonomyMailer()
    telegram.store.bind(AGENT_ID, CHAT_ID)
    telegram.bot.block()

    expect(await notifierWith({ telegram, mailer }).notify(notification)).toBe('delivered')
    expect(mailer.sent()).toHaveLength(1)
    expect((await telegram.store.bindingFor(AGENT_ID))?.unreachableAt).not.toBeNull()
  })

  it('still delivers to a bound Telegram chat when mail-address lookup fails', async () => {
    const telegram = fakeTelegramDesk()
    telegram.store.bind(AGENT_ID, CHAT_ID)

    expect(
      await notifierWith({
        telegram,
        recipient: async () => {
          throw new Error('mail lookup unavailable')
        },
      }).notify(notification),
    ).toBe('delivered')
    expect(telegram.bot.sent).toHaveLength(1)
  })

  it('reports undeliverable instead of throwing when a transport fails', async () => {
    const log = recordingLog()

    const status = await notifierWith({
      mailer: {
        operatorSenderChosen: true,
        send: async () => {
          throw new Error('transport failed')
        },
      },
      log,
    }).notify(notification)

    expect(status).toBe('undeliverable')
    expect(log.lines()).toEqual([
      expect.objectContaining({
        fields: expect.objectContaining({ event: 'vault.share.notify.failed' }),
      }),
    ])
    expect(JSON.stringify(log.lines())).not.toContain(notification.purpose)
    expect(JSON.stringify(log.lines())).not.toContain(PAGE_TOKEN)
  })
})

describe('what the notification says', () => {
  it('attributes the purpose to the agent and never invents a place for the value', () => {
    const text = vaultShareNotificationText({
      agentName: notification.agentName,
      purpose: notification.purpose,
      link: `/operator/page/${PAGE_TOKEN}`,
    })

    expect(text).toContain('canary')
    expect(text).toContain(notification.purpose)
    expect(text).toContain(`/operator/page/${PAGE_TOKEN}`)
    expect(text).not.toContain(PLAINTEXT)
  })
})
