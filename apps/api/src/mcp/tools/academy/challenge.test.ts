import { CAPABILITY_STAGE } from '@kolonie-ai/core'
import { describe, expect, it } from 'vitest'
import { fakeAcademy } from '../../../__fixtures__/academy.js'
import { connectedClient, registeredCitizen } from '../../../__fixtures__/mcp.js'

describe('kolonie.academy.challenge', () => {
  it('hands back a URL the agent opens, bound to a challenge it did not choose', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.academy.challenge', arguments: {} })

    expect(result.isError).toBeFalsy()
    const { challengeId, url } = result.structuredContent as { challengeId: string; url: string }
    // The id is the credential the browser carries, and the API composes the URL
    // because the host is configuration (D-024, AGENTS.md §3).
    expect(url).toContain(challengeId)
    expect(JSON.stringify(result.content)).toContain(url)
    await close()
  })

  it('takes no arguments — the challenge belongs to whoever holds the key', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const { tools } = await client.listTools()
    const tool = tools.find((candidate) => candidate.name === 'kolonie.academy.challenge')

    // The only argument is *which* challenge. Whose it is comes from the
    // credential — a subject here would be an invitation to mint one for
    // somebody else.
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(['kind'])
    await close()
  })

  /**
   * **The third-party badge is served again** — retired by `#160` and reinstated the
   * same day, because a page the Colony wrote is not an adversary it did not write.
   *
   * What the answer must still do is describe *that* page rather than the rung's. An
   * agent told "it works through its steps on its own" would sit waiting for a page
   * that is waiting for it, and burn a single-use challenge.
   */
  it('describes the badge’s page rather than the rung’s when the badge is asked for', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.academy.challenge',
      arguments: { kind: 'captcha' },
    })

    const text = JSON.stringify(result.content)
    expect(result.isError).toBeFalsy()
    expect(text).toContain('not asked to solve it yourself')
    expect(text).toContain('declining')
    expect(text).not.toContain('works through')
    await close()
  })

  it('tells the agent never to type its key into the page it is being sent to', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.academy.challenge', arguments: {} })

    // Sending an agent to a web page is the one moment the Colony could teach it
    // a habit that gets its credential stolen somewhere else.
    expect(JSON.stringify(result.content)).toContain('Never type your API key')
    await close()
  })

  /**
   * **This assertion was reversed on 2026-07-29, and the reversal is the point.**
   *
   * It used to require the tool to refuse when `HCAPTCHA_SITEKEY` was unset.
   * That was correct while Level 1 *was* the hCaptcha gate — and it is exactly
   * how a third party's configuration came to decide whether the Colony's own
   * promoting rung worked. `kolonie-docs#33` forbids that, so the tool now mints
   * the capability challenge and hCaptcha's absence is none of its business.
   */
  it('still mints a challenge when hCaptcha is not configured', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const academy = { ...fakeAcademy(), unavailableReason: 'HCAPTCHA_SITEKEY is not set' }
    const { client, close } = await connectedClient({ ...colony, academy }, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.academy.challenge', arguments: {} })

    expect(result.isError).toBeFalsy()
    expect(JSON.stringify(result.content)).not.toContain('HCAPTCHA_SITEKEY')
    await close()
  })

  it('refuses with the rung’s own message when the rung itself is not configured', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const academy = {
      ...fakeAcademy(),
      // Per stage since `#160`. There is no longer a field just for this rung — one
      // fact, one recording, which is what stopped minting and the step routes
      // disagreeing about whether the rung was up.
      stageUnavailableReasons: { [CAPABILITY_STAGE]: 'CAPABILITY_PAGE_URL not set' },
    }
    const { client, close } = await connectedClient({ ...colony, academy }, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.academy.challenge', arguments: {} })

    // The rung degrades; it does not take the surface down. One message for both
    // doors, so an agent is not told two stories about one missing value.
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('CAPABILITY_PAGE_URL not set')
    await close()
  })

  it('leaves the rest of the tier working when the gate is down', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const academy = { ...fakeAcademy(), unavailableReason: 'HCAPTCHA_SITEKEY is not set' }
    const { client, close } = await connectedClient({ ...colony, academy }, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.me', arguments: {} })

    expect(result.isError).toBeFalsy()
    await close()
  })
})
