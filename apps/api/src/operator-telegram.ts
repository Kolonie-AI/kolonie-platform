import type { AgentId, ConversationId, Log } from '@kolonie-ai/core'
import {
  credentialFinding,
  credentialRefusalMessage,
  OPERATOR_MESSAGE_MAX_LENGTH,
  OPERATOR_MESSAGE_MIN_LENGTH,
} from '@kolonie-ai/core'
import {
  answerOperatorMessageFromChat,
  citizensBoundToChat,
  issueStartForPageToken,
  issueStartToken,
  markChatUnreachable,
  recordMessageTelegramAsk,
  redeemStartToken,
  telegramBindingFor,
  telegramBindingForPageToken,
  unbindChat,
  type AnswerFromChatOutcome,
  type Database,
  type IssuedStartToken,
  type RedeemStartOutcome,
  type TelegramBinding,
} from '@kolonie-ai/db'

/**
 * The operator's desk on Telegram (`#793`), above the storage.
 *
 * What is decided *here* is the two things a person sees: the one gesture that
 * binds a chat, and what the bot says back. The schema argues why a `chat_id` is
 * the only thing that can be stored; `#794` sends over the channel this opens and
 * `#795` lets an operator answer in it.
 *
 * ## The channel is off unless it is configured, and off is a working state
 *
 * All three variables are optional in `kolonie-infra` (`kolonie-infra#142`), so
 * every function here has to cope with there being no bot at all. Absent, no deep
 * link is offered on any surface, the webhook route is not mounted, and an
 * operator is reached by mail exactly as they were before this existed. That is
 * the shape the SMS adapter uses and the same reason: a Colony that was never
 * given a bot should start normally.
 *
 * ## Nothing here can widen what a citizen may do
 *
 * D-081 covers this surface as it covers the durable page. Pressing a link binds
 * a chat, `/stop` unbinds it, and neither reaches `autonomy_contracts` or any
 * permission. Whoever holds a start payload can bind *their own* Telegram to one
 * citizen — which the operator sees on the page and can end in one word.
 */

/** Everything this surface needs from the database. */
export interface TelegramStore {
  issueStart(agentId: AgentId): Promise<IssuedStartToken>
  redeemStart(input: {
    readonly token: string
    readonly chatId: number
  }): Promise<RedeemStartOutcome>
  bindingFor(agentId: AgentId): Promise<TelegramBinding | undefined>
  /**
   * The same read, resolved by a durable page token (`#428`'s two doors).
   *
   * **A second function rather than a caller that resolves the agent first.** The
   * page has a token and no agent id, and a helper that turned one into the other
   * would be a helper any future caller could aim at a citizen it had proved
   * nothing about.
   */
  bindingForPageToken(token: string): Promise<TelegramBinding | undefined>
  /** Mint a deep link for the citizen a live page names, when the button is pressed. */
  issueStartForPage(token: string): Promise<IssuedStartToken | undefined>
  /** Every citizen this chat answers for, named. What `/stop` reports. */
  citizensFor(
    chatId: number,
  ): Promise<readonly { readonly agentId: AgentId; readonly name: string }[]>
  unbind(chatId: number): Promise<readonly string[]>
  /** Written when a send is refused (`#794`); the column is created here. */
  markUnreachable(chatId: number): Promise<void>
  /** Which message the Colony sent about which messaging thread (`#1321`). */
  recordMessageAsk(input: {
    readonly conversationId: ConversationId
    readonly chatId: number
    readonly messageId: number
  }): Promise<void>
  /**
   * An operator's reply, written into the thread it answers (`#1321`).
   *
   * Resolved from the message that was replied to and from the chat it came in,
   * both of which the Colony wrote itself. No agent id crosses this boundary.
   */
  answerMessageFromChat(input: {
    readonly chatId: number
    readonly replyToMessageId: number
    readonly body: string
  }): Promise<AnswerFromChatOutcome>
}

export function databaseTelegram(db: Database): TelegramStore {
  return {
    issueStart: (agentId) => issueStartToken(db, agentId),
    redeemStart: (input) => redeemStartToken(db, input),
    bindingFor: (agentId) => telegramBindingFor(db, agentId),
    bindingForPageToken: (token) => telegramBindingForPageToken(db, token),
    issueStartForPage: (token) => issueStartForPageToken(db, token),
    citizensFor: (chatId) => citizensBoundToChat(db, chatId),
    unbind: (chatId) => unbindChat(db, chatId),
    markUnreachable: (chatId) => markChatUnreachable(db, chatId),
    recordMessageAsk: (input) => recordMessageTelegramAsk(db, input),
    answerMessageFromChat: (input) => answerOperatorMessageFromChat(db, input),
  }
}

/** What a send did. `blocked` is the answer that means *stop using this chat*. */
export interface TelegramSendResult {
  readonly delivered: boolean
  /**
   * Telegram's own id for the message that went out, when one did (`#795`).
   *
   * **What makes a reply resolvable.** The Colony records it against the exchange
   * it was about, and a reply carrying `reply_to_message` names one exactly —
   * where *the operator's most recent open request* would be a guess that breaks
   * on somebody answering four citizens in one evening.
   */
  readonly messageId?: number | undefined
  /**
   * The person blocked the bot, deleted the account, or the chat is gone.
   *
   * **Distinct from an undelivered message**, and the distinction is the whole
   * point of the field: a timeout is worth retrying and a `403` is worth writing
   * `unreachable_at` for. Collapsing them either marks a working chat dead or
   * keeps writing into one nobody will ever read.
   */
  readonly blocked: boolean
  readonly reason?: string | undefined
}

/** The bot, behind a port, so this workspace's tests reach no network. */
export interface TelegramBot {
  /** Read from `TELEGRAM_OPERATOR_BOT_USERNAME`. Never a constant — see {@link deepLinkFor}. */
  readonly username: string
  send(message: { readonly chatId: number; readonly text: string }): Promise<TelegramSendResult>
}

export interface TelegramDependencies {
  /** `undefined` when the three variables are unset. Absent is a working configuration. */
  readonly telegram?: TelegramDesk | undefined
}

export interface TelegramDesk {
  readonly store: TelegramStore
  readonly bot: TelegramBot
  /** Checked against `X-Telegram-Bot-Api-Secret-Token` on every update. */
  readonly webhookSecret: string
}

/**
 * The three variables the desk is built from, named once.
 *
 * Exported so that `kolonie-infra`'s side of the contract has something to be
 * checked against, and so a test can assert the names rather than repeating the
 * strings — which is how `SMS_COLONY_NUMBER` came to be read here and passed
 * nowhere (`#480`).
 */
export const TELEGRAM_VARS = [
  'TELEGRAM_OPERATOR_BOT_TOKEN',
  'TELEGRAM_OPERATOR_BOT_USERNAME',
  'TELEGRAM_WEBHOOK_SECRET',
] as const

export interface TelegramConfiguration {
  readonly token: string
  readonly username: string
  readonly webhookSecret: string
}

/**
 * The configuration, or `undefined` when the bot is not set up.
 *
 * **All three or none.** A token with no webhook secret would mount a public
 * route with nothing guarding it, and a secret with no token would hand a person
 * a link into a bot that cannot answer them. Neither is a state worth having a
 * code path for, so a partial configuration is treated as no configuration —
 * and, unlike a missing sealing key, this one degrades onto a channel that
 * already works rather than onto a refusal.
 *
 * A leading `@` on the username is accepted and dropped: it is how the name is
 * written everywhere a person reads it, and a deep link containing one is dead.
 */
export function telegramFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): TelegramConfiguration | undefined {
  const values = TELEGRAM_VARS.map((variable) => (env[variable] ?? '').trim())

  if (values.some((value) => value === '')) return undefined

  const [token, username, webhookSecret] = values as [string, string, string]

  return { token, username: username.replace(/^@/, ''), webhookSecret }
}

/**
 * Where the person presses.
 *
 * **The username comes from configuration and is never compiled in.** A bot can
 * be renamed, and a hardcoded name would break every deep link the Colony has
 * ever handed out at the moment it was — including the ones already sitting in
 * people's chat histories, which nothing can go back and correct.
 */
export function deepLinkFor(bot: TelegramBot, token: string): string {
  return `https://t.me/${bot.username}?start=${token}`
}

/**
 * The Bot API, over HTTP.
 *
 * **The token is in the URL because the Bot API has no other way to carry it**,
 * which is why nothing here logs a URL. `event` slugs name the outcome and never
 * the address; a `403` is reported as `blocked` and nothing else about it is
 * interesting.
 */
export function httpTelegramBot(config: {
  readonly token: string
  readonly username: string
  readonly log: Log
}): TelegramBot {
  return {
    username: config.username,
    async send(message) {
      try {
        const response = await fetch(`https://api.telegram.org/bot${config.token}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: message.chatId,
            text: message.text,
            // The Colony's own words go out as text. Nothing here is composed
            // from anything a citizen or an operator wrote, and a parse mode
            // would make a stray character in a name into a formatting error.
            disable_web_page_preview: true,
          }),
        })

        if (response.ok) {
          /**
           * The id, if the answer carried one. **Read defensively and never
           * required**: a send that succeeded is a send that succeeded, and a
           * message the Colony cannot map is one an operator answers on the page
           * instead — which is worse than the alternative and much better than
           * treating a delivered message as undelivered.
           */
          const body = (await response.json().catch(() => undefined)) as
            { readonly result?: { readonly message_id?: unknown } } | undefined
          const messageId = body?.result?.message_id

          return {
            delivered: true,
            blocked: false,
            ...(typeof messageId === 'number' ? { messageId } : {}),
          }
        }

        /**
         * `403` is *the person does not want this*, and `400` with a
         * `chat not found` description is the same fact arriving differently.
         * Both are permanent for this chat; every other status is not.
         */
        const blocked = response.status === 403 || response.status === 400

        config.log.warn('the Telegram desk could not deliver a message', {
          event: 'telegram.send.refused',
          status: response.status,
          blocked,
        })

        return { delivered: false, blocked, reason: `status ${response.status}` }
      } catch (error) {
        // A network failure is not the person's choice, so it is never `blocked`.
        config.log.warn('the Telegram desk could not be reached', {
          event: 'telegram.send.failed',
          reason: error instanceof Error ? error.name : 'unknown',
        })
        return { delivered: false, blocked: false, reason: 'unreachable' }
      }
    },
  }
}

/**
 * An update, as much of it as this surface reads.
 *
 * **Narrower than Telegram's own shape on purpose.** Everything not named here is
 * an update type the bot has no use for, and the route answers `200` to it
 * without looking further — a bot that acted on the parts of an update it had not
 * been written for is a bot whose behaviour is decided by whoever sends it one.
 */
export interface TelegramUpdate {
  readonly message?:
    | {
        readonly chat?: { readonly id?: unknown; readonly type?: unknown } | undefined
        readonly text?: unknown
        /**
         * Which of the Colony's messages this answers (`#795`).
         *
         * **The only thing that says which exchange a reply belongs to.** Read
         * rather than guessed from recency: an operator answering four citizens
         * in one evening is the case a *most recent open request* rule breaks on,
         * and it is not a rare case for the people this is for.
         */
        readonly reply_to_message?: { readonly message_id?: unknown } | undefined
      }
    | undefined
  /**
   * An edit, which is not a reply and is answered rather than acted on (`#795`).
   *
   * **A record the operator can silently rewrite after the citizen has acted on
   * it is worse than no edit at all.** So the Colony keeps what it was told and
   * says so, and the operator sends a new reply if they meant something else.
   */
  readonly edited_message?:
    { readonly chat?: { readonly id?: unknown; readonly type?: unknown } | undefined } | undefined
}

/** What the route should do with an update, once this has read it. */
export type TelegramUpdateOutcome =
  /** Nothing was said and nothing is sent. A group message, or an update we do not read. */
  | { readonly action: 'ignored'; readonly why: string }
  /**
   * Say this in the chat.
   *
   * `answered` is present when the update wrote an operator's answer — into an
   * exchange (`#795`) or into a messaging thread (`#1321`) — and the caller wakes
   * that citizen, on the same path a reply typed into the durable page takes.
   * Absent means nothing was written, which is every other outcome including
   * every refusal.
   *
   * Both shapes carry `agentId`, which is the only field the route reads: what
   * the answer landed in is the storage layer's business, and a caller that had
   * to tell them apart would be a caller `#1325` has to edit again.
   */
  | {
      readonly action: 'reply'
      readonly chatId: number
      readonly text: string
      readonly answered?: Extract<AnswerFromChatOutcome, { outcome: 'answered' }> | undefined
    }

const BINDING_ENDED = (names: readonly string[]): string =>
  names.length === 0
    ? 'This chat was not receiving anything from the Colony, so there was nothing to stop.'
    : `Stopped. The Colony will write to you by email about ${names.join(', ')} from now on. ` +
      'Press the link on the operator page again if you want Telegram back.'

/**
 * Read one update and decide what happens.
 *
 * **Separate from the route so it can be tested without a server**, and because
 * what this returns is the whole of the bot's behaviour — a reader deciding
 * whether a group chat can reach anything should not have to read Fastify
 * plumbing to find out.
 */
export async function handleTelegramUpdate(
  update: TelegramUpdate,
  desk: TelegramDesk,
): Promise<TelegramUpdateOutcome> {
  const message = update.message

  /**
   * An edit is answered and never acted on (`#795`).
   *
   * Handled before anything else, because what makes it a defect is precisely
   * that it looks like a message: a record the operator can silently rewrite
   * after the citizen has acted on it is worse than no edit at all. So the
   * Colony keeps what it was told and says so.
   */
  if (update.edited_message !== undefined) {
    const editedIn = update.edited_message.chat
    if (typeof editedIn?.id !== 'number' || editedIn.type !== 'private') {
      return { action: 'ignored', why: 'an edit outside a private chat' }
    }
    return {
      action: 'reply',
      chatId: editedIn.id,
      text:
        'Editing a message here does not change what the Colony recorded — your agent may ' +
        'already have read it. Send a new reply to the same message if you want to add ' +
        'something.',
    }
  }

  const chatId = typeof message?.chat?.id === 'number' ? message.chat.id : undefined
  const text = typeof message?.text === 'string' ? message.text.trim() : undefined

  if (chatId === undefined) {
    return { action: 'ignored', why: 'not a message this bot reads' }
  }

  /**
   * **A group is ignored entirely, rather than answered**, and this is asked
   * before anything about the content — a bot that answers a group has told
   * everybody in it that this chat talks to the Colony, whatever the answer was.
   */
  if (message?.chat?.type !== 'private') {
    return { action: 'ignored', why: 'not a private chat' }
  }

  /**
   * This surface takes text (`#795`).
   *
   * A sticker, a photo, a voice note or a forwarded document is refused with a
   * sentence rather than dropped: an operator who sends a screenshot of the thing
   * their agent asked about has done something reasonable, and silence would read
   * as *received*.
   */
  if (text === undefined) {
    return {
      action: 'reply',
      chatId,
      text:
        'The Colony can only read text here. If you meant to answer your agent, reply to its ' +
        'message in words — anything else, including a photo or a file, is not recorded.',
    }
  }

  if (text === '/stop' || text.startsWith('/stop ')) {
    const ended = await desk.store.unbind(chatId)
    return { action: 'reply', chatId, text: BINDING_ENDED(ended) }
  }

  if (text === '/start' || text.startsWith('/start ')) {
    const payload = text.slice('/start'.length).trim()

    /**
     * A bare `/start` is what a person gets by opening the bot from search
     * rather than through a link, and it is a real case rather than an error:
     * they have found the desk and have nothing to bind it to yet.
     */
    if (payload === '') {
      return {
        action: 'reply',
        chatId,
        text:
          'This is the Kolonie operator desk. It only writes to you about a citizen you ' +
          'answer for, and it can only do that once you have pressed the link on that ' +
          "citizen's operator page. Open the page the Colony emailed you and press it there.",
      }
    }

    const redeemed = await desk.store.redeemStart({ token: payload, chatId })

    if (redeemed.outcome === 'unusable') {
      /**
       * One sentence for every closed state — unknown, expired, spent, or a
       * citizen that has been erased since. The page can issue a fresh link,
       * which is the only next step in all four cases, and telling the four
       * apart would confirm to whoever guessed a payload that it was otherwise
       * right.
       */
      return {
        action: 'reply',
        chatId,
        text:
          'That link has been used already or has expired. Open the operator page the Colony ' +
          'emailed you and press the Telegram link there again — it issues a fresh one.',
      }
    }

    return {
      action: 'reply',
      chatId,
      text:
        `Bound. The Colony will reach you here about ${redeemed.agentName}, and by email if ` +
        `Telegram ever stops working. ` +
        (redeemed.replaced
          ? 'This replaces the chat you bound before, which will stop receiving. '
          : '') +
        'Send /stop to end this at any time.',
    }
  }

  /**
   * An answer to one of the Colony's messages (`#795`).
   *
   * **Only from a bound chat, and only to a message the Colony sent.** Both are
   * decided by `answerMessageFromChat` in one query — the row that maps the message to
   * an exchange, *and* the binding still standing — because a chat that was
   * unbound with `/stop`, or rebound to somebody else, must not be able to write
   * into an exchange it once received a message about.
   *
   * That is what keeps the property this whole surface rests on: text is accepted
   * from a chat the Colony bound itself, attributed to the operator, advisory.
   * Nothing on this path can change an autonomy level, grant a permission or
   * widen what the citizen may do (D-081) — it appends one message to one
   * exchange the citizen itself opened.
   */
  const replyTo =
    typeof message?.reply_to_message?.message_id === 'number'
      ? message.reply_to_message.message_id
      : undefined

  if (replyTo !== undefined) {
    /**
     * **The same refusal the boxes on the durable page make**, and it belongs
     * here for a sharper reason than symmetry: a chat is exactly where somebody
     * pastes a password, because it feels like a private conversation with a
     * person. The Colony refuses those on purpose and says where a secret does
     * go, which is the sealed drop (`#410`).
     */
    const finding = credentialFinding(text)
    if (finding !== null) {
      return { action: 'reply', chatId, text: credentialRefusalMessage(finding) }
    }

    if (text.length < OPERATOR_MESSAGE_MIN_LENGTH) {
      return {
        action: 'reply',
        chatId,
        text:
          'That was too short for the Colony to record as an answer. A sentence is enough — ' +
          'nothing you write here is judged.',
      }
    }

    if (text.length > OPERATOR_MESSAGE_MAX_LENGTH) {
      return {
        action: 'reply',
        chatId,
        text:
          'That is longer than the Colony records for one answer. Send the short version here, ' +
          'or answer on the operator page the message links to.',
      }
    }

    /**
     * **Messaging first, the exchange second** (`#1321`, epic `#1318`).
     *
     * One mapping since `#1325`: `message_telegram_asks` is the only table a
     * sent message is recorded in, so a reply resolves in one lookup or in
     * none.
     */
    const answered = await desk.store.answerMessageFromChat({
      chatId,
      replyToMessageId: replyTo,
      body: text,
    })

    if (answered.outcome === 'answered') {
      return {
        action: 'reply',
        chatId,
        answered,
        /**
         * One line, and not an echo of what they wrote. The operator can see
         * what they sent directly above it; repeating it back costs a screen and
         * says nothing.
         */
        text: 'Sent. Your agent will read this at its next waking.',
      }
    }

    /**
     * **Answered, not dropped**, and this is the failure the operator would
     * otherwise not notice: silence after typing an answer reads as *sent*.
     */
    return {
      action: 'reply',
      chatId,
      text:
        'The Colony could not match that to an open question. Reply to the message it sent ' +
        'you about the question you mean — or answer on the operator page, which the message ' +
        'links to.',
    }
  }

  /**
   * Text in the chat that answers nothing in particular.
   *
   * **The bot says what is missing rather than guessing.** Resolving *which*
   * exchange from recency is exactly the rule that breaks on an operator
   * answering four citizens in one evening, so a message with nothing to attach
   * it to is not attached to anything.
   */
  const bound = await desk.store.citizensFor(chatId)

  return {
    action: 'reply',
    chatId,
    text:
      bound.length === 0
        ? 'This chat is not bound to a citizen, so the Colony has nothing to say here. Press ' +
          'the Telegram link on an operator page to bind it.'
        : 'To answer your agent, reply to the message the Colony sent you about it — that is ' +
          'how it knows which question you mean. Send /stop to stop receiving messages here.',
  }
}
