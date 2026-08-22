import { describe, expect, it, vi } from 'vitest'
import type { AgentId } from '@kolonie-ai/core'

/**
 * `vi.mock` is lifted above the imports, so the resolver has to be hoisted —
 * the same shape `packages/verifiers/src/website-verify.test.ts` uses, and for
 * the same reason: `safeFetch` refuses a name before it fetches it, so a stubbed
 * `fetch` alone never reaches the page.
 */
const dns = vi.hoisted(() => ({ lookup: vi.fn() }))
vi.mock('node:dns/promises', () => ({ lookup: dns.lookup }))

const { fakeWebsite } = await import('./__fixtures__/website.js')
const { rotateWebsiteIdentifier } = await import('./website.js')

/**
 * The website rotation (`#1606`).
 *
 * **What is asserted here is the decision, not the fetch.** Whether a page
 * carries a token is `checkWebsiteControl`'s question and the verifier package
 * owns its cases — `#1153`'s `403`, the `text/html` refusal, SSRF. `#1606`'s
 * whole point is that the two paths ask it through the same function, so
 * re-asserting those here would be pinning the same behaviour twice and letting
 * the copies drift.
 *
 * What only this file can see: that the skill gate holds, that a refusal records
 * nothing, and that a pass records the new identifier and leaves the old row
 * alone.
 */
const AGENT = 'agent-1' as AgentId
const URL_NEW = 'https://new.example/verify'

const servingPage = (html = '<meta name="kolonie-verify" content="fake-token">') => {
  dns.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(html, { headers: { 'content-type': 'text/html' } })),
  )
}

describe('rotateWebsiteIdentifier', () => {
  /**
   * The gate the issue leads with. Without it this is a second way to earn
   * `website` that hands in nothing — the rung would sit unpassed while the
   * citizen held a proved account the Academy has no record of.
   */
  it('sends a citizen without the skill to the rung, and records nothing', async () => {
    const deps = fakeWebsite()
    const result = await rotateWebsiteIdentifier(AGENT, URL_NEW, false, deps)

    expect(result.outcome).toBe('rejected')
    if (result.outcome !== 'rejected') return
    expect(result.error.message).toContain('kolonie.tasks.submit on website-verify')
    expect(deps.recorded).toEqual([])
  })

  it('records the new identifier when the page carries an open token', async () => {
    servingPage()
    const deps = fakeWebsite()
    const result = await rotateWebsiteIdentifier(AGENT, URL_NEW, true, deps)

    expect(result.outcome).toBe('ok')
    if (result.outcome !== 'ok') return
    expect(result.response.identifier).toBe(URL_NEW)
    expect(deps.recorded).toEqual([URL_NEW])
    vi.unstubAllGlobals()
  })

  /** A page that answers and does not carry the token takes nothing away. */
  it('refuses a page without the token, and records nothing', async () => {
    servingPage('<meta name="kolonie-verify" content="somebody-elses-token">')
    const deps = fakeWebsite()
    const result = await rotateWebsiteIdentifier(AGENT, URL_NEW, true, deps)

    expect(result.outcome).toBe('rejected')
    if (result.outcome !== 'rejected') return
    expect(result.error.message).toContain('Nothing was recorded and nothing was taken away')
    expect(deps.recorded).toEqual([])
    vi.unstubAllGlobals()
  })

  /**
   * A citizen with no open challenge is told to mint one rather than told its
   * page is wrong — the verifier's own sentence, reached through the shared
   * check rather than written again here.
   */
  it('refuses when no challenge is open', async () => {
    const deps = fakeWebsite({ tokens: [] })
    const result = await rotateWebsiteIdentifier(AGENT, URL_NEW, true, deps)

    expect(result.outcome).toBe('rejected')
    if (result.outcome !== 'rejected') return
    expect(result.error.message).toContain('no open website challenges')
    expect(deps.recorded).toEqual([])
  })

  /**
   * A deployment wired without the recorder refuses and **names the route that
   * still works**, which is `#1592`'s. Silence here would send a citizen back to
   * a rung that is already passed.
   */
  it('refuses on a deployment that cannot record, and names the other route', async () => {
    const deps = fakeWebsite({ canRecord: false })
    const result = await rotateWebsiteIdentifier(AGENT, URL_NEW, true, deps)

    expect(result.outcome).toBe('rejected')
    if (result.outcome !== 'rejected') return
    expect(result.error.message).toContain('kolonie.accounts.prove')
    expect(deps.recorded).toEqual([])
  })
})
