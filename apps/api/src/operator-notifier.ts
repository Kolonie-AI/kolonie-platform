import type { AgentId, ConversationId, Log } from '@kolonie-ai/core'
import type { OperatorMailer } from './email.js'
import type { TelegramDesk } from './operator-telegram.js'

/**
 * How the Colony reaches an operator about one ask (`#794`).
 *
 * ## A transport swap and nothing else
 *
 * Same trigger, same content, same reply surface. The operator still answers
 * **into the durable page** — `operator-requests.ts` states why, and it is the
 * security decision this whole surface rests on: *"the agent never reads an
 * inbox, so text written by whoever felt like writing to it cannot arrive as an
 * instruction — the injection surface is absent rather than defended."* Telegram
 * does not touch that. Answering *in* Telegram is `#795`, and it keeps the
 * property by only accepting text from a chat the Colony bound itself.
 *
 * ## A port with two implementations, resolved once at wiring time
 *
 * Not an `if` inside the request path. That is how one of two branches quietly
 * stops being tested — and it is the shape `OperatorMailer` already has, for the
 * same reason.
 *
 * ## One channel per ask, never both
 *
 * `operator_addresses`' own rule is *exactly one mail per ask and never a
 * reminder*, and a second copy on another channel is a reminder by another name.
 * So {@link OperatorNotifier} answers with the transport it used, and the caller
 * charges once whatever that was.
 */

export type NotifiedTransport = 'telegram' | 'email'

/**
 * What the ping is about, and where a reply to it goes (`#795`, `#1321`).
 *
 * Carried so a Telegram send can be recorded against it — the message the Colony
 * sends is what a reply will name, and without the pair there is nothing for
 * `reply_to_message` to resolve to.
 *
 * **One kind since `#1325`.** It carried an exchange member while the epic ran
 * both channels; the notifier never cared which, and neither did the mail.
 */
export type NotificationSubject = {
  readonly kind: 'conversation'
  readonly conversationId: ConversationId
}

export interface OperatorNotification {
  readonly agentId: AgentId
  readonly subject: NotificationSubject
  readonly agentName: string
  /** What the ask is about — the same context line the page shows. */
  readonly context: string
  /**
   * Where to go and read it. Always carried.
   *
   * Since `#1451` this is the inbox for a person who has a console account, and
   * the durable page for one who does not — decided by the caller, because the
   * caller is what knows whether a page token was resolved.
   */
  readonly link: string
  /**
   * The durable page, when the link above is the inbox (`#1451`).
   *
   * **Both, because they are reached differently.** The inbox needs a signed-in
   * console account; the durable page needs nothing but the link. An operator
   * who has only ever held the page would be stranded by a mail that named only
   * the inbox, and one who has an account should be sent to the surface that
   * shows every agent at once.
   */
  readonly pageLink?: string | undefined
  /** Where mail goes. Resolved by the caller, because it resolves the page too. */
  readonly address: string
}

export interface OperatorNotified {
  readonly delivered: boolean
  /** What actually carried it, which is not always what was tried first. */
  readonly transport: NotifiedTransport
  readonly reason?: string | undefined
}

export interface OperatorNotifier {
  notify(notification: OperatorNotification): Promise<OperatorNotified>
}

/**
 * What a Telegram message says, and what it deliberately does not.
 *
 * - Which citizen is asking, what it is about, and the link.
 * - **Never the request body.** A Telegram message is stored on a third party's
 *   servers and shown on a lock screen; the durable page is where the ask is,
 *   behind a link, exactly as the mail arrangement already has it.
 * - It reads as **the Colony writing about a citizen**, never as the citizen
 *   writing. An operator must be able to tell those apart, which is the same rule
 *   the citizen's own side has — a citizen that could not tell Colony prose from
 *   its operator's would have no standing to refuse an instruction that crossed a
 *   red line.
 */
export function telegramNotificationText(input: {
  readonly agentName: string
  readonly context: string
  readonly link: string
}): string {
  return [
    `${input.agentName} has run into something it cannot do without you, while working on`,
    `"${input.context}".`,
    '',
    'What it needs is waiting for you here:',
    input.link,
    '',
    // `#1451`: a ceiling rather than a total. Saying *the only message* was
    // true and was the defect — a reply to a thread answered last week reached
    // nobody at all.
    'Answer there in your own words. The Colony sends at most one of these a day per thread.',
  ].join('\n')
}

/** Mail only — every deployment that has no bot, which is all of them by default. */
export function mailingOperatorNotifier(mailer: OperatorMailer): OperatorNotifier {
  return {
    notify: async (notification) => {
      const delivery = await mailer.send({
        to: notification.address,
        subject: operatorMessageNotificationSubject(notification),
        text: operatorMessageNotificationText(notification),
      })

      return {
        delivered: delivery.delivered,
        transport: 'email',
        ...(delivery.reason === undefined ? {} : { reason: delivery.reason }),
      }
    },
  }
}

/**
 * Telegram where the operator bound it, mail where they did not — and mail
 * whenever Telegram refuses.
 *
 * **The fallback is the same ask and not the next one.** A recorded failure that
 * only logs would leave this operator un-notified while the flag sat in a column;
 * the transition costs nothing precisely because the message goes out by mail
 * before the caller ever hears about it.
 *
 * **`blocked` and *anything else* are different facts and are treated
 * differently.** A `403` is the person's own decision and is permanent for that
 * chat, so it writes `unreachable_at` and no later ask tries Telegram again until
 * they rebind. A timeout is the network, and marking a working chat dead on one
 * would be worse than the outage.
 *
 * Every fallback is logged at `warn` with its reason class, on the rule
 * `packages/core/src/llm/gateway.ts` sets: *a fallback is not routine*, and
 * *the desk was down for two hours* has to be answerable afterwards rather than
 * invisible. `kolonie-docs#312` is what makes a burst of them reach a person.
 */
export function telegramOrMailingOperatorNotifier(deps: {
  readonly telegram: TelegramDesk
  readonly mailer: OperatorMailer
  readonly log: Log
}): OperatorNotifier {
  const byMail = mailingOperatorNotifier(deps.mailer)

  return {
    notify: async (notification) => {
      const binding = await deps.telegram.store.bindingFor(notification.agentId)

      // No binding, or one the Colony already knows it cannot write to. Mail is
      // not a degraded answer here: it is the channel this operator has.
      if (binding === undefined || binding.unreachableAt !== null) {
        return byMail.notify(notification)
      }

      const sent = await deps.telegram.bot.send({
        chatId: binding.chatId,
        text: telegramNotificationText(notification),
      })

      if (sent.delivered) {
        /**
         * Remember which message this ask went out as, so a reply to it can be
         * resolved (`#795`).
         *
         * **Only on a delivered send, and only when Telegram named the message.**
         * A row written for a send that failed would make a reply resolvable to
         * a thread nobody was told about; a send with no id back is delivered
         * all the same, and the operator answers on the page — which the message
         * always carries.
         */
        if (sent.messageId !== undefined) {
          await deps.telegram.store.recordMessageAsk({
            conversationId: notification.subject.conversationId,
            chatId: binding.chatId,
            messageId: sent.messageId,
          })
        }

        return { delivered: true, transport: 'telegram' }
      }

      if (sent.blocked) await deps.telegram.store.markUnreachable(binding.chatId)

      deps.log.warn('an operator could not be reached on Telegram — sending mail instead', {
        event: 'operator.notify.fallback',
        // The reason class and never the message, the address or the chat: this
        // line is read in a public log, and what a query needs is which class of
        // failure this was and whether the channel is now off.
        reason: sent.blocked ? 'blocked' : (sent.reason ?? 'unreachable'),
        channelEnded: sent.blocked,
      })

      return byMail.notify(notification)
    },
  }
}

/**
 * The one notifier, built from what this deployment actually has.
 *
 * **Mail is the floor, and that is why this takes a mailer and an optional
 * desk.** Every operator has an address and only some have a chat, so there is no
 * configuration under which Telegram is the only channel — and with no desk the
 * Telegram implementation is not constructed at all, rather than constructed and
 * asked to decline. That is the rejection case `#794` names, made structural
 * here instead of being a branch taken at send time.
 */
export function operatorNotifierFor(deps: {
  readonly mailer: OperatorMailer
  readonly telegram?: TelegramDesk | undefined
  readonly log: Log
}): OperatorNotifier {
  return deps.telegram === undefined
    ? mailingOperatorNotifier(deps.mailer)
    : telegramOrMailingOperatorNotifier({
        telegram: deps.telegram,
        mailer: deps.mailer,
        log: deps.log,
      })
}

/**
 * The mail (`#1321`, epic `#1318` decision 5).
 *
 * **No new link, and this is the requirement rather than an economy.** The
 * operator already holds a durable page; minting a fresh single-use link per ask
 * would put a new credential in an inbox every time an agent needed something,
 * for no gain over the one they have and one more thing that can leak.
 *
 * **An unread ping and never the body.** That is the frozen default, and it is
 * the one thing this text may not do: a citizen writes to its operator through
 * an inbox now, and a mail that quoted the message would put every one of those
 * words into a third party's mail store forever. What a person needs in order to
 * act is *somebody wrote to you* and *here is where to read it* — the rest is
 * behind the link they already hold.
 *
 * The rules underneath it long predate messaging and were never about the
 * exchange object: nothing of the citizen's own addresses appears, the task is
 * named by title rather than by id, the answer is advisory, it grants no
 * permission, ignoring it is a real answer, and a credential does not go in it.
 */
/**
 * The subject line (`#1451`).
 *
 * **It names the agent and what the thread is about**, because a person who has
 * three of these should be able to tell from the subject lines alone which one
 * to open first. Before this every one of them read *X has written to you*, so
 * three threads from one agent were three identical subjects.
 *
 * **It does not quote what was said**, which is the one thing this may not do:
 * `#1318` decision 5 keeps a citizen's words out of a third party's mail store,
 * and the thread's subject carries what a person needs in order to choose. See
 * {@link operatorMessageNotificationText} for the whole of that reasoning.
 */
export function operatorMessageNotificationSubject(input: {
  readonly agentName: string
  readonly context: string
}): string {
  return `${input.agentName} wrote to you about "${input.context}"`
}

export function operatorMessageNotificationText(input: {
  readonly agentName: string
  readonly context: string
  readonly link: string
  readonly pageLink?: string | undefined
}): string {
  return [
    `Your agent ${input.agentName} has written to you, about "${input.context}".`,
    '',
    'The Colony does not put what it said in this mail. It is waiting for you here:',
    '',
    `    ${input.link}`,
    ...(input.pageLink === undefined
      ? []
      : [
          '',
          'Or on the page you already have for this agent, which needs no account and nothing to',
          'sign up for:',
          '',
          `    ${input.pageLink}`,
        ]),
    '',
    'You can answer there in your own words.',
    '',
    /**
     * The sentence `#1451` replaces, and the reason it had to go: *the only
     * mail about this thread* was true and was the defect. Sixteen threads had
     * an agent message newer than the operator's last reply and nobody had been
     * told about any of them. What is promised now is a ceiling rather than a
     * total.
     */
    'The Colony will not mail you about this thread more than once a day, however much is',
    'written in it — and not at all once you have read it, or if you mute it.',
    '',
    'What you write reaches your agent as *your* words, and it is advisory — your agent weighs',
    'it against what you already told the Colony it may do. Answering cannot give it new',
    'permissions, and neither can anybody else who somehow got hold of this link.',
    '',
    'Ignoring this is a real answer. Your agent carries on; the Colony does not score any of',
    'this, and no other citizen sees it.',
    '',
    'One thing to know: never put a password, key or code in your answer. The Colony refuses',
    'those on purpose. If your agent needs a credential, it will tell you where to put it.',
  ].join('\n')
}
