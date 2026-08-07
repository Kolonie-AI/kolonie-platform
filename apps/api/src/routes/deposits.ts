import { ERROR_STATUS, HeliusDeliverySchema, claimsInDelivery } from '@kolonie-ai/core'
import { clientIp } from '../client-ip.js'
import type { FastifyInstance } from 'fastify'
import {
  WEBHOOK_REFUSED,
  readDelivery,
  readDepositAddress,
  readDepositHistory,
  reconcileDeposits,
  settleDelivery,
  webhookAuthorised,
} from '../deposits.js'
import { sponsorFor } from './authenticated.js'
import type { RouteDependencies } from './dependencies.js'

/**
 * The way in (`#219`).
 *
 * **Three routes, and none of them can move value out.** A sponsor asks where to
 * send, reads what arrived, and the chain tells the Colony when something did.
 * There is no route here that debits an account, and `#222` is where that
 * conversation belongs.
 */
export function registerDepositRoutes(v1: FastifyInstance, deps: RouteDependencies): void {
  const { store, deposits, humans, log } = deps

  /**
   * The caller, by key or by session (`#430`).
   *
   * Named once here so the two sponsor-facing routes below cannot drift apart:
   * a deposit address a browser can read and a history it cannot is a console
   * that half works, which is worse than one that does not.
   */
  const acting = (
    request: Parameters<typeof sponsorFor>[0],
    reply: Parameters<typeof sponsorFor>[1],
  ) => sponsorFor(request, reply, store, humans.store)

  /**
   * Where to send, generated on first ask.
   *
   * `POST` rather than `GET`, because the first call creates a keypair. It is
   * idempotent all the same — the second call returns the first address — which
   * is what a sponsor retrying a timed-out request needs.
   */
  v1.post('/deposits/address', async (request, reply) => {
    const caller = await acting(request, reply)
    if (caller === null) return reply

    const result = await readDepositAddress(caller.id, deposits.desk)
    if ('error' in result) {
      return reply.status(ERROR_STATUS[result.error.code]).send(result.error)
    }

    return reply.send(result)
  })

  /** What arrived, credited or not, with the reason on the ones that were not. */
  v1.get('/deposits', async (request, reply) => {
    const caller = await acting(request, reply)
    if (caller === null) return reply

    return reply.send(await readDepositHistory(caller.id, deposits.desk))
  })

  /**
   * The chain, telling the Colony something landed.
   *
   * **Not mounted at all without a secret.** Everything else in this API
   * degrades to a 503 when unconfigured, which is right for a rung an agent is
   * climbing and wrong for this: the endpoint turns *a transfer happened* into a
   * balance, and a version that answered without checking would let anyone on
   * the internet credit any account.
   *
   * **The body is a trigger and not a source** (`#321`). It is read for a
   * signature and a receiving wallet, and every fact the credit rests on — the
   * mint, the token program, the amount, the commitment — is re-read from the
   * chain and judged by the same `depositRejection` the reconciliation goes
   * through. `#219` shipped this route against a shape no observer emits, so
   * until now a real Helius webhook was answered `422` forever.
   */
  const secret = deps.deposits.webhookSecret
  if (secret === undefined || secret.trim() === '') return

  v1.post('/deposits/webhook', async (request, reply) => {
    if (!webhookAuthorised(request.headers['authorization'], secret)) {
      /**
       * The one refusal that has to say so out loud (kolonie-infra#73).
       *
       * A 4xx is not logged anywhere else, by design — and this particular one
       * is a wrong shared secret, which is indistinguishable from a sender that
       * has stopped sending. It cost an afternoon on 2026-08-07 to rule out by
       * hand what one line would have answered.
       */
      log.warn('a delivery presented the wrong secret', {
        event: 'deposit.webhook.refused',
        ip: clientIp(request.headers, request.ip),
      })
      return reply.status(ERROR_STATUS[WEBHOOK_REFUSED.code]).send(WEBHOOK_REFUSED)
    }

    const parsed = HeliusDeliverySchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(ERROR_STATUS.validation_failed).send({
        code: 'validation_failed',
        message:
          'A delivery is an array of transactions, each carrying a signature and, where a ' +
          'token moved, a tokenTransfers entry naming the wallet that received it. This is ' +
          'the shape an enhanced Helius webhook posts.',
      })
    }

    /**
     * Always `200`, whatever the Colony decided.
     *
     * A webhook that answers 4xx to a delivery it understood teaches the sender
     * to retry something that will never change — and a redelivery of a
     * signature already recorded is normal operation rather than an error. The
     * counts are in the body for whoever is reading the logs.
     */
    const claims = claimsInDelivery(parsed.data)
    const { outcome, pending } = await readDelivery(deposits, claims)

    /**
     * Every delivery leaves a line, and this is the line that was missing.
     *
     * `docker logs kolonie-api | grep deposits/webhook` answered nothing on
     * 2026-08-07 and was read as *the webhook never delivered*. It had
     * delivered, eight seconds after the transfer, and been answered `200` —
     * the reverse proxy's access log was the only record of it. A live path
     * whose success is invisible cannot be told from a dead one.
     */
    log.info('a deposit delivery was read', { event: 'deposit.delivery', ...outcome })

    /**
     * Kept asking after the answer went out (kolonie-infra#73).
     *
     * Deliberately not awaited: the sender is answered now and the claims that
     * were not finalized yet are re-read over the following minute. A rejection
     * here must not become an unhandled one, so the catch is part of the design
     * rather than caution.
     */
    if (pending.length > 0) {
      void settleDelivery(deposits, pending, {
        onSettled: (settled, attempt) => {
          log.info('a delivery settled', {
            event: 'deposit.delivery.settled',
            attempt,
            ...settled,
          })
        },
      }).catch((error: unknown) => {
        log.error('a delivery could not be settled', error, {
          event: 'deposit.delivery.settle.threw',
        })
      })
    }

    return reply.send(outcome)
  })

  /**
   * The pass that makes a missed delivery a delay instead of a loss
   * (kolonie-infra#72).
   *
   * **Behind the same secret as the webhook, and mounted under the same
   * condition**, because it credits balances by the same function and a second
   * authentication scheme for the same power would be a second thing to get
   * wrong. The caller is a systemd timer on the host, not a sponsor: no agent
   * has a reason to run this, and nothing here is per-citizen.
   *
   * `POST` rather than `GET` because it writes. It is idempotent all the same —
   * the unique index on the signature is what makes redelivery safe, and it is
   * the same index the webhook relies on — so a timer that fires twice, or an
   * operator who runs it by hand while the timer is running, credits nothing
   * twice.
   *
   * **A pass with no watcher answers `200` with zeros rather than an error.**
   * `RPC_URL` unset is a degraded deployment that has said so at startup, and a
   * timer that failed hourly against a deliberate configuration would train
   * whoever reads the units to ignore it.
   */
  v1.post('/deposits/reconcile', async (request, reply) => {
    if (!webhookAuthorised(request.headers['authorization'], secret)) {
      return reply.status(ERROR_STATUS[WEBHOOK_REFUSED.code]).send(WEBHOOK_REFUSED)
    }

    return reply.send(await reconcileDeposits(deposits))
  })
}
