import type { FastifyInstance } from 'fastify'
import { webhookAuthorised, WEBHOOK_REFUSED } from '../webhook-auth.js'
import { ERROR_STATUS } from '@kolonie-ai/core'
import { handleTelegramUpdate, type TelegramUpdate } from '../operator-telegram.js'
import type { RouteDependencies } from './dependencies.js'

/**
 * Where Telegram delivers what an operator typed (`#793`).
 *
 * **Not an agent-facing route**, despite living under `/v1/` — the same
 * arrangement `/internal/email-inbound` has, and mounted on the same condition:
 * no configuration, no route. A deployment with no bot has no webhook to
 * register and nothing that would answer one.
 *
 * **The path is public and the header is what makes a request ours.** Telegram
 * offers `secret_token` on `setWebhook` for exactly this, and it is checked in
 * constant time by the same guard the payment webhook uses. A request without it
 * is refused before anything is read out of the body.
 *
 * **It answers `200` to everything it will not act on.** Telegram retries a
 * non-2xx, so a status raised over an update type this bot has no use for is a
 * retry storm the Colony aimed at itself.
 */
export function registerTelegramRoutes(v1: FastifyInstance, deps: RouteDependencies): void {
  const desk = deps.telegram

  if (desk === undefined) return

  v1.post('/internal/telegram-updates', async (request, reply) => {
    const presented = request.headers['x-telegram-bot-api-secret-token']

    if (
      !webhookAuthorised(typeof presented === 'string' ? presented : undefined, desk.webhookSecret)
    ) {
      return reply.status(ERROR_STATUS.unauthorized).send(WEBHOOK_REFUSED)
    }

    const outcome = await handleTelegramUpdate((request.body ?? {}) as TelegramUpdate, desk)

    if (outcome.action === 'reply') {
      /**
       * **The operator's answer is the event** (`#518`, `#795`).
       *
       * The same call the durable page makes, on the same reasoning: a person
       * replies in one minute and, without this, the agent reads the reply at its
       * next rhythm — four to six hours later. Awaited and ignored: the answer is
       * already written, the operator is owed a confirmation either way, and a
       * citizen whose endpoint has stopped answering falls back to polling.
       * Nothing about this line may reach the operator's screen.
       */
      if (outcome.answered !== undefined) {
        await deps.operatorRequests.wake?.wake(outcome.answered.agentId, 'operator-answer')
      }

      const sent = await desk.bot.send({ chatId: outcome.chatId, text: outcome.text })

      /**
       * A person who blocked the bot and then wrote to it is not a case that
       * exists, so this is about the chat having gone away between the update
       * and the answer. Marking it keeps `#794` from sending into it, and the
       * update itself is still `200`: Telegram delivered correctly, and there is
       * nothing for it to retry.
       */
      if (!sent.delivered && sent.blocked) await desk.store.markUnreachable(outcome.chatId)
    }

    return reply.status(200).send({ ok: true })
  })
}
