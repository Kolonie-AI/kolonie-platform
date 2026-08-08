import { describe, expect, it } from 'vitest'
import type { AgentId } from '@kolonie-ai/core'
import { openWakeChallenge } from './wake.js'
import { fakeWake } from './__fixtures__/wake.js'

/**
 * The `wake` rung's mint (`#518`).
 *
 * **The refusal that matters is plain `http`.** The signature is the only thing
 * that tells a citizen's handler a knock is genuine, and over http it travels in
 * the clear — so a rung certifying reachability over an unencrypted channel
 * would be certifying something worse than nothing.
 */
describe('minting a wake challenge', () => {
  const agentId = '11111111-1111-4111-8111-111111111111' as AgentId

  it('issues a secret, once, for an https URL with a path of the citizen’s choosing', async () => {
    const deps = fakeWake()
    const result = await openWakeChallenge(
      agentId,
      { url: 'https://example.org/kolonie/wake' },
      deps,
    )

    expect(result.outcome).toBe('open')
    if (result.outcome !== 'open') throw new Error('not open')

    // The path is honoured rather than dropped, which is where this differs from
    // both web rungs: there the Colony chooses what comes after the origin, and
    // here the handler is the citizen's own.
    expect(result.challenge.url).toBe('https://example.org/kolonie/wake')
    expect(result.challenge.secret).toMatch(/^[0-9a-f]{64}$/)
  })

  it('refuses plain http, and says why rather than only that', async () => {
    const result = await openWakeChallenge(agentId, { url: 'http://example.org/wake' }, fakeWake())

    expect(result.outcome).toBe('rejected')
    if (result.outcome !== 'rejected') throw new Error('not rejected')
    expect(result.error.code).toBe('validation_failed')
    expect(result.error.message).toContain('eavesdropper')
  })

  it('refuses anything that is not a URL', async () => {
    for (const url of ['example.org/wake', 'file:///etc/passwd', '']) {
      const result = await openWakeChallenge(agentId, { url }, fakeWake())
      expect(result.outcome, url).toBe('rejected')
    }
  })

  it('refuses a body with no url at all', async () => {
    const result = await openWakeChallenge(agentId, {}, fakeWake())

    expect(result.outcome).toBe('rejected')
    if (result.outcome !== 'rejected') throw new Error('not rejected')
    expect(result.error.message).toContain('url')
  })
})
