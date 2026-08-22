import type { AgentId, Log, VaultShareNotifyStatus } from '@kolonie-ai/core'
import type { OperatorMailer } from './email.js'
import type { TelegramDesk } from './operator-telegram.js'
import type { OutboundAllowance } from './support.js'

/** The only share fields a notification can see; the sealed value is absent by shape. */
export interface VaultShareNotification {
  readonly agentId: AgentId
  readonly agentName: string
  /** Agent-authored text, attributed as such wherever it is sent. */
  readonly purpose: string
}

/**
 * The optional side effect above share storage, separated so API tests need no
 * mail server or Telegram bot and so a transport can never receive the value.
 */
export interface VaultShareNotifier {
  notify(notification: VaultShareNotification): Promise<VaultShareNotifyStatus>
}

/**
 * What the person reads when a vault entry is waiting (`#1575`).
 *
 * The purpose travels because it is the minimum context needed to decide whether
 * to open the page, and it is explicitly attributed to the agent. The value
 * cannot travel: it is not an input to this function or to the notifier port.
 */
export function vaultShareNotificationText(input: {
  readonly agentName: string
  readonly purpose: string
  readonly link: string
}): string {
  return [
    `Your agent ${input.agentName} shared a vault entry with you.`,
    '',
    `${input.agentName} says:`,
    input.purpose,
    '',
    'Open the entry and write back here:',
    input.link,
    '',
    'The Colony has not put the value in this message. Reading it remains a deliberate act on',
    'the operator page.',
  ].join('\n')
}

/**
 * Telegram where it is bound, then the linked person's mail, with one shared
 * outbound charge whichever channel carries the notification.
 *
 * A transport failure is reported and swallowed here as well as at the share
 * command boundary. That double boundary is deliberate: this adapter protects
 * every caller, and the command protects a future adapter from turning a
 * notification outage into a lost share.
 */
export function operatorVaultShareNotifier(deps: {
  readonly recipient: (agentId: AgentId) => Promise<{ readonly email: string | null } | undefined>
  readonly pageToken: (agentId: AgentId) => Promise<string | undefined>
  readonly telegram?: TelegramDesk | undefined
  readonly mailer?: OperatorMailer | undefined
  readonly consoleUrl?: string | undefined
  readonly allowance: OutboundAllowance
  readonly log: Log
}): VaultShareNotifier {
  const byMail = async (
    notification: VaultShareNotification,
    email: string,
    link: string,
  ): Promise<VaultShareNotifyStatus> => {
    if (deps.mailer === undefined) return 'undeliverable'

    const delivery = await deps.mailer.send({
      to: email,
      subject: `${notification.agentName} shared a vault entry with you`,
      text: vaultShareNotificationText({
        agentName: notification.agentName,
        purpose: notification.purpose,
        link,
      }),
    })

    if (delivery.delivered) return 'delivered'

    deps.log.warn('a vault share notification could not be mailed to its operator', {
      event: 'vault.share.notify.failed',
      channel: 'email',
      reason: delivery.reason === undefined ? 'unknown' : 'refused',
    })
    return 'undeliverable'
  }

  return {
    notify: async (notification) => {
      try {
        const base = deps.consoleUrl?.trim().replace(/\/+$/, '')
        if (base === undefined || base === '') return 'undeliverable'

        const token = await deps.pageToken(notification.agentId)
        if (token === undefined) return 'undeliverable'
        const link = `${base}/operator/page/${token}`

        const binding = await deps.telegram?.store.bindingFor(notification.agentId)
        const telegramBound = binding !== undefined && binding.unreachableAt === null

        if (telegramBound && binding !== undefined && deps.telegram !== undefined) {
          if (!deps.allowance.charge(notification.agentId).allowed) return 'capped'

          const sent = await deps.telegram.bot.send({
            chatId: binding.chatId,
            text: vaultShareNotificationText({
              agentName: notification.agentName,
              purpose: notification.purpose,
              link,
            }),
          })

          if (sent.delivered) return 'delivered'
          if (sent.blocked) await deps.telegram.store.markUnreachable(binding.chatId)

          deps.log.warn('a vault share notification fell back from Telegram', {
            event: 'vault.share.notify.fallback',
            reason: sent.blocked ? 'blocked' : 'unreachable',
            channelEnded: sent.blocked,
          })

          const operator = await deps.recipient(notification.agentId)
          if (operator?.email === null || operator === undefined || deps.mailer === undefined) {
            return 'undeliverable'
          }

          return await byMail(notification, operator.email, link)
        }

        const operator = await deps.recipient(notification.agentId)
        if (operator?.email === null || operator === undefined) return 'no-address'
        if (deps.mailer === undefined) return 'undeliverable'
        if (!deps.allowance.charge(notification.agentId).allowed) return 'capped'

        return await byMail(notification, operator.email, link)
      } catch (error) {
        deps.log.warn('a vault share notification failed', {
          event: 'vault.share.notify.failed',
          channel: 'unknown',
          reason: error instanceof Error ? error.name : 'unknown',
        })
        return 'undeliverable'
      }
    },
  }
}
