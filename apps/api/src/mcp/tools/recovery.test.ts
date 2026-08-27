import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { ApiKeySchema } from '@kolonie-ai/core'
import { anonymousClient, connectedClient, registeredCitizen } from '../../__fixtures__/mcp.js'

const API_KEY = ApiKeySchema.parse(`kol_${'n'.repeat(48)}`)

describe('credential recovery over MCP', () => {
  it('offers challenge and recovery without a key, but not nomination', async () => {
    const { client, close } = await anonymousClient()
    const names = (await client.listTools()).tools.map((tool) => tool.name)

    expect(names).toContain('kolonie.credential.recovery.challenge')
    expect(names).toContain('kolonie.credential.recovery.recover')
    expect(names).not.toContain('kolonie.credential.recovery.nominate')
    await close()
  })

  it('offers nomination to an authenticated citizen', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain(
      'kolonie.credential.recovery.nominate',
    )
    await close()
  })

  it('puts the permanent vault-loss warning before the new key', async () => {
    const { colony, agent } = await registeredCitizen({ name: 'returning' })
    colony.recoveryDesk.setRecovery({
      outcome: 'recovered',
      agentId: agent.id,
      credentialId: randomUUID(),
      apiKey: API_KEY,
      issuedAt: '2026-08-27T00:01:00.000Z',
      strandedVaultEntries: 3,
    })
    const { client, close } = await connectedClient(colony)

    const result = await client.callTool({
      name: 'kolonie.credential.recovery.recover',
      arguments: { handle: 'returning', nonce: 'nonce-to-sign', signature: 'a-signature' },
    })
    const content = result.content as Array<{ type: string; text: string }>
    const text = content[0]!.text

    expect(result.isError).toBeFalsy()
    expect(text).toContain('nothing can ever open')
    expect(text).toContain('kolonie.vault.delete')
    expect(text.indexOf('nothing can ever open')).toBeLessThan(text.indexOf(API_KEY))
    await close()
  })

  it('does not disclose why a proof was refused', async () => {
    const { colony } = await registeredCitizen({ name: 'returning' })
    colony.recoveryDesk.setRecovery({ outcome: 'refused' })
    const { client, close } = await connectedClient(colony)

    const result = await client.callTool({
      name: 'kolonie.credential.recovery.recover',
      arguments: { handle: 'returning', nonce: 'spent', signature: 'wrong' },
    })

    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({ error: { code: 'unauthorized' } })
    expect(JSON.stringify(result)).not.toContain('expired')
    expect(JSON.stringify(result)).not.toContain('signature was wrong')
    await close()
  })
})
