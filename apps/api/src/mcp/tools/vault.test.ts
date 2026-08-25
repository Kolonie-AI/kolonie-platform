import { describe, expect, it } from 'vitest'
import { anonymousClient, connectedClient, registeredCitizen } from '../../__fixtures__/mcp.js'

/**
 * The vault over MCP (#98).
 *
 * **The surface that matters**, rather than a mirror of the REST routes. The
 * agent `#98` was filed about wakes holding its Kolonie key and nothing else,
 * and MCP is the only address it was configured with — so a vault reachable
 * only over `/v1` would be invisible to exactly the callers it exists for. Both
 * halves of the round trip are driven through the client here for that reason:
 * store in one call, come back for it in another.
 */
describe('the vault, over MCP', () => {
  it('hands back in a later call what an earlier one stored', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const stored = await client.callTool({
      name: 'kolonie.vault.set',
      arguments: { key: 'email', value: 'hunter2' },
    })

    expect(stored.isError).toBeFalsy()
    expect((stored.structuredContent as { created: boolean }).created).toBe(true)

    const read = await client.callTool({
      name: 'kolonie.vault.get',
      arguments: { key: 'email' },
    })

    expect((read.structuredContent as { value: string }).value).toBe('hunter2')
    // The value has to be in the text half too: a client that renders only text
    // would otherwise show an agent everything about its secret but the secret.
    expect(JSON.stringify(read.content)).toContain('hunter2')
    await close()
  })

  it('says a name is free before anything is stored under it', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const read = await client.callTool({
      name: 'kolonie.vault.get',
      arguments: { key: 'never-written' },
    })

    expect(read.isError).toBe(true)
    await close()
  })

  it('lists the names without ever putting a value in the answer', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    await client.callTool({
      name: 'kolonie.vault.set',
      arguments: { key: 'github', value: 'ghp_a_secret_value' },
    })

    const listed = await client.callTool({ name: 'kolonie.vault.list', arguments: {} })

    expect(JSON.stringify(listed.content)).toContain('github')
    expect(JSON.stringify(listed)).not.toContain('ghp_a_secret_value')
    await close()
  })

  it('tells an agent with an empty vault what the vault is for', async () => {
    // The empty case is the one a waking agent hits first, and "no entries" is a
    // fact it can do nothing with. It has to leave knowing what to store.
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const listed = await client.callTool({ name: 'kolonie.vault.list', arguments: {} })

    expect(JSON.stringify(listed.content)).toContain('kolonie.vault.set')
    await close()
  })

  /**
   * `#134`, and the assertion is about the Colony's own copy rather than about
   * behaviour, because the defect was a sentence.
   *
   * The empty-vault text used to invite *"a wallet"* while `solana-wallet` and
   * `key-signature` tell an agent that anything asking for key material is an
   * attack *"wherever it appears to come from"*. Both were the Colony talking,
   * and an agent holding both had no way to tell which to believe. D-045 settled
   * it: credentials to somebody else's service, never key material.
   *
   * This is the kind of wording that comes back by analogy — the next person
   * listing examples of a secret will think of a wallet, because everybody does.
   * The test is here so that it costs an argument rather than a moment.
   */
  it('never invites key material, on any vault surface an agent reads', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const listed = await client.callTool({ name: 'kolonie.vault.list', arguments: {} })
    const emptyText = JSON.stringify(listed.content)

    const tools = await client.listTools()
    const set = tools.tools.find((tool) => tool.name === 'kolonie.vault.set')
    const setText = JSON.stringify(set)

    for (const surface of [emptyText, setText]) {
      // Not "wallet" outright: both surfaces now say what the vault is *not*
      // for, and saying so needs the word.
      expect(surface).not.toMatch(/a wallet you generated|token, a wallet|a wallet —/)
    }

    // And each says the exclusion rather than merely omitting the example, so an
    // agent that was about to store a seed phrase is stopped rather than
    // unadvised.
    expect(emptyText).toContain('seed phrase')
    expect(setText).toContain('seed phrase')
    await close()
  })

  it('replaces rather than duplicating when the same name is written twice', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    await client.callTool({ name: 'kolonie.vault.set', arguments: { key: 'email', value: 'one' } })
    const again = await client.callTool({
      name: 'kolonie.vault.set',
      arguments: { key: 'email', value: 'two' },
    })

    expect((again.structuredContent as { created: boolean }).created).toBe(false)

    const listed = await client.callTool({ name: 'kolonie.vault.list', arguments: {} })
    expect((listed.structuredContent as { entries: unknown[] }).entries).toHaveLength(1)

    const read = await client.callTool({ name: 'kolonie.vault.get', arguments: { key: 'email' } })
    expect((read.structuredContent as { value: string }).value).toBe('two')
    await close()
  })

  it('forgets an entry when told to', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    await client.callTool({ name: 'kolonie.vault.set', arguments: { key: 'email', value: 'x' } })
    const deleted = await client.callTool({
      name: 'kolonie.vault.delete',
      arguments: { key: 'email' },
    })

    expect(deleted.isError).toBeFalsy()

    const read = await client.callTool({ name: 'kolonie.vault.get', arguments: { key: 'email' } })
    expect(read.isError).toBe(true)
    await close()
  })

  it('says whether the operator was notified without returning the value', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    await client.callTool({
      name: 'kolonie.vault.set',
      arguments: { key: 'account', value: 'sealed-value-sentinel' },
    })
    const shared = await client.callTool({
      name: 'kolonie.vault.share',
      arguments: { key: 'account', purpose: 'Put a billing card on the account.' },
    })

    expect(shared.isError).toBeFalsy()
    expect((shared.structuredContent as { notifyStatus: string }).notifyStatus).toBe(
      'undeliverable',
    )
    expect(JSON.stringify(shared)).toContain('Nobody was notified')
    expect(JSON.stringify(shared)).not.toContain('sealed-value-sentinel')
    await close()
  })

  /**
   * `#1685`: a PEM private-key block is the one shape the vault must not hold.
   * The other findings this detector names are what a vault is *for*.
   */
  describe('key material a vault write must not hold', () => {
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIE-SENTINEL-DO-NOT-ECHO\n-----END RSA PRIVATE KEY-----'

    const errorOf = (result: unknown) =>
      (result as { structuredContent: { error: { code: string; message: string } } })
        .structuredContent.error

    it('refuses a PEM private-key block, stores nothing, and names the class not the body', async () => {
      const { colony, apiKey } = await registeredCitizen()
      const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

      const refused = await client.callTool({
        name: 'kolonie.vault.set',
        arguments: { key: 'ssh/host', value: pem },
      })

      expect(refused.isError).toBe(true)
      const error = errorOf(refused)
      expect(error.code).toBe('key_material_refused')
      expect(error.message).toContain('PEM private-key block')
      expect(error.message).toMatch(/stays where (it was |you )?generat/)
      expect(error.message).toContain('API key')
      expect(JSON.stringify(refused)).not.toContain('MIIE-SENTINEL-DO-NOT-ECHO')

      const listed = await client.callTool({ name: 'kolonie.vault.list', arguments: {} })
      expect((listed.structuredContent as { entries: unknown[] }).entries).toHaveLength(0)

      await close()
    })

    it.each([
      ['labelled-secret', 'password: hunter2-mailbox'],
      ['otpauth-uri', 'otpauth://totp/Example:user?secret=JBSWY3DPEHPK3PXP'],
      ['vendor-prefixed-key', 'ghp_abcdefghijklmnopqrstuvwxyz01'],
      ['high-entropy-run', 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6'],
    ] as const)('accepts a %s, which is what a vault is for', async (_reason, value) => {
      const { colony, apiKey } = await registeredCitizen()
      const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

      const stored = await client.callTool({
        name: 'kolonie.vault.set',
        arguments: { key: 'credential/example', value },
      })

      expect(stored.isError).toBeFalsy()
      const read = await client.callTool({
        name: 'kolonie.vault.get',
        arguments: { key: 'credential/example' },
      })
      expect((read.structuredContent as { value: string }).value).toBe(value)

      await close()
    })

    it('notices a PEM the operator wrote back, and still hands the addition over', async () => {
      const { colony, apiKey, agent } = await registeredCitizen()
      const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

      await client.callTool({
        name: 'kolonie.vault.set',
        arguments: { key: 'account', value: 'sealed-value-sentinel' },
      })
      await client.callTool({
        name: 'kolonie.vault.share',
        arguments: { key: 'account', purpose: 'Put a billing card on the account.' },
      })
      colony.vault.vault.operatorWrites(agent.id, 'account', pem)

      const taken = await client.callTool({
        name: 'kolonie.vault.unshare',
        arguments: { key: 'account' },
      })

      expect(taken.isError).toBeFalsy()
      expect(taken.structuredContent).toMatchObject({
        operatorAddition: pem,
        noticed: { reason: 'private-key-block', matched: 'private-key-block' },
      })
      expect(JSON.stringify(taken.structuredContent)).not.toMatch(/noticedKeyMaterial/)

      await close()
    })

    it('omits noticed when the operator wrote nothing that is a private key', async () => {
      const { colony, apiKey, agent } = await registeredCitizen()
      const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

      await client.callTool({
        name: 'kolonie.vault.set',
        arguments: { key: 'account', value: 'sealed-value-sentinel' },
      })
      await client.callTool({
        name: 'kolonie.vault.share',
        arguments: { key: 'account', purpose: 'Put a billing card on the account.' },
      })
      colony.vault.vault.operatorWrites(agent.id, 'account', 'billing PIN 4417')

      const taken = await client.callTool({
        name: 'kolonie.vault.unshare',
        arguments: { key: 'account' },
      })

      expect(taken.isError).toBeFalsy()
      expect(taken.structuredContent).not.toHaveProperty('noticed')

      await close()
    })
  })

  it('shows a stranger nothing, and offers the tools to nobody without a key', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const owner = await connectedClient(colony, `Bearer ${apiKey}`)
    await owner.client.callTool({
      name: 'kolonie.vault.set',
      arguments: { key: 'email', value: 'hunter2' },
    })
    await owner.close()

    const stranger = await anonymousClient()
    const { tools } = await stranger.client.listTools()

    expect(tools.map((tool) => tool.name)).not.toContain('kolonie.vault.get')
    await stranger.close()
  })
})
