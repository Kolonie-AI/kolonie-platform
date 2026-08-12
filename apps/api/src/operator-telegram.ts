import type { AgentId, Log } from '@kolonie-ai/core'
import {
  citizensBoundToChat,
  issueStartForPageToken,
  issueStartToken,
  markChatUnreachable,
  redeemStartToken,
  telegramBindingFor,
  telegramBindingForPageToken,
  unbindChat,
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
  }
}

/** What a send did. `blocked` is the answer that means *stop using this chat*. */
export interface TelegramSendResult {
  readonly delivered: boolean
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

        if (response.ok) return { delivered: true, blocked: false }

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
      }
    | undefined
}

/** What the route should do with an update, once this has read it. */
export type TelegramUpdateOutcome =
  /** Nothing was said and nothing is sent. A group message, or an update we do not read. */
  | { readonly action: 'ignored'; readonly why: string }
  /** Say this in the chat, and nothing else happened. */
  | { readonly action: 'reply'; readonly chatId: number; readonly text: string }

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
  const chatId = typeof message?.chat?.id === 'number' ? message.chat.id : undefined
  const text = typeof message?.text === 'string' ? message.text.trim() : undefined

  if (chatId === undefined || text === undefined) {
    return { action: 'ignored', why: 'not a text message' }
  }

  /**
   * **A group is ignored entirely, rather than answered.**
   *
   * `can_join_groups` is off at BotFather and this does not rely on that having
   * happened. Answering would be worse than silence: a bot that replies in a
   * group has told everybody in it that this chat is talking to the Colony, and
   * whoever added it learns which citizens a stranger in the room operates.
   */
  if (message?.chat?.type !== 'private') {
    return { action: 'ignored', why: 'not a private chat' }
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
   * Anything else, from a chat that may or may not be bound.
   *
   * **`#795` is what makes a reply here mean something**; until it lands, saying
   * so is the honest answer. Silence would read as *sent* to somebody who has
   * just typed an answer to their citizen, and that is the failure they would
   * not notice.
   */
  const bound = await desk.store.citizensFor(chatId)

  return {
    action: 'reply',
    chatId,
    text:
      bound.length === 0
        ? 'This chat is not bound to a citizen, so the Colony has nothing to say here. Press ' +
          'the Telegram link on an operator page to bind it.'
        : 'The Colony writes to you here; it cannot read a reply yet. Answer on the operator ' +
          'page the message links to. Send /stop to stop receiving messages here.',
  }
}
