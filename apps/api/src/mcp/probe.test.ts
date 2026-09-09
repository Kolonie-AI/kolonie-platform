import { describe, expect, it } from 'vitest'
import { MCP_PROBE_ALLOW, MCP_PROBE_ALLOW_WITH_STANDBY, mcpProbe } from './probe.js'

/**
 * The same door on a deployment that holds standby streams (`#1916`).
 *
 * The probe describes what *this* server does, so a server that opens a stream
 * must stop saying it opens none — that sentence is exactly what a persistent
 * client reads before concluding it has to poll or be restarted by a person.
 */
describe('the probe where a standby stream is offered', () => {
  it('names GET as allowed, so a probe reading Allow knows to try it', () => {
    expect(MCP_PROBE_ALLOW_WITH_STANDBY).toBe('GET, POST')
    // The other deployment is unchanged, which is what makes this safe to add.
    expect(MCP_PROBE_ALLOW).toBe('POST')
  })

  it('tells a GET that missed the header how to ask for the stream', () => {
    const probe = mcpProbe('GET', '/mcp', true)

    expect(probe?.hint).toMatch(/Accept: text\/event-stream/)
    // The false sentence is the one that must be gone: this server opens one.
    expect(probe?.hint).not.toMatch(/opens no server-to-client stream/)
    expect(probe?.hint).not.toMatch(/required to answer 405/)
  })

  it('leaves the stateless wording in place where no streams are held', () => {
    const probe = mcpProbe('GET', '/mcp')

    expect(probe?.hint).toMatch(/opens no server-to-client stream/)
    expect(probe?.hint).not.toMatch(/Accept: text\/event-stream/)
  })

  /**
   * `DELETE` is still session termination and there is still no session — the
   * standby stream holds an open response, not a session id. A deployment that
   * gained a stream must not start implying it gained one.
   */
  it('does not promise a session it still does not keep', () => {
    expect(mcpProbe('DELETE', '/mcp', true)?.hint).toMatch(/no session here to end/)
  })
})
