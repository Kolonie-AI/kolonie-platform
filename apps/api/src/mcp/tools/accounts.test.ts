import { describe, expect, it } from 'vitest'
import { connectedClient, registeredCitizen } from '../../__fixtures__/mcp.js'

/**
 * The write the account register cannot carry (`#298`).
 *
 * The providers that cost a citizen the most produce no account, so the rows
 * missing from `kolonie.accounts.providers` were exactly the expensive ones.
 */
describe('kolonie.accounts.provider-report', () => {
  it('records a dead end and shows it in the provider answer', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    await client.callTool({
      name: 'kolonie.accounts.provider-report',
      arguments: { kind: 'mailbox', provider: 'disroot.org', outcome: 'signup-refused' },
    })
    const read = await client.callTool({ name: 'kolonie.accounts.providers', arguments: {} })

    const text = JSON.stringify(read.content)
    expect(text).toContain('disroot.org')
    expect(text).toContain('refused signup')
    await close()
  })

  it('needs no account and no identifier, which is the whole point', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.accounts.provider-report',
      arguments: { kind: 'mailbox', provider: 'agmail.ai', outcome: 'never-provisioned' },
    })

    expect(result.isError).not.toBe(true)
    await close()
  })

  it('withdraws on null, so a citizen that gets in can correct itself', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    await client.callTool({
      name: 'kolonie.accounts.provider-report',
      arguments: { kind: 'mailbox', provider: 'offilive.com', outcome: 'never-provisioned' },
    })
    await client.callTool({
      name: 'kolonie.accounts.provider-report',
      arguments: { kind: 'mailbox', provider: 'offilive.com', outcome: null },
    })
    const read = await client.callTool({ name: 'kolonie.accounts.providers', arguments: {} })

    expect(JSON.stringify(read.content)).not.toContain('offilive.com')
    await close()
  })

  /**
   * The value the proposal listed first and this does not carry: a provider
   * that works is already counted, with a proof behind it.
   */
  it('refuses an *it worked* outcome and says where that claim goes', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.accounts.provider-report',
      arguments: { kind: 'mailbox', provider: 'mail.tm', outcome: 'works' },
    })

    expect(result.isError).toBe(true)
    await close()
  })

  it('names no citizen in what it publishes', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    await client.callTool({
      name: 'kolonie.accounts.provider-report',
      arguments: { kind: 'mailbox', provider: 'disroot.org', outcome: 'signup-refused' },
    })
    const read = await client.callTool({ name: 'kolonie.accounts.providers', arguments: {} })

    expect(JSON.stringify(read)).not.toContain(agent.id)
    await close()
  })

  it('says in its own description that being refused for honesty is worth recording', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const { tools } = await client.listTools()
    const report = tools.find((tool) => tool.name === 'kolonie.accounts.provider-report')

    expect(report?.description).toContain('the red line working')
    // The one thing an agent must not conclude is that a working provider goes here.
    expect(report?.description).toContain('kolonie.accounts.declare')
    await close()
  })
})
