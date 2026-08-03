import { ERROR_STATUS, ObservedTransferSchema } from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import {
  WEBHOOK_REFUSED,
  readDepositAddress,
  readDepositHistory,
  reconcileDeposits,
  webhookAuthorised,
} from '../deposits.js'
import { callerFor } from './authenticated.js'
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
  const { store, deposits } = deps

  /**
   * Where to send, generated on first ask.
   *
   * `POST` rather than `GET`, because the first call creates a keypair. It is
   * idempotent all the same — the second call returns the first address — which
   * is what a sponsor retrying a timed-out request needs.
   */
  v1.post('/deposits/address', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
    if (caller === null) return reply

    return reply.send(await readDepositAddress(caller.id, deposits.desk))
  })

  /** What arrived, credited or not, with the reason on the ones that were not. */
  v1.get('/deposits', async (request, reply) => {
    const caller = await callerFor(request, reply, store)
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
   * The body is validated as a transfer and never trusted as one: what the
   * Colony credits is decided by `depositRejection` against the mint, the
   * program and the commitment, all of which arrive in this payload and all of
   * which are checked.
   */
  const secret = deps.deposits.webhookSecret
  if (secret === undefined || secret.trim() === '') return

  v1.post('/deposits/webhook', async (request, reply) => {
    if (!webhookAuthorised(request.headers['authorization'], secret)) {
      return reply.status(ERROR_STATUS[WEBHOOK_REFUSED.code]).send(WEBHOOK_REFUSED)
    }

    const parsed = ObservedTransferSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(ERROR_STATUS.validation_failed).send({
        code: 'validation_failed',
        message:
          'A delivery carries a signature, the address it landed at, the mint, the token ' +
          'program, the amount in base units, and the commitment it was observed at.',
      })
    }

    const outcome = await deposits.desk.record(parsed.data)

    /**
     * Always `200`, whatever the Colony decided.
     *
     * A webhook that answers 4xx to a delivery it understood teaches the sender
     * to retry something that will never change — and a redelivery of a
     * signature already recorded is normal operation rather than an error. The
     * outcome is in the body for whoever is reading the logs.
     */
    return reply.send({ outcome: outcome.outcome })
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
