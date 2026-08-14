import { describe, expect, it } from 'vitest'
// @ts-expect-error — a measurement script, deliberately outside the TypeScript
// project, for the same reason `check-dist.mjs` is. Imported here because the one
// thing this script must never do is measure the wrong surface quietly.
import { hostOf, liveSourceFrom } from './measure-mcp-catalogue.mjs'

/**
 * `#888` requires the measurement to run **without a Kolonie credential in the
 * repository** — the caller supplies one through the environment. These are the
 * two halves of holding that: it refuses when the environment is empty, and it
 * never carries anything but a host into the file it writes.
 */
describe('where the endpoint and the credential come from', () => {
  it('takes both from the environment', () => {
    expect(
      liveSourceFrom({ KOLONIE_MCP_URL: 'https://mcp.example/x', KOLONIE_API_KEY: 'k' }),
    ).toEqual({ url: 'https://mcp.example/x', key: 'k' })
  })

  /**
   * **The rejection case.** A default endpoint would produce a run that measured
   * some other Colony and said nothing about it — and the figure outlives the
   * run in a committed file, so the mistake is discovered by somebody quoting
   * it. The refusal names what is missing, because a script that fails without
   * saying which variable is unset gets a credential pasted onto the command
   * line by the third attempt.
   */
  it('refuses rather than defaulting to an endpoint of its own', () => {
    expect(() => liveSourceFrom({})).toThrow(/KOLONIE_MCP_URL and KOLONIE_API_KEY/)
    expect(() => liveSourceFrom({ KOLONIE_MCP_URL: 'https://mcp.example' })).toThrow(
      /KOLONIE_API_KEY/,
    )
    // An empty variable is unset. A shell exports one by writing `KOLONIE_API_KEY=`
    // in a file it forgot to fill in, and that must not read as a credential.
    expect(() =>
      liveSourceFrom({ KOLONIE_MCP_URL: 'https://mcp.example', KOLONIE_API_KEY: '' }),
    ).toThrow(/KOLONIE_API_KEY/)
  })

  it('says a key may not be an argument, so nobody reaches for one', () => {
    expect(() => liveSourceFrom({})).toThrow(/neither is accepted as an argument/)
  })
})

describe('what the report says it measured', () => {
  /**
   * The host and nothing else. A path or a query string can carry a token, and
   * this string is written into a committed file — the host is the whole of what
   * a reader needs in order to know which Colony this was.
   */
  it('records the host and drops the rest of the URL', () => {
    expect(hostOf('https://mcp.example/mcp?session=secret')).toBe('mcp.example')
    expect(hostOf('http://mcp.example:3000/mcp')).toBe('mcp.example:3000')
  })

  it('names an unparseable URL instead of throwing in the middle of a measurement', () => {
    expect(hostOf('not a url')).toBe('an unparseable URL')
  })
})
