import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.js'
import { fakeColony } from '../__fixtures__/colony/index.js'
import { fakeAcademy } from '../__fixtures__/academy.js'
import { noProviderEnquiries, type ProviderEnquiryDesk } from '../provider-enquiries.js'

const ENQUIRY = {
  product: 'A mailbox service agents can sign up for.',
  url: 'openmail.example',
  contact: 'Jo, jo@openmail.example',
  wants: 'We want to know whether an agent can complete our signup without a person.',
  captchaToken: 'a-token-a-browser-produced',
}

/**
 * A provider writing in about the Atlas (`#544`).
 *
 * The route exists before the rest of `#543`'s chain because the question it
 * answers — do providers want to be in the Atlas at all — is worth asking first:
 * twelve enquiries in four weeks and everything proceeds with evidence, none and
 * four weeks were saved.
 */
describe('a provider writing in about the Atlas', () => {
  let app: FastifyInstance
  let enquiries: ProviderEnquiryDesk

  const build = (captcha: 'passed' | 'failed' | 'unavailable' = 'passed') => {
    enquiries = noProviderEnquiries()
    return buildApp({
      ...fakeColony(),
      academy: fakeAcademy(captcha),
      providerEnquiries: enquiries,
    })
  }

  const send = (body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/v1/atlas/enquiries', payload: body })

  beforeEach(async () => {
    app = build()
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
  })

  it('takes an enquiry from somebody with no account at all', async () => {
    const response = await send(ENQUIRY)

    expect(response.statusCode).toBe(201)
    expect(await enquiries.waiting()).toBe(1)
  })

  it('stores what they said about what they want from agents', async () => {
    await send(ENQUIRY)

    const [stored] = await enquiries.list()

    expect(stored?.wants).toBe(ENQUIRY.wants)
    expect(stored?.product).toBe(ENQUIRY.product)
    expect(stored?.handledAt).toBeNull()
  })

  /**
   * **The sentence the issue asks for**, and it is on the response rather than
   * only on the page: the website's form posts here, and one copy of the
   * sentence is what stops the page and the API saying two different things.
   */
  it('says plainly that interest is not a listing', async () => {
    const response = await send(ENQUIRY)

    expect(response.json().message).toContain('not an application to be listed')
  })

  it('refuses an enquiry that does not say what they want from agents', async () => {
    const { wants, ...rest } = ENQUIRY
    void wants

    const response = await send(rest)

    expect(response.statusCode).toBe(422)
    expect(await enquiries.waiting()).toBe(0)
  })

  /**
   * A public form without a captcha is a mailbox full of casino links within a
   * week, which is the only reason the check is there.
   */
  describe('the spam guard', () => {
    it('refuses a submission with no captcha token at all', async () => {
      const { captchaToken, ...rest } = ENQUIRY
      void captchaToken

      const response = await send(rest)

      expect(response.statusCode).toBe(422)
      expect(await enquiries.waiting()).toBe(0)
    })

    it('refuses one whose captcha did not pass', async () => {
      app = build('failed')
      await app.ready()

      const response = await send(ENQUIRY)

      expect(response.statusCode).toBe(422)
      expect(await enquiries.waiting()).toBe(0)
    })

    /**
     * **An unreachable hCaptcha is our outage and not their failure.** The rule
     * `hcaptchaService` is written to, applied where the caller is a provider we
     * are trying to interest: 503 and *send it again*, never a refusal.
     */
    it('answers 503 when the check cannot be made, and says nothing was lost', async () => {
      app = build('unavailable')
      await app.ready()

      const response = await send(ENQUIRY)

      expect(response.statusCode).toBe(503)
      expect(response.json().message).toContain('nothing was lost')
      expect(await enquiries.waiting()).toBe(0)
    })

    /** The check happens before the write, so a refusal leaves no row to clean up. */
    it('writes nothing at all when the guard refuses', async () => {
      app = build('failed')
      await app.ready()

      await send(ENQUIRY)

      expect(await enquiries.list()).toEqual([])
    })
  })
})
