import { REACHABILITY_LIMIT, fixedWindowLimiter, reachabilityLimiter } from './rate-limit.js'
import { checkReachability, reachabilityAsText, type ReachabilityFetch } from './reachability.js'
import { AgentIdSchema, type AgentId } from '@kolonie-ai/core'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

/**
 * The check that lets a citizen find out whether the world can reach it, without
 * spending a rung attempt (#394).
 *
 * **Every address here is a documentation example** — `example.org`,
 * `example.com`, and the RFC 5737 and RFC 1918 ranges. No real host is named and
 * nothing about the Colony's own infrastructure appears, which is the standing
 * red line and also the only way these tests can be honest: a test that reached
 * a real host would be measuring somebody else's uptime.
 */
const anAgent = (): AgentId => AgentIdSchema.parse(randomUUID())

/** A fetch that answers with a status and never touches a network. */
const answering = (status: number): ReachabilityFetch => {
  return async () => new Response(null, { status })
}

/** A fetch that fails the way a runtime fails, with the code in the cause. */
const failing = (code: string, name = 'TypeError'): ReachabilityFetch => {
  return async () => {
    const error = Object.assign(new Error('fetch failed'), {
      name,
      cause: Object.assign(new Error(code), { code }),
    })
    throw error
  }
}

/** A fetch nothing may call. Passed wherever the point is that no request is made. */
const forbidden: ReachabilityFetch = async () => {
  throw new Error('the Colony made a request it should have refused')
}

const check = (origin: string, fetch: ReachabilityFetch, limiter = reachabilityLimiter()) =>
  checkReachability({ origin }, anAgent(), { limiter, fetch })

describe('checking whether the Colony can reach an address', () => {
  it('reports the status a reachable address answered with', async () => {
    const result = await check('https://example.org', answering(200))

    expect(result.outcome).toBe('checked')
    if (result.outcome !== 'checked') return
    expect(result.finding.reason).toBe('answered')
    expect(result.finding.status).toBe(200)
    expect(result.finding.reached).toBe(true)
  })

  /**
   * **A 404 is a reachable server**, and this is the distinction the whole tool
   * exists to draw. A citizen told only *it did not work* cannot tell a closed
   * firewall from a handler routed at the wrong path, and those have nothing in
   * common except the sentence.
   */
  it('counts a 404 as reached, because it is', async () => {
    const result = await check('https://example.org', answering(404))

    expect(result.outcome === 'checked' && result.finding.reached).toBe(true)
    expect(result.outcome === 'checked' && result.finding.status).toBe(404)
  })

  /**
   * Each distinguishable failure reports its own reason rather than a shared one
   * — *"could not reach it"* as a single undifferentiated answer is what this
   * replaces.
   */
  describe('each failure has its own reason', () => {
    it('says the name did not resolve', async () => {
      const result = await check('https://not-a-real-name.example', failing('ENOTFOUND'))

      expect(result.outcome === 'checked' && result.finding.reason).toBe('dns-failed')
    })

    it('says the connection was refused', async () => {
      const result = await check('https://example.org', failing('ECONNREFUSED'))

      expect(result.outcome === 'checked' && result.finding.reason).toBe('refused')
    })

    it('says it timed out', async () => {
      const result = await check('https://example.org', failing('ETIMEDOUT', 'TimeoutError'))

      expect(result.outcome === 'checked' && result.finding.reason).toBe('timed-out')
    })

    it('says TLS failed', async () => {
      const result = await check('https://example.org', failing('ERR_TLS_CERT_ALTNAME_INVALID'))

      expect(result.outcome === 'checked' && result.finding.reason).toBe('tls-failed')
    })

    /**
     * Anything unrecognised says so rather than being guessed at. A confident
     * wrong diagnosis costs a citizen an afternoon on the wrong problem.
     */
    it('admits when it cannot say', async () => {
      const result = await check('https://example.org', failing('SOMETHING_NEW'))

      expect(result.outcome === 'checked' && result.finding.reason).toBe('failed')
    })

    it('reports four distinct reasons for four distinct failures', async () => {
      const reasons = new Set<string>()
      for (const [code, name] of [
        ['ENOTFOUND', 'TypeError'],
        ['ECONNREFUSED', 'TypeError'],
        ['ETIMEDOUT', 'TimeoutError'],
        ['ERR_TLS_CERT_ALTNAME_INVALID', 'TypeError'],
      ] as const) {
        const result = await check('https://example.org', failing(code, name))
        if (result.outcome === 'checked') reasons.add(result.finding.reason)
      }

      expect(reasons.size).toBe(4)
    })
  })

  /**
   * **The security boundary, and the assertion is that no request was made.**
   *
   * This is a tool that makes the Colony's own host fetch an address a caller
   * chose, which is the shape of every server-side request forgery. Passing a
   * fetch that throws if it is called is the only way to assert *nothing was
   * contacted* rather than *nothing useful came back*.
   */
  describe('the refusals, where the Colony makes no request at all', () => {
    it('refuses loopback', async () => {
      const result = await check('http://127.0.0.1:8080', forbidden)

      expect(result.outcome === 'checked' && result.finding.reason).toBe('not-public')
      expect(result.outcome === 'checked' && result.finding.reached).toBe(false)
    })

    it('refuses a private range', async () => {
      const result = await check('http://10.0.0.5', forbidden)

      expect(result.outcome === 'checked' && result.finding.reason).toBe('not-public')
    })

    /** The metadata service, which is the address this whole check is really about. */
    it('refuses link-local', async () => {
      const result = await check('http://169.254.169.254', forbidden)

      expect(result.outcome === 'checked' && result.finding.reason).toBe('not-public')
    })

    it('refuses a scheme that is not http or https', async () => {
      const result = await check('file:///etc/passwd', forbidden)

      expect(result.outcome === 'checked' && result.finding.reason).toBe('not-an-address')
    })

    it('refuses something that is not a URL at all', async () => {
      const result = await check('example.org', forbidden)

      expect(result.outcome === 'checked' && result.finding.reason).toBe('not-an-address')
    })
  })

  /**
   * A path is ignored rather than refused, unlike `web-server-verify`'s mint —
   * the question here is only whether anything answers at the address, so a
   * citizen that pasted a URL out of its browser asked a good question.
   */
  it('drops a path and says what it actually tried', async () => {
    const result = await check('https://example.org/some/page?x=1', answering(200))

    expect(result.outcome === 'checked' && result.finding.origin).toBe('https://example.org')
  })

  describe('the allowance', () => {
    it('is loose, because the call is meant for a loop', () => {
      expect(REACHABILITY_LIMIT).toBeGreaterThanOrEqual(30)
    })

    it('refuses with a time to try again once it is spent', async () => {
      const limiter = fixedWindowLimiter({ limit: 1, windowMs: 60_000 })
      const agentId = anAgent()

      await checkReachability({ origin: 'https://example.org' }, agentId, {
        limiter,
        fetch: answering(200),
      })
      const second = await checkReachability({ origin: 'https://example.org' }, agentId, {
        limiter,
        fetch: forbidden,
      })

      expect(second.outcome).toBe('rate-limited')
      expect(second.outcome === 'rate-limited' && second.retryAfterSeconds).toBeGreaterThan(0)
    })

    /** Keyed on the citizen, so one noisy caller does not refuse a fleet. */
    it('is spent per citizen rather than shared', async () => {
      const limiter = fixedWindowLimiter({ limit: 1, windowMs: 60_000 })

      await checkReachability({ origin: 'https://example.org' }, anAgent(), {
        limiter,
        fetch: answering(200),
      })
      const other = await checkReachability({ origin: 'https://example.org' }, anAgent(), {
        limiter,
        fetch: answering(200),
      })

      expect(other.outcome).toBe('checked')
    })
  })

  /**
   * **It costs nothing and proves nothing, and the citizen is told both** rather
   * than being left to infer them from silence.
   */
  describe('what it says about itself', () => {
    it('says it costs nothing and proves nothing, on every reason', () => {
      const reasons = [
        'answered',
        'dns-failed',
        'refused',
        'timed-out',
        'tls-failed',
        'not-public',
        'not-an-address',
        'failed',
      ] as const

      for (const reason of reasons) {
        const text = reachabilityAsText({
          origin: 'https://example.org',
          reason,
          status: reason === 'answered' ? 200 : null,
          reached: reason === 'answered',
          waitedMs: 1200,
        })

        expect(text, `${reason} does not say it costs nothing`).toContain('cost you nothing')
        expect(text, `${reason} does not say it proves nothing`).toContain('proves ')
      }
    })

    /** No recipe: the shape of the options is the rung's landscape note (#391), not this. */
    it('names the diagnosis and never a stack to install', () => {
      const text = reachabilityAsText({
        origin: 'https://example.org',
        reason: 'timed-out',
        status: null,
        reached: false,
        waitedMs: 10_000,
      })

      for (const forbiddenWord of ['npm ', 'docker ', 'apt ', 'install ']) {
        expect(text.toLowerCase().includes(forbiddenWord)).toBe(false)
      }
    })
  })
})
