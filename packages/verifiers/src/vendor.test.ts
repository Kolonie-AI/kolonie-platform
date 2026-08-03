import { describe, expect, it } from 'vitest'
import {
  isPermanentVendorStatus,
  readVendorRejection,
  redactSecrets,
  vendorFaultEvidence,
  REDACTED,
  VENDOR_BODY_LIMIT,
} from './vendor.js'

describe('isPermanentVendorStatus', () => {
  /**
   * The three exceptions are the whole point of the function: each of them is a
   * 4xx that clears on its own, and reading them as permanent would fail
   * submissions for a bill we forgot to pay.
   */
  it.each([
    ['out of credit', 402],
    ['the vendor timing itself out', 408],
    ['rate limited', 429],
    ['a bad day at the vendor', 500],
    ['a gateway with nothing behind it', 503],
  ])('leaves %s retryable', (_case, status) => {
    expect(isPermanentVendorStatus(status)).toBe(false)
  })

  it.each([
    ['a malformed request', 400],
    ['a key the vendor will not accept', 401],
    ['a model this account may not use', 403],
    ['a path that does not exist', 404],
    ['a payload too large for the vendor', 413],
    ['an image the vendor will not process', 422],
  ])('treats %s as permanent', (_case, status) => {
    expect(isPermanentVendorStatus(status)).toBe(true)
  })
})

describe('redactSecrets', () => {
  it('removes a value this process actually sent', () => {
    const out = redactSecrets('invalid api key: sk-or-v1-abcdef0123456789', [
      'sk-or-v1-abcdef0123456789',
    ])

    expect(out).not.toContain('abcdef0123456789')
    expect(out).toContain(REDACTED)
  })

  it('survives a secret that is undefined or blank without redacting everything', () => {
    expect(redactSecrets('nothing to hide here', [undefined, '', '   '])).toBe(
      'nothing to hide here',
    )
  })

  /**
   * The net rather than the promise. A key we did not send — a second account's,
   * quoted back by a provider — cannot be named, and a credential in a row every
   * agent can read is worth catching by shape.
   */
  it.each([
    ['an OpenRouter key', 'sk-or-v1-QQQQQQQQQQQQQQQQ'],
    ['a GitHub token', 'ghp_AAAAAAAAAAAAAAAAAAAA'],
    ['a fine-grained GitHub token', 'github_pat_BBBBBBBBBBBBBBBB'],
  ])('removes %s it was never told about', (_case, secret) => {
    expect(redactSecrets(`upstream said: ${secret}`, [])).not.toContain(secret)
  })

  it('removes a bearer header quoted back at us', () => {
    const out = redactSecrets('sent: Authorization: Bearer abcdefghijklmnop', [])

    expect(out).not.toContain('abcdefghijklmnop')
    expect(out).toContain('Bearer')
  })

  it('removes a JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.QQQQQQQQ'

    expect(redactSecrets(`token ${jwt}`, [])).not.toContain('eyJzdWIiOiIxIn0')
  })
})

describe('readVendorRejection', () => {
  it('keeps the status and the body', async () => {
    const response = new Response('{"error":{"message":"invalid image"}}', { status: 400 })

    expect(await readVendorRejection(response)).toEqual({
      status: 400,
      body: '{"error":{"message":"invalid image"}}',
    })
  })

  it(`keeps only the first ${VENDOR_BODY_LIMIT} characters`, async () => {
    const response = new Response('x'.repeat(VENDOR_BODY_LIMIT * 3), { status: 400 })

    expect((await readVendorRejection(response)).body).toHaveLength(VENDOR_BODY_LIMIT)
  })

  /**
   * Truncation after redaction, not before. A secret cut in half is still a
   * recognisable prefix of a secret, and the whole point of the limit is that
   * what is stored is safe to read.
   */
  it('redacts before it truncates, so no secret survives as a prefix', async () => {
    const key = 'sk-or-v1-0123456789abcdef'
    const response = new Response(`${'p'.repeat(VENDOR_BODY_LIMIT - 5)}${key}`, { status: 400 })

    const { body } = await readVendorRejection(response, [key])

    expect(body).not.toContain('sk-or-v1-0123')
  })

  it('records a body it could not read as saying nothing, rather than throwing', async () => {
    const response = {
      status: 400,
      text: () => Promise.reject(new Error('the socket went away')),
    } as unknown as Response

    expect(await readVendorRejection(response)).toEqual({ status: 400, body: '' })
  })
})

describe('vendorFaultEvidence', () => {
  it("says the fault is the Colony's and that nothing was counted", () => {
    const evidence = vendorFaultEvidence({ status: 400, body: 'invalid image' }, 'reads your image')

    expect(evidence).toContain('400')
    expect(evidence).toContain("your submission's fault")
    expect(evidence).toContain('does not count as an attempt')
    expect(evidence).toContain('invalid image')
  })

  it('says nothing about a body it does not have', () => {
    const evidence = vendorFaultEvidence({ status: 403, body: '' }, 'reads your image')

    expect(evidence).not.toContain('What the vendor said')
  })
})
