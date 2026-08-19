import { randomUUID } from 'node:crypto'
import type { AgentId, ConversationId } from '@kolonie-ai/core'
import { createLog } from '@kolonie-ai/core'
import { describe, expect, it, vi } from 'vitest'
import type { OperatorNotification, OperatorNotifier } from './operator-notifier.js'
import {
  notifyOperatorAboutThread,
  UNNAMED_THREAD_CONTEXT,
  type OperatorThreadNotifyDependencies,
} from './operator-thread-notify.js'

const quiet = () => ({ ...createLog({ service: 'test' }), warn: vi.fn(), info: vi.fn() })

const aThread = () => ({
  agentId: randomUUID() as AgentId,
  agentName: 'canary',
  conversationId: randomUUID() as ConversationId,
})

/** A notifier that records what it was asked to send, and says it went. */
const recording = (): OperatorNotifier & { readonly sent: OperatorNotification[] } => {
  const sent: OperatorNotification[] = []
  return {
    sent,
    notify: async (notification) => {
      sent.push(notification)
      return { delivered: true, transport: 'email' }
    },
  }
}

const wired = (
  over: Partial<OperatorThreadNotifyDependencies> = {},
): OperatorThreadNotifyDependencies & { readonly log: ReturnType<typeof quiet> } => {
  const log = quiet()
  return {
    notifier: recording(),
    pageBaseUrl: 'https://console.example.org',
    log,
    recipient: async () => ({ operatorAddress: 'op@example.org', pageToken: 'a-token' }),
    context: async () => 'browser-capability',
    ...over,
    // `over` may replace the log; keep the one this returns the same object.
    ...(over.log === undefined ? { log } : {}),
  } as OperatorThreadNotifyDependencies & { readonly log: ReturnType<typeof quiet> }
}

describe('telling an operator their citizen opened a thread (#1321)', () => {
  it('pings the address on the page the operator already holds', async () => {
    const notifier = recording()
    const deps = wired({ notifier })
    const thread = aThread()

    await notifyOperatorAboutThread(thread, deps)

    expect(notifier.sent).toHaveLength(1)
    expect(notifier.sent[0]).toMatchObject({
      agentId: thread.agentId,
      agentName: 'canary',
      context: 'browser-capability',
      address: 'op@example.org',
      subject: { kind: 'conversation', conversationId: thread.conversationId },
    })
  })

  /**
   * **No new link** (`#236`). A fresh single-use URL per thread would put one
   * more leakable credential in an inbox every time an agent needed something,
   * for no gain over the page they already have.
   */
  it('links the durable page and mints nothing', async () => {
    const notifier = recording()

    await notifyOperatorAboutThread(aThread(), wired({ notifier }))

    expect(notifier.sent[0]?.link).toBe('https://console.example.org/operator/page/a-token')
  })

  it('names a thread about nothing in particular rather than sending an empty subject', async () => {
    const notifier = recording()

    await notifyOperatorAboutThread(aThread(), wired({ notifier, context: async () => undefined }))

    expect(notifier.sent[0]?.context).toBe(UNNAMED_THREAD_CONTEXT)
  })

  /**
   * The acceptance criterion `#1321` states as *messaging row still exists*: the
   * thread is written before this runs, so every failure here is degraded rather
   * than thrown. A citizen told its message may not have been seen would open a
   * second thread about the same thing.
   */
  describe('when the Colony cannot reach anybody', () => {
    it('says so in the log and throws nothing when no mailer is configured', async () => {
      const deps = wired({ notifier: undefined })

      await expect(notifyOperatorAboutThread(aThread(), deps)).resolves.toBeUndefined()
      expect(deps.log.warn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ event: 'operator.thread.notify.unconfigured' }),
      )
    })

    it('throws nothing when the citizen has no live page', async () => {
      const notifier = recording()
      const deps = wired({ notifier, recipient: async () => undefined })

      await expect(notifyOperatorAboutThread(aThread(), deps)).resolves.toBeUndefined()
      expect(notifier.sent).toHaveLength(0)
      expect(deps.log.info).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ event: 'operator.thread.notify.no-page' }),
      )
    })

    it('logs an undelivered ping without failing the send', async () => {
      const deps = wired({
        notifier: {
          notify: async () => ({ delivered: false, transport: 'email', reason: 'desk down' }),
        },
      })

      await expect(notifyOperatorAboutThread(aThread(), deps)).resolves.toBeUndefined()
      expect(deps.log.warn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ event: 'operator.thread.notify.undelivered' }),
      )
    })

    /** The case the exchange path never had: a transport that throws. */
    it('swallows a throwing transport', async () => {
      const deps = wired({
        notifier: {
          notify: async () => {
            throw new TypeError('fetch failed')
          },
        },
      })

      await expect(notifyOperatorAboutThread(aThread(), deps)).resolves.toBeUndefined()
      expect(deps.log.warn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ event: 'operator.thread.notify.failed', reason: 'TypeError' }),
      )
    })

    /** Nothing about the operator's address reaches a log line. */
    it('never writes the address into a log field', async () => {
      const deps = wired({
        notifier: {
          notify: async () => ({ delivered: false, transport: 'email', reason: 'desk down' }),
        },
      })

      await notifyOperatorAboutThread(aThread(), deps)

      const calls = (deps.log.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls
      expect(JSON.stringify(calls)).not.toContain('op@example.org')
    })
  })
})
