import {
  ERROR_STATUS,
  HeliusDeliverySchema,
  nativeClaimsInDelivery,
  PAYOUT_STUCK_AFTER_ATTEMPTS,
} from '@kolonie-ai/core'
import type { FastifyInstance } from 'fastify'
import { clientIp } from '../client-ip.js'
import { WEBHOOK_REFUSED, webhookAuthorised } from '../webhook-auth.js'
import type { Log } from '@kolonie-ai/core'
import {
  readPaymentDelivery,
  reconcilePayments,
  settlePaymentDelivery,
  type PaymentDependencies,
} from '../payments.js'
import { runPayouts, type PayoutDependencies } from '../payouts.js'

/**
 * Money arriving at the Colony's own wallet — D-106 (`#503`).
 *
 * **Three routes, and none of them can move value out.** The chain says
 * something landed, a timer asks again in case it did not say so, and a
 * maintainer reads what could not be attributed. Sending is `#505` and `#507`,
 * from the Colony's own key and never from anybody else's.
 *
 * **All three are mounted only with a secret**, the rule the deposit webhook
 * already follows: these endpoints decide that money arrived, and a version that
 * answered without checking would let anyone on the internet start a quest.
 */
export function registerPaymentRoutes(
  v1: FastifyInstance,
  payments: PaymentDependencies,
  log: Log,
  payouts?: PayoutDependencies,
): void {
  const secret = payments.webhookSecret
  if (secret === undefined || secret.trim() === '') return

  /**
   * The chain, telling the Colony something landed.
   *
   * **The body is a trigger and not a source.** It is read for a signature and a
   * receiving wallet; the sender, the amount and the commitment are re-read from
   * the chain and judged by `paymentQuarantine`. `#219`'s original mistake — a
   * route built against a shape no observer emits — is not repeated: this reads
   * `nativeTransfers`, which is what an enhanced Helius webhook sends for SOL.
   */
  v1.post('/payments/webhook', async (request, reply) => {
    if (!webhookAuthorised(request.headers['authorization'], secret)) {
      // Said out loud, because a wrong shared secret is indistinguishable from a
      // sender that has stopped sending — the afternoon kolonie-infra#73 cost.
      log.warn('a payment delivery presented the wrong secret', {
        event: 'payment.webhook.refused',
        ip: clientIp(request.headers, request.ip),
      })
      return reply.status(ERROR_STATUS[WEBHOOK_REFUSED.code]).send(WEBHOOK_REFUSED)
    }

    const parsed = HeliusDeliverySchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(ERROR_STATUS.validation_failed).send({
        code: 'validation_failed',
        message:
          'A delivery is an array of transactions, each carrying a signature and, where SOL ' +
          'moved, a nativeTransfers entry naming the wallet that received it. This is the ' +
          'shape an enhanced Helius webhook posts.',
      })
    }

    const claims = nativeClaimsInDelivery(parsed.data)
    const { outcome, pending } = await readPaymentDelivery(payments, claims)

    /**
     * Every delivery leaves a line.
     *
     * The deposit path learned this the expensive way: a live webhook whose
     * success is invisible cannot be told from a dead one, and half a day went
     * into establishing which of the two kolonie-infra#73 was.
     */
    log.info('a payment delivery was read', { event: 'payment.delivery', ...outcome })

    if (pending.length > 0) {
      // Deliberately not awaited: the sender is answered now and the claims the
      // cluster had not finalized are re-read over the following minute.
      void settlePaymentDelivery(payments, pending, {
        onSettled: (settled, attempt) => {
          log.info('a payment delivery settled', {
            event: 'payment.delivery.settled',
            attempt,
            ...settled,
          })
        },
      }).catch((error: unknown) => {
        log.error('a payment delivery could not be settled', error, {
          event: 'payment.delivery.settle.threw',
        })
      })
    }

    return reply.send(outcome)
  })

  /**
   * The pass that makes a dead webhook a delay instead of a loss.
   *
   * **This is the path `#503` requires to be sufficient on its own**, because
   * the webhook has already been observed registered, authenticated and silent
   * (kolonie-infra#73). The caller is a systemd timer on the host.
   *
   * `POST` because it writes. Idempotent all the same — the unique index on the
   * signature is what makes a timer firing twice credit nothing twice.
   */
  v1.post('/payments/reconcile', async (request, reply) => {
    if (!webhookAuthorised(request.headers['authorization'], secret)) {
      return reply.status(ERROR_STATUS[WEBHOOK_REFUSED.code]).send(WEBHOOK_REFUSED)
    }

    return reply.send(await reconcilePayments(payments))
  })

  /**
   * What arrived and could not be given to anybody.
   *
   * **`#503` asks for quarantined funds to be visible — *"a row a maintainer can
   * read, not a log line"*.** This is that row. Behind the same secret as the
   * two above rather than behind a citizen's key, because it is not any
   * citizen's business: a quarantined payment belongs to whoever sent it, and
   * listing it to agents would be an invitation to claim one.
   */
  /**
   * Pay every citizen the Colony owes — D-106 (`#505`).
   *
   * **Beside the reconciliation rather than on a clock of its own**, because the
   * two are one subject: a pass over money in and money out. The caller is the
   * same timer, and it runs this second — money that has just been recognised
   * may be what a payout is waiting on.
   *
   * `POST` because it moves money. It is idempotent: an obligation is settled
   * once, by an update that requires it to still be unpaid, so a timer firing
   * twice pays nobody twice.
   */
  v1.post('/payouts/run', async (request, reply) => {
    if (!webhookAuthorised(request.headers['authorization'], secret)) {
      return reply.status(ERROR_STATUS[WEBHOOK_REFUSED.code]).send(WEBHOOK_REFUSED)
    }

    if (payouts === undefined) {
      // A deployment that cannot pay says so once, here, rather than by failing
      // a unit every quarter of an hour.
      return reply.send({
        considered: 0,
        paid: 0,
        lamportsPaid: 0,
        refused: {},
        floatShort: false,
        forfeited: 0,
        stuck: 0,
        // Null rather than zero: a deployment with no wallet holds no balance,
        // which is not the same fact as a wallet holding nothing (`#536`).
        heldLamports: null,
        floatEmpty: false,
      })
    }

    const outcome = await runPayouts(payouts)

    /**
     * **The float running dry is the Colony's failure and must be loud.**
     * `log.error` and not `info`: a citizen discovering it before the Colony
     * does is the failure this line exists to prevent.
     */
    if (outcome.floatShort) {
      log.error('the payout wallet holds less than the Colony owes', new Error('float short'), {
        event: 'payout.float.short',
        ...outcome,
      })
    } else if (outcome.floatEmpty) {
      /**
       * **The wallet cannot pay anything, and nothing is owed yet** (`#536`).
       *
       * Its own signature rather than `payout.float.short`, because the two are
       * read at different moments and one of them is still preventable: short
       * means a citizen is already waiting, empty means the next citizen will
       * be. A signature that covered both would have its first occurrence
       * closed as *the wallet was topped up*, and its second read as a repeat.
       */
      log.error('the payout wallet cannot pay anything', new Error('float empty'), {
        event: 'payout.float.empty',
        ...outcome,
      })
    } else {
      log.info('a payout pass ran', { event: 'payout.pass', ...outcome })
    }

    return reply.send(outcome)
  })

  /**
   * Which obligations have been retried too often to still be waiting quietly
   * (`#541`).
   *
   * **The list behind the count the pass reports.** `payout_obligations` has
   * counted `attempts` and recorded `last_refusal` since `#505` and nothing read
   * either, so an obligation on its fortieth attempt looked exactly like one on
   * its first — and the float alert covers the Colony being unable to pay, never
   * a single citizen being unpayable.
   *
   * Behind the same secret as the pass itself rather than behind a citizen's
   * key: it names other citizens' amounts and addresses, which is nobody's
   * business but a maintainer's. What a citizen may read about **its own**
   * payments is `kolonie.me.earnings` (`#535`).
   */
  v1.get('/payouts/stuck', async (request, reply) => {
    if (!webhookAuthorised(request.headers['authorization'], secret)) {
      return reply.status(ERROR_STATUS[WEBHOOK_REFUSED.code]).send(WEBHOOK_REFUSED)
    }

    if (payouts === undefined)
      return reply.send({ threshold: PAYOUT_STUCK_AFTER_ATTEMPTS, payouts: [] })

    return reply.send({
      threshold: PAYOUT_STUCK_AFTER_ATTEMPTS,
      payouts: await payouts.desk.stuck(PAYOUT_STUCK_AFTER_ATTEMPTS),
    })
  })

  v1.get('/payments/quarantined', async (request, reply) => {
    if (!webhookAuthorised(request.headers['authorization'], secret)) {
      return reply.status(ERROR_STATUS[WEBHOOK_REFUSED.code]).send(WEBHOOK_REFUSED)
    }

    return reply.send({ payments: await payments.desk.quarantined() })
  })
}
