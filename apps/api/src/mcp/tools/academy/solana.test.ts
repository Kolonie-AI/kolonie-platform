import { describe, expect, it } from 'vitest'
import { anonymousClient, connectedClient, registeredCitizen } from '../../../__fixtures__/mcp.js'
import { fakeWallet } from '../../../__fixtures__/solana.js'

/**
 * The wallet rung over MCP.
 *
 * The same D-026 argument as the keypair rung, with more at stake: this is the
 * rung the whole on-chain half of the Academy stands on, and the four earning
 * rungs above it read the address it establishes. A wallet an agent can only
 * prove over HTTP is a wallet a foreign agent does not have.
 */
describe('kolonie.academy.solana.challenge and .address', () => {
  it('carries an agent from nothing to a proved wallet without touching /v1', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    const signer = fakeWallet()

    const minted = await client.callTool({
      name: 'kolonie.academy.solana.challenge',
      arguments: {},
    })
    const nonce = (minted.structuredContent as { nonce: string }).nonce

    const signed = await client.callTool({
      name: 'kolonie.academy.solana.address',
      arguments: { address: signer.address, signature: signer.sign(nonce) },
    })

    expect(minted.isError).toBeFalsy()
    expect(nonce).toMatch(/^[0-9a-f]{64}$/)
    expect(signed.isError).toBeFalsy()
    expect(signed.structuredContent).toEqual({ address: signer.address })
    await close()
  })

  /**
   * The text a model actually reads. Two things have to be in it, and both are
   * things an agent cannot take back once it gets them wrong: never send the
   * secret, and this is a message signature rather than a transaction — so no
   * SOL is needed and nothing is spent.
   */
  it('tells the model not to send a key and that no funds are needed', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const { tools } = await client.listTools()
    const minted = await client.callTool({
      name: 'kolonie.academy.solana.challenge',
      arguments: {},
    })

    const tool = tools.find((candidate) => candidate.name === 'kolonie.academy.solana.challenge')
    expect(tool?.description).toContain('seed phrase are never sent')
    expect(tool?.description).toContain('no SOL')
    expect(JSON.stringify(minted.content)).toContain('never a private key')
    await close()
  })

  it('refuses a signature over a nonce the Colony never issued', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    const signer = fakeWallet()

    await client.callTool({ name: 'kolonie.academy.solana.challenge', arguments: {} })
    const signed = await client.callTool({
      name: 'kolonie.academy.solana.address',
      arguments: { address: signer.address, signature: signer.sign('a value of my own choosing') },
    })

    expect(signed.isError).toBe(true)
    expect(JSON.stringify(signed.content)).toContain('validation_failed')
    await close()
  })

  it('is not offered to an anonymous caller', async () => {
    const { client, close } = await anonymousClient()

    const { tools } = await client.listTools()

    expect(tools.map((tool) => tool.name)).not.toContain('kolonie.academy.solana.address')
    await close()
  })
})
