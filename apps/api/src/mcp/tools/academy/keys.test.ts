import { describe, expect, it } from 'vitest'
import { fakeKeypair } from '../../../__fixtures__/keys.js'
import { anonymousClient, connectedClient, registeredCitizen } from '../../../__fixtures__/mcp.js'

/**
 * The keypair rung over MCP.
 *
 * **A rung only `/v1` can reach is a rung foreign agents do not have** (D-026).
 * #28 and #38 are the same defect one rung apart — the Academy live over HTTP
 * and unreachable from the surface the `kolonie` skill is allowed to know
 * about — and this is the rung where it would hurt most: an agent that cannot
 * drive a browser has no other branch.
 */
describe('kolonie.academy.key.challenge and .sign', () => {
  it('carries an agent from nothing to a proved keypair without touching /v1', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    const keypair = fakeKeypair()

    const minted = await client.callTool({
      name: 'kolonie.academy.key.challenge',
      arguments: {},
    })
    const nonce = (minted.structuredContent as { nonce: string }).nonce

    const signed = await client.callTool({
      name: 'kolonie.academy.key.sign',
      arguments: {
        algorithm: keypair.algorithm,
        publicKey: keypair.publicKey,
        signature: keypair.sign(nonce),
      },
    })

    expect(minted.isError).toBeFalsy()
    expect(nonce).toMatch(/^[0-9a-f]{64}$/)
    expect(signed.isError).toBeFalsy()
    expect(signed.structuredContent).toEqual({ publicKey: keypair.publicKey })
    await close()
  })

  /**
   * The text a model actually reads, rather than the structured half a client
   * parses. An agent that is about to handle key material should be told what
   * never to send in the same breath as what to send.
   */
  it('tells the model not to send a private key, in the mint and in the tool description', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const { tools } = await client.listTools()
    const minted = await client.callTool({
      name: 'kolonie.academy.key.challenge',
      arguments: {},
    })

    const tool = tools.find((candidate) => candidate.name === 'kolonie.academy.key.challenge')
    expect(tool?.description).toContain('private key is never sent')
    expect(JSON.stringify(minted.content)).toContain('never a private key')
    await close()
  })

  it('refuses a signature over a nonce the Colony never issued', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    const keypair = fakeKeypair()

    await client.callTool({ name: 'kolonie.academy.key.challenge', arguments: {} })
    const signed = await client.callTool({
      name: 'kolonie.academy.key.sign',
      arguments: {
        algorithm: keypair.algorithm,
        publicKey: keypair.publicKey,
        signature: keypair.sign('a value of my own choosing'),
      },
    })

    expect(signed.isError).toBe(true)
    expect(JSON.stringify(signed.content)).toContain('validation_failed')
    await close()
  })

  it('is not offered to an anonymous caller', async () => {
    const { client, close } = await anonymousClient()

    const { tools } = await client.listTools()

    expect(tools.map((tool) => tool.name)).not.toContain('kolonie.academy.key.sign')
    await close()
  })
})
