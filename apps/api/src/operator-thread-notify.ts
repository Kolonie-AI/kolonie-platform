import type { AgentId, ConversationId, Log } from '@kolonie-ai/core'
import type { OperatorNotification, OperatorNotifier } from './operator-notifier.js'

/**
 * Telling a person that their citizen has written to them (`#1321`, epic `#1318`).
 *
 * ## Why this exists beside `operator-requests.ts` rather than inside it
 *
 * The exchange path opens a row and notifies in one function, and it can: the
 * row and the notification are the same act there. Messaging is a general
 * surface that also carries citizen mail and Colony mail, and neither of those
 * pings anybody — so the notify is a thing done *to one kind of send* rather
 * than a step in sending. Keeping it here is what stops a later edit to
 * `messaging.send` from mailing an operator about a citizen DM.
 *
 * ## At most once a day, and never into a thread they are reading
 *
 * Until `#1451` this carried `operator_addresses`' rule unchanged — *one ping
 * per thread, and never on a reply* — which the caller expressed by passing
 * `opened`, set by storage only when the send created the conversation. It
 * protected against a real thing, an agent costing a person five mails in an
 * afternoon, and it did so by never telling them anything after the first
 * message. Measured in production on 2026-08-20: **sixteen threads had an agent
 * message newer than the operator's last reply and nobody had been told about
 * any of them.**
 *
 * The predicate is now `claimOperatorNotification` in the store, which decides
 * and stamps in one statement: from somebody else, into an unread thread, not
 * muted, and nothing sent about it in the last day. The flood case is unchanged
 * — four messages into a thread opened this morning is still one mail — and the
 * silent case is fixed.
 *
 * **The decision is not made here**, and that is deliberate: unread is a cursor,
 * mute is a column, and both are read under the same lock that writes the
 * stamp. A predicate split between the store and this file would be one that
 * two concurrent sends could both pass.
 *
 * ## A failure here never fails the send
 *
 * The messaging row is written first and this runs after it, so a mail desk that
 * is down leaves a thread the operator can still read on the page they hold. It
 * is logged at `warn` with a reason class and nothing else — the same shape
 * `telegramOrMailingOperatorNotifier` logs a fallback with, and for the same
 * reason: *the desk was down for two hours* has to be answerable afterwards.
 *
 * **It is deliberately not reported to the citizen.** The exchange path refuses
 * the open when the mail does not go, because there the ask *was* the mail;
 * here the thread exists either way and telling an agent that its message may
 * not have been seen would send it to open a second one.
 */
export interface OperatorThreadNotifyDependencies {
  readonly notifier?: OperatorNotifier | undefined
  readonly pageBaseUrl?: string | undefined
  readonly log: Log
  /** Where an answer may be written, and to whom the ping goes. */
  recipient(
    agentId: AgentId,
  ): Promise<{ readonly operatorAddress: string; readonly pageToken: string } | undefined>
  /** What the thread is about, or `undefined` for one about nothing in particular. */
  context(conversationId: ConversationId): Promise<string | undefined>
}

/** What a thread with no task and no wish is called in a subject line. */
export const UNNAMED_THREAD_CONTEXT = 'something it did not name'

export async function notifyOperatorAboutThread(
  input: {
    readonly agentId: AgentId
    readonly agentName: string
    readonly conversationId: ConversationId
  },
  deps: OperatorThreadNotifyDependencies,
): Promise<void> {
  if (deps.notifier === undefined || deps.pageBaseUrl === undefined) {
    deps.log.warn('a citizen opened an operator thread and the Colony could not send mail', {
      event: 'operator.thread.notify.unconfigured',
    })
    return
  }

  const recipient = await deps.recipient(input.agentId)
  if (recipient === undefined) {
    /**
     * No live page, so there is no address and nowhere to point. Not an error:
     * a citizen may message its operator before ever issuing one, and the thread
     * is waiting for them whenever they do.
     */
    deps.log.info('an operator thread was opened by a citizen with no live page', {
      event: 'operator.thread.notify.no-page',
    })
    return
  }

  const context = (await deps.context(input.conversationId)) ?? UNNAMED_THREAD_CONTEXT

  const base = deps.pageBaseUrl.replace(/\/+$/, '')

  const notification: OperatorNotification = {
    agentId: input.agentId,
    subject: { kind: 'conversation', conversationId: input.conversationId },
    agentName: input.agentName,
    context,
    /**
     * The inbox (`#1451`), and the durable page beside it.
     *
     * **Still no new link** (`#236`): both of these are surfaces the person
     * already has. What changed is which one leads — the inbox shows every
     * agent at once, which is what somebody with three of them wants — and the
     * page is carried second because it is the one that needs no account.
     */
    link: `${base}/inbox`,
    pageLink: `${base}/operator/page/${recipient.pageToken}`,
    address: recipient.operatorAddress,
  }

  try {
    const delivery = await deps.notifier.notify(notification)
    if (!delivery.delivered) {
      deps.log.warn('an operator could not be told about a thread their citizen opened', {
        event: 'operator.thread.notify.undelivered',
        transport: delivery.transport,
        reason: delivery.reason ?? 'unknown',
      })
    }
  } catch (error) {
    /**
     * A throwing transport is the case the exchange path never had to handle,
     * because there the send was awaited by a caller that could refuse. Here it
     * would take down a `messages.send` whose row is already written.
     */
    deps.log.warn('telling an operator about a thread threw', {
      event: 'operator.thread.notify.failed',
      reason: error instanceof Error ? error.name : 'unknown',
    })
  }
}
