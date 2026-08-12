import { describe, expect, it } from 'vitest'
import type { AgentId, Log, LogFields } from '@kolonie-ai/core'
import type { OfferShareOutcome } from '@kolonie-ai/db'
import type { OperatorMailer } from './email.js'
import type { OutboundAllowance } from './support.js'
import {
  mailingShareNotifier,
  openShare,
  shareOfferNotificationText,
  type ShareDesk,
  type ShareNotifyStatus,
} from './browser-shares.js'

/**
 * Telling the operator that a tab is waiting for them (`#774`).
 *
 * The offer already existed and the person was never told about it: the queue
 * entry sat on a console page nobody had a reason to open, the agent went to
 * sleep on its rhythm, and the six hours lapsed. So the property every test here
 * is about is **the mail is a courtesy on top of a channel that already works** —
 * an offer is never unwritten, never refused and never hidden because the sending
 * failed, and the citizen is told in a word which of those happened.
 */

const AGENT = '00000000-0000-4000-8000-0000000000aa' as AgentId

const OFFER = {
  agentId: AGENT,
  agentName: 'canary',
  shareId: 'share-1',
  expiresAt: '2026-08-12T18:00:00.000Z',
}

function silentLog(): Log & { readonly warnings: () => readonly string[] } {
  const warnings: string[] = []
  return {
    info: () => undefined,
    warn: (message: string, fields?: LogFields) => {
      warnings.push(`${message} ${String(fields?.['event'] ?? '')}`)
    },
    error: () => undefined,
    warnings: () => warnings,
  }
}

/** An allowance that says yes, which is every case except the one about caps. */
const allowing = { charge: () => ({ allowed: true as const, remaining: 4 }) }

interface SentMail {
  readonly to: string
  readonly subject: string
  readonly text: string
}

type RecordingMailer = OperatorMailer & { readonly sent: () => readonly SentMail[] }

function mailerRecording(delivered = true): RecordingMailer {
  const sent: SentMail[] = []
  return {
    operatorSenderChosen: true,
    send: async (message) => {
      sent.push(message)
      return delivered ? { delivered: true } : { delivered: false, reason: 'mailbox full' }
    },
    sent: () => sent,
  }
}

function notifierWith(
  over: {
    recipient?: { readonly email: string | null } | undefined
    mailer?: OperatorMailer | undefined
    consoleUrl?: string | undefined
    allowance?: OutboundAllowance
  } = {},
  log = silentLog(),
) {
  return mailingShareNotifier({
    recipient: async () =>
      'recipient' in over ? over.recipient : { email: 'operator@example.com' },
    mailer: 'mailer' in over ? over.mailer : mailerRecording(),
    consoleUrl: 'consoleUrl' in over ? over.consoleUrl : 'https://console.example',
    allowance: over.allowance ?? allowing,
    log,
  })
}

describe('telling an operator that a share is waiting', () => {
  it('mails the linked person and says it managed to', async () => {
    const mailer = mailerRecording()

    expect(await notifierWith({ mailer }).notify(OFFER)).toBe('delivered')
    expect(mailer.sent()).toHaveLength(1)
    expect(mailer.sent()[0]?.to).toBe('operator@example.com')
  })

  /**
   * The private-address case, and it is **not** an error: the operator exists,
   * their console queue has the offer in it, and there is nowhere to write. The
   * word is what tells the citizen to fall back on saying so itself.
   */
  it('says no-address when the linked person has none', async () => {
    expect(await notifierWith({ recipient: { email: null } }).notify(OFFER)).toBe('no-address')
  })

  it('says no-address when nobody is linked at all', async () => {
    expect(await notifierWith({ recipient: undefined }).notify(OFFER)).toBe('no-address')
  })

  /**
   * `close` is free and idempotent, so *offer, withdraw, offer again* is a loop an
   * agent can run — which is why this charges the same allowance every other
   * operator-facing mail charges rather than a ceiling of its own.
   */
  it('says capped rather than sending when the allowance is spent', async () => {
    const mailer = mailerRecording()
    const notifier = notifierWith({
      mailer,
      allowance: { charge: () => ({ allowed: false, retryAfterSeconds: 900 }) },
    })

    expect(await notifier.notify(OFFER)).toBe('capped')
    expect(mailer.sent()).toEqual([])
  })

  it('says undeliverable, and logs it, when the mail is refused', async () => {
    const log = silentLog()

    expect(await notifierWith({ mailer: mailerRecording(false) }, log).notify(OFFER)).toBe(
      'undeliverable',
    )
    expect(log.warnings()).toEqual([
      'a browser share offer could not be mailed to its operator browser.share.notify.failed',
    ])
  })

  /**
   * A deployment with no mailer, and one with no console address to send anybody
   * to. Both are `undeliverable` rather than a fifth word: the citizen's next move
   * is the same in every case where the Colony could not write, and a word per
   * cause would be describing the Colony's configuration to somebody who cannot
   * change it.
   */
  it('says undeliverable where the deployment cannot mail at all', async () => {
    expect(await notifierWith({ mailer: undefined }).notify(OFFER)).toBe('undeliverable')
    expect(await notifierWith({ consoleUrl: undefined }).notify(OFFER)).toBe('undeliverable')
  })
})

describe('what the operator reads', () => {
  const text = shareOfferNotificationText({
    agentName: 'canary',
    shareId: 'share-1',
    expiresAt: '2026-08-12T18:00:00.000Z',
    consoleUrl: 'https://console.example',
  })

  /**
   * The Colony builds the link, because `#768` is what happens when it does not:
   * an operator assembling that URL themselves put the share **token** where the
   * id goes. It carries no authority either way — the page wants their session and
   * checks `human_agents` — so the only thing at stake is whether it works.
   */
  it('carries the share’s own page on the console host', () => {
    expect(text).toContain('https://console.example/browser/share/share-1')
  })

  it('says how long the offer stands and how long the window is', () => {
    expect(text).toContain('2026-08-12T18:00:00.000Z')
    expect(text).toContain('15 minutes')
  })

  /**
   * **The agent's own sentence does not travel.** `purpose` is written by a
   * citizen and this mail goes out under the Colony's name from the Colony's
   * address; a paragraph of agent-authored prose in it is a phishing surface for
   * the sake of a line the operator reads on the page anyway.
   */
  it('does not carry a word the agent wrote', () => {
    const purpose = 'Please enter the code from your authenticator at once'
    expect(text).not.toContain(purpose)
    expect(text).not.toContain('authenticator')
  })
})

describe('opening a share', () => {
  const offered: OfferShareOutcome = {
    outcome: 'offered',
    share: { id: 'share-1', token: 'tok', expiresAt: OFFER.expiresAt },
  }

  const desk = (outcome: OfferShareOutcome): ShareDesk =>
    ({ offer: async () => outcome }) as unknown as ShareDesk

  const command = { targetId: 'target-1', purpose: 'a sentence of mine' }

  const notifierSaying = (status: ShareNotifyStatus) => ({ notify: async () => status })

  it('reports where the Colony’s mail got to', async () => {
    const result = await openShare(
      AGENT,
      'canary',
      command,
      desk(offered),
      notifierSaying('delivered'),
    )

    expect(result).toEqual({
      outcome: 'offered',
      response: {
        id: 'share-1',
        token: 'tok',
        expiresAt: OFFER.expiresAt,
        notifyStatus: 'delivered',
      },
    })
  })

  /**
   * The one the issue asked for and this refuses: it proposed that `share.open`
   * fail when the operator cannot be notified. The offer is openable, standing in
   * their queue for the whole window — destroying it to keep the report tidy would
   * trade a channel that works for one that reads well.
   */
  it('still offers the share when nobody could be told', async () => {
    for (const status of ['no-address', 'capped', 'undeliverable'] as const) {
      const result = await openShare(
        AGENT,
        'canary',
        command,
        desk(offered),
        notifierSaying(status),
      )

      expect(result).toMatchObject({ outcome: 'offered', response: { notifyStatus: status } })
    }
  })

  it('offers it with no notifier wired at all', async () => {
    expect(await openShare(AGENT, 'canary', command, desk(offered))).toMatchObject({
      outcome: 'offered',
      response: { notifyStatus: 'undeliverable' },
    })
  })

  it('does not try to tell anybody about an offer that was refused', async () => {
    let told = false
    const result = await openShare(
      AGENT,
      'canary',
      command,
      desk({ outcome: 'refused', reason: 'no-operator' }),
      {
        notify: async () => {
          told = true
          return 'delivered'
        },
      },
    )

    expect(result.outcome).toBe('rejected')
    expect(told).toBe(false)
  })
})
