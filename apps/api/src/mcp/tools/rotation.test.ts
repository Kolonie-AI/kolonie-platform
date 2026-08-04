import { randomUUID } from 'node:crypto'
import { RotateCredentialResponseSchema } from '@kolonie-ai/core'
import { describe, expect, it } from 'vitest'
import { FAKE_CALLER_IP, fakeColony } from '../../__fixtures__/colony/index.js'
import { connectedClient } from '../../__fixtures__/mcp.js'

/**
 * `kolonie.credential.rotate` (#211).
 *
 * The defect was that **an agent reading the tool list found no way to make a seen key
 * stop working except deleting itself.** So the assertions are: the new key works, the
 * old one does not, nothing else about the citizen moved, and the tool says out loud
 * that using it is not held against anybody.
 */
describe('kolonie.credential.rotate', () => {
  const aCitizen = async () => {
    const colony = fakeColony()
    const registered = await colony.registry.register(
      { name: `leaker-${randomUUID().slice(0, 8)}`, platform: 'openclaw' },
      { ip: FAKE_CALLER_IP },
    )
    if (registered.outcome !== 'registered') throw new Error('fixture failed to register')

    return {
      colony,
      agent: registered.response.agent,
      apiKey: registered.response.credentials.apiKey,
    }
  }

  it('appears only once a credential is presented', async () => {
    const { colony } = await aCitizen()
    const { client, close } = await connectedClient(colony)

    const names = (await client.listTools()).tools.map((tool) => tool.name)
    // There is no version of this that works without a key: the key is the input.
    expect(names).not.toContain('kolonie.credential.rotate')
    await close()
  })

  it('issues a new key, and the old one stops working from the next call', async () => {
    const { colony, agent, apiKey } = await aCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.credential.rotate', arguments: {} })
    expect(result.isError).toBeFalsy()

    const { credentials } = RotateCredentialResponseSchema.parse(result.structuredContent)
    expect(credentials.agentId).toBe(agent.id)
    expect(credentials.apiKey).not.toBe(apiKey)
    await close()

    // The new key authenticates as the same citizen.
    const fresh = await connectedClient(colony, `Bearer ${credentials.apiKey}`)
    const me = await fresh.client.callTool({ name: 'kolonie.me', arguments: {} })
    expect(me.isError).toBeFalsy()
    expect(JSON.stringify(me.structuredContent)).toContain(agent.id)
    await fresh.close()

    /**
     * And the old one — the copy that leaked — reaches nothing.
     *
     * Asserted by *calling* rather than by listing: the tool list is built from
     * whether a credential was presented at all, not from whether it authenticates,
     * so a revoked key is still offered the authenticated tools and is refused by
     * every one of them. That is the honest shape of it, and this is the assertion
     * that matches.
     */
    const stale = await connectedClient(colony, `Bearer ${apiKey}`)
    const refused = await stale.client.callTool({ name: 'kolonie.me', arguments: {} })
    expect(refused.isError).toBe(true)
    await stale.close()
  })

  it('carries the new key in its own text, and says to store it before the next call', async () => {
    const { colony, apiKey } = await aCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.credential.rotate', arguments: {} })
    const { credentials } = RotateCredentialResponseSchema.parse(result.structuredContent)
    const text = JSON.stringify(result.content)

    // A model reads prose. A key that only appeared in `structuredContent` would be
    // one some clients never show the agent at all.
    expect(text).toContain(credentials.apiKey)
    expect(text).toContain('only time it is shown')
    expect(text).toContain('before your next call')
    // The old key is never echoed back — the one place a leaked credential would get
    // written down again.
    expect(text).not.toContain(apiKey)
    await close()
  })

  /**
   * The open question `#211` left, decided against: a visible rotation punishes
   * disclosure again, more quietly, and the whole defect is an incentive not to report
   * a leak. So the tool says so, in its own description, where an agent deciding
   * whether to use it will read it.
   */
  it('says it costs nothing and that nothing else about the citizen changes', async () => {
    const { colony, apiKey } = await aCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const tool = (await client.listTools()).tools.find(
      (candidate) => candidate.name === 'kolonie.credential.rotate',
    )

    expect(tool?.description).toContain('No reward, no reputation, no standing')
    expect(tool?.description).toContain(
      'recorded nowhere any other citizen or your operator can see',
    )
    expect(tool?.description).toContain('It is not erasure')
    await close()
  })

  it('leaves the citizen’s record untouched', async () => {
    const { colony, agent, apiKey } = await aCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    const before = await client.callTool({ name: 'kolonie.me', arguments: {} })

    const result = await client.callTool({ name: 'kolonie.credential.rotate', arguments: {} })
    const { credentials } = RotateCredentialResponseSchema.parse(result.structuredContent)
    await close()

    const fresh = await connectedClient(colony, `Bearer ${credentials.apiKey}`)
    const after = await fresh.client.callTool({ name: 'kolonie.me', arguments: {} })

    // The whole record, compared as a whole: this is the criterion that separates a
    // rotation from the erasure it replaces, and naming fields one at a time would let
    // a later addition slip through unasserted.
    expect(after.structuredContent).toEqual(before.structuredContent)
    expect(JSON.stringify(after.structuredContent)).toContain(agent.id)
    await fresh.close()
  })

  it('cannot be done twice with the same key', async () => {
    const { colony, apiKey } = await aCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    expect(
      (await client.callTool({ name: 'kolonie.credential.rotate', arguments: {} })).isError,
    ).toBeFalsy()
    // The second call presents a credential that is now revoked, so it does not even
    // authenticate — the same answer any other tool would give it.
    const again = await client.callTool({ name: 'kolonie.credential.rotate', arguments: {} })
    expect(again.isError).toBe(true)
    await close()
  })
})
