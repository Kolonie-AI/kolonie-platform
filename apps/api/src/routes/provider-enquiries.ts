import type { FastifyInstance } from 'fastify'
import {
  ATLAS_ADMISSION_QUESTIONS,
  ERROR_STATUS,
  PROVIDER_ENQUIRY_CONFIRMATION,
  PROVIDER_ENQUIRY_WHAT_WE_ASK,
  ProviderEnquirySchema,
} from '@kolonie-ai/core'
import type { RouteDependencies } from './dependencies.js'

/**
 * Named once so that no path out of this route can be the one that forgets it.
 *
 * **The refusals need the header as much as the answer does** — a browser that
 * cannot read a `400` reports a network error, and the form then cannot tell
 * *you left a field empty* from *the Colony is down*.
 */
const CORS = 'access-control-allow-origin'

/**
 * A provider writing in about the Atlas (`#544`).
 *
 * **The receiving half only.** The page is `kolonie-website#75`; this is the
 * route it posts to, and it exists first because the question it answers — do
 * providers want to be in the Atlas at all — is worth asking before anything
 * else in `#543`'s chain is built.
 *
 * ## Unauthenticated, and it must stay that way
 *
 * **A provider that has to register in order to ask has already left.** There is
 * no account, no login and no portal. What makes an open write safe is not a
 * credential but what the row can reach: `provider_enquiries` has no foreign
 * key, nothing downstream reads it as a decision, and the only thing it can ever
 * do is appear on `/backend` for a person to read.
 *
 * ## The captcha is the whole spam defence, deliberately
 *
 * A public form without one is a mailbox full of casino links within a week. The
 * one already configured for the capability gate is reused rather than a second
 * arrangement being invented — the same service, the same secret, the same
 * failure semantics.
 *
 * **An unreachable hCaptcha answers 503 and never *failed*.** That is the rule
 * `hcaptchaService` is written to and the reason is the same one it gives: a
 * verifier that reports a failure when the truth is *we could not ask* charges
 * the caller for our outage. Here the caller is a provider we are trying to
 * interest, and the cost of getting it wrong is the enquiry.
 */
export function registerProviderEnquiryRoute(v1: FastifyInstance, deps: RouteDependencies): void {
  v1.post('/atlas/enquiries', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>
    const parsed = ProviderEnquirySchema.safeParse(body)

    if (!parsed.success) {
      return reply
        .status(ERROR_STATUS['validation_failed'])
        .header(CORS, '*')
        .send({
          code: 'validation_failed',
          message:
            'Send product, url, contact and wants — what your product is, where it lives, how to ' +
            'reach you, and what you would want agents to do with it. The last one is the ' +
            'interesting answer and the one this form exists for.',
        })
    }

    /**
     * **The captcha is checked before anything is written**, so a failure costs
     * a row rather than leaving one to clean up. `captchaToken` is outside the
     * enquiry schema on purpose: it is a property of this request and not of the
     * enquiry, and putting it in the stored shape would be one field away from
     * storing it.
     */
    const token = typeof body['captchaToken'] === 'string' ? body['captchaToken'] : ''
    const outcome = token === '' ? 'failed' : await deps.academy.captcha.check(token)

    if (outcome === 'unavailable') {
      // 503 rather than `ERROR_STATUS['internal']`'s 500, and the academy route
      // makes the same exception for the same reason: this is *ask again in a
      // minute* and not *we crashed*, and 500 tells a caller to give up.
      return reply
        .status(503)
        .header(CORS, '*')
        .send({
          code: 'internal',
          message:
            'The Colony could not reach the service that checks the form is being filled in by a ' +
            'person. That is our problem and not yours — nothing was lost, and it is worth ' +
            'sending again in a few minutes.',
        })
    }

    if (outcome !== 'passed') {
      return reply
        .status(ERROR_STATUS['validation_failed'])
        .header(CORS, '*')
        .send({
          code: 'validation_failed',
          message:
            'The form needs the “prove you are human” check completed. A public form without one ' +
            'fills up with advertisements within a week, which is the only reason it is there.',
        })
    }

    await deps.providerEnquiries.record(parsed.data)

    /**
     * **The confirmation says that interest is not a listing**, and it says so
     * here rather than only on the page: a caller that posts this route directly
     * — which the website's own form does — gets the same sentence the page
     * shows, and there is one copy of it.
     */
    return reply
      .status(201)
      .header(CORS, '*')
      .send({ received: true, message: PROVIDER_ENQUIRY_CONFIRMATION })
  })

  /**
   * The preflight, which a cross-origin `POST` carrying JSON always makes.
   *
   * The form is on `kolonie.ai` and this route is on `api.kolonie.ai`, so
   * without this the browser never sends the request at all —
   * `kolonie-website#76`. It is `/v1/agents/name-check`'s arrangement, copied
   * rather than generalised: four routes now set the header per-route, and a
   * blanket CORS plugin would be deciding for every route that exists and every
   * one added later.
   *
   * **`*` rather than the site's origin**, for the reason `/v1/academy/graph`
   * gives: it is safe in front of a shared cache, it puts no host name in this
   * repository, and it is honest about what this is — a public write that no
   * credential is ever sent with, and whose spam defence is the captcha rather
   * than the origin. An origin header would not stop a script posting this
   * route directly, so it would buy nothing and read as though it had.
   */
  /**
   * What an entry has to answer, served so the form can show it (`#680`).
   *
   * **Public and unauthenticated, like the write it belongs to.** A provider
   * deciding whether to write in is exactly who these are for, and putting them
   * behind anything would mean the only people who meet them are the people who
   * already asked.
   *
   * **Served rather than copied into the page.** `kolonie-website#75` renders
   * the form; a second copy of these sentences there would disagree with this
   * one within a month, and the one being read would be the wrong one — the
   * argument `#428` made about the operator page, applied to the other door.
   */
  v1.get('/atlas/admission', async (_request, reply) =>
    reply.status(200).header(CORS, '*').send({
      intro: PROVIDER_ENQUIRY_WHAT_WE_ASK,
      questions: ATLAS_ADMISSION_QUESTIONS,
    }),
  )

  v1.options('/atlas/enquiries', async (_request, reply) =>
    reply
      .status(204)
      .header(CORS, '*')
      .header('access-control-allow-methods', 'POST, OPTIONS')
      .header('access-control-allow-headers', 'content-type')
      .header('access-control-max-age', '86400')
      .send(),
  )
}
