import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WEB_SERVER_SEPARATION_MS, type AgentId, type Submission } from '@kolonie-ai/core'
import {
  WebServerVerifyVerifier,
  type WebServerChallengeReader,
  type WebServerProbeTarget,
} from './web-server-verify.js'

/**
 * The `web-server` verifier (#244).
 *
 * `website-verify` has no test of its own, which is a gap this deliberately does
 * not copy — and this rung needs one more than that one does, because its
 * *success* case returns `pending` and a verifier whose pass looks like a
 * not-yet is exactly the kind of thing that reads fine and behaves wrongly.
 */
describe('the web-server verifier', () => {
  const agentId = '11111111-1111-4111-8111-111111111111' as AgentId
  const submission = { payload: {} } as unknown as Submission
  const context = { agent: { id: agentId } } as never

  let fetched: string[]

  beforeEach(() => {
    fetched = []
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const serving = (body: string, status = 200) => {
    vi.stubGlobal('fetch', (url: string) => {
      fetched.push(url)
      return Promise.resolve(
        new Response(body, { status, headers: { 'content-type': 'text/plain' } }),
      )
    })
  }

  const reader = (
    probe: WebServerProbeTarget | undefined,
    open: { firstServedAt: string | null; secondServedAt: string | null } | undefined = {
      firstServedAt: null,
      secondServedAt: null,
    },
  ): WebServerChallengeReader => ({
    liveProbe: () => Promise.resolve(probe),
    openChallenge: () => Promise.resolve(open),
  })

  const aProbe = (over: Partial<WebServerProbeTarget> = {}): WebServerProbeTarget => ({
    challengeId: '22222222-2222-4222-8222-222222222222',
    origin: 'https://example.org',
    which: 'first',
    path: '/.well-known/kolonie/abc123',
    nonce: 'the-code-as-issued',
    firstServedAt: null,
    ...over,
  })

  it('refuses when the citizen has no challenge open', async () => {
    // Not `reader(undefined, undefined)`: a default parameter applies to an
    // explicit `undefined`, so that would have quietly tested the opposite case.
    const verifier = new WebServerVerifyVerifier({
      challenges: {
        liveProbe: () => Promise.resolve(undefined),
        openChallenge: () => Promise.resolve(undefined),
      },
    })

    const result = await verifier.verify(submission, context)

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('no open web-server challenge')
  })

  describe('the first probe', () => {
    it('fetches the path the Colony named, under the origin the citizen declared', async () => {
      serving('the-code-as-issued')
      const verifier = new WebServerVerifyVerifier({ challenges: reader(aProbe()) })

      await verifier.verify(submission, context)

      expect(fetched).toEqual(['https://example.org/.well-known/kolonie/abc123'])
    })

    /**
     * The case worth a test on its own: a passing first probe is `pending`, and
     * carries the fact in metadata because the verifier cannot write.
     */
    it('passes as pending, and states what it found for the verdict to record', async () => {
      serving('anything at all, containing the-code-as-issued, and more')
      const verifier = new WebServerVerifyVerifier({ challenges: reader(aProbe()) })

      const result = await verifier.verify(submission, context)

      expect(result.status).toBe('pending')
      expect(result.metadata).toMatchObject({
        webServer: { challengeId: '22222222-2222-4222-8222-222222222222', which: 'first' },
      })
      // And it tells the citizen why it is not being given the second path now.
      expect(result.evidence).toContain('could be prepared')
    })

    it('fails when the code is not in the body', async () => {
      serving('something else entirely')
      const verifier = new WebServerVerifyVerifier({ challenges: reader(aProbe()) })

      const result = await verifier.verify(submission, context)

      expect(result.status).toBe('fail')
      expect(result.metadata).toBeUndefined()
    })

    it('fails on a non-2xx, and names the prefix worth routing', async () => {
      serving('', 404)
      const verifier = new WebServerVerifyVerifier({ challenges: reader(aProbe()) })

      const result = await verifier.verify(submission, context)

      expect(result.status).toBe('fail')
      expect(result.evidence).toContain('/.well-known/kolonie/')
    })

    it('does not care what content type comes back', async () => {
      vi.stubGlobal('fetch', () =>
        Promise.resolve(
          new Response('the-code-as-issued', {
            status: 200,
            headers: { 'content-type': 'application/octet-stream' },
          }),
        ),
      )
      const verifier = new WebServerVerifyVerifier({ challenges: reader(aProbe()) })

      expect((await verifier.verify(submission, context)).status).toBe('pending')
    })
  })

  describe('between the probes', () => {
    it('is pending with a time, not a failure', async () => {
      const firstServedAt = new Date().toISOString()
      const verifier = new WebServerVerifyVerifier({
        challenges: reader(undefined, { firstServedAt, secondServedAt: null }),
      })

      const result = await verifier.verify(submission, context)

      expect(result.status).toBe('pending')
      expect(result.evidence).toContain('Nothing is wrong')
      expect(result.evidence).toContain(
        new Date(Date.parse(firstServedAt) + WEB_SERVER_SEPARATION_MS).toISOString(),
      )
    })
  })

  describe('the second probe', () => {
    it('passes the rung, and says what it certifies rather than what it guessed', async () => {
      serving('the-code-as-issued')
      const verifier = new WebServerVerifyVerifier({
        challenges: reader(aProbe({ which: 'second', path: '/.well-known/kolonie/def456' }), {
          firstServedAt: new Date().toISOString(),
          secondServedAt: null,
        }),
      })

      const result = await verifier.verify(submission, context)

      expect(result.status).toBe('pass')
      expect(result.metadata).toMatchObject({ webServer: { which: 'second' } })
      expect(result.evidence).toContain('not where it runs')
    })
  })

  /**
   * `#244` forbids IP-range, header and hosting-provider heuristics. Asserted by
   * serving a response that would trip any of them and checking the verdict is
   * decided by the code alone.
   */
  it('reads nothing but the body — no headers, no address, no provider', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response('the-code-as-issued', {
          status: 200,
          headers: {
            server: 'cloudflare',
            'cf-ray': 'something',
            'x-vercel-id': 'something',
            'x-powered-by': 'shared-hosting-inc',
          },
        }),
      ),
    )
    const verifier = new WebServerVerifyVerifier({
      challenges: reader(aProbe({ which: 'second' }), {
        firstServedAt: new Date().toISOString(),
        secondServedAt: null,
      }),
    })

    const result = await verifier.verify(submission, context)

    // A shared host that can answer on demand at a path it was not told about,
    // twice, an hour apart, has the capability. That is the decision, not an
    // oversight — see the module comment and D-091.
    expect(result.status).toBe('pass')
  })
})
