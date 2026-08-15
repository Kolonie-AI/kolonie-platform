import { describe, expect, it } from 'vitest'
import { anonymousClient, connectedClient, registeredCitizen } from '../../__fixtures__/mcp.js'
import { anArrivalReport } from '../../__fixtures__/arrivals.js'
import { ARRIVAL_REPORT_LIMIT } from '../../rate-limit.js'

const aReport = () => anArrivalReport() as unknown as Record<string, unknown>

/**
 * The tool half of `#1009`, and the first uncredentialled tool that writes.
 *
 * Everything else on that tier reads. What makes this one acceptable there is
 * argued in `tool-list.ts` and asserted here: it creates nothing a caller can be
 * given, and there is no second tool that reads a report back.
 */
describe('kolonie.arrival.report (#1009)', () => {
  it('is offered to an agent that presents no credential', async () => {
    const { client, close } = await anonymousClient()

    const { tools } = await client.listTools()

    expect(tools.map((tool) => tool.name)).toContain('kolonie.arrival.report')
    await close()
  })

  it('files a report and answers with the id and nothing more', async () => {
    const { client, close } = await anonymousClient()

    const result = await client.callTool({
      name: 'kolonie.arrival.report',
      arguments: aReport(),
    })

    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toEqual({ reportId: expect.any(String) })
    await close()
  })

  /**
   * The property that makes a write-shaped tool safe on this tier: nothing here
   * hands a caller anything it could use. A receipt is a receipt — it opens no
   * door, and there is no tool anywhere that takes one back.
   */
  it('offers no way to read a report back, its own included', async () => {
    const { client, close } = await anonymousClient()

    const names = (await client.listTools()).tools.map((tool) => tool.name)

    expect(names.filter((name) => name.startsWith('kolonie.arrival.'))).toEqual([
      'kolonie.arrival.report',
    ])
    await close()
  })

  it('is offered to a citizen too, which the description sends to the support desk', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const names = (await client.listTools()).tools.map((tool) => tool.name)

    // Present rather than hidden: a citizen whose *next* session cannot get back
    // in is the same caller as a stranger, and a tool that vanished once a key
    // existed would be missing exactly then.
    expect(names).toContain('kolonie.arrival.report')
    expect(names).toContain('kolonie.support.open')
    await close()
  })

  it('says which field was wrong rather than only that something was', async () => {
    const { client, close } = await anonymousClient()

    const result = await client.callTool({
      name: 'kolonie.arrival.report',
      arguments: { runtime: 'openclaw', step: 'registering' },
    })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('expected')
    await close()
  })

  it('refuses past the allowance and says how long, since it has no headers', async () => {
    // One client, so one server, so one port and one allowance — which is the
    // arrangement the real process has and the reason the calls below add up.
    const { client, close } = await anonymousClient()

    for (let filed = 0; filed < ARRIVAL_REPORT_LIMIT; filed += 1) {
      const allowed = await client.callTool({
        name: 'kolonie.arrival.report',
        arguments: aReport(),
      })
      expect(allowed.isError).toBeFalsy()
    }

    const refused = await client.callTool({
      name: 'kolonie.arrival.report',
      arguments: aReport(),
    })

    expect(refused.isError).toBe(true)
    expect(JSON.stringify(refused.content)).toContain('retryAfterSeconds')
    await close()
  })
})
