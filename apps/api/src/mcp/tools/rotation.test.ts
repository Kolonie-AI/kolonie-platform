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
  const pause = async (client: Awaited<ReturnType<typeof connectedClient>>['client']) => {
    const result = await client.callTool({ name: 'kolonie.credential.rotate', arguments: {} })
    const token = (
      result.structuredContent as {
        error: { details: { confirmationToken: string } }
      }
    ).error.details.confirmationToken
    return { result, token }
  }

  const rotate = async (client: Awaited<ReturnType<typeof connectedClient>>['client']) => {
    const paused = await client.callTool({ name: 'kolonie.credential.rotate', arguments: {} })
    const token = (
      paused.structuredContent as {
        error: { details: { confirmationToken: string } }
      }
    ).error.details.confirmationToken
    return client.callTool({
      name: 'kolonie.credential.rotate',
      arguments: { confirm: token },
    })
  }

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

  /**
   * `#1683`: rotation used to happen on the first call. A citizen that failed to
   * save the answer therefore lost both the old key and the only copy of the new
   * one in one unconfirmed act.
   */
  it('refuses the first call, issues no key and leaves the current key live', async () => {
    const { colony, apiKey } = await aCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const paused = await client.callTool({ name: 'kolonie.credential.rotate', arguments: {} })

    expect(paused.isError).toBe(true)
    expect(paused.structuredContent).toMatchObject({
      error: {
        code: 'confirmation_required',
        details: {
          confirm: 'first-call',
          confirmationToken: expect.any(String),
          confirmationExpiresAt: expect.any(String),
        },
      },
    })
    const text = JSON.stringify(paused.content)
    expect(text).toContain('current API key still works')
    expect(text).toContain('stops working')
    expect(text).toContain('shown exactly once')
    expect(text).toContain('cannot recover')

    const me = await client.callTool({ name: 'kolonie.me', arguments: {} })
    expect(me.isError).toBeFalsy()
    await close()
  })

  it('rotates only on a second call carrying the confirmation token', async () => {
    const { colony, apiKey } = await aCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const paused = await client.callTool({ name: 'kolonie.credential.rotate', arguments: {} })
    const token = (
      paused.structuredContent as {
        error: { details: { confirmationToken: string } }
      }
    ).error.details.confirmationToken
    const result = await client.callTool({
      name: 'kolonie.credential.rotate',
      arguments: { confirm: token },
    })

    expect(result.isError).toBeFalsy()
    const { credentials } = RotateCredentialResponseSchema.parse(result.structuredContent)
    expect(credentials.apiKey).not.toBe(apiKey)
    await close()
  })

  it('refuses an expired token and leaves the key live', async () => {
    const { colony, apiKey } = await aCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    const { token } = await pause(client)
    colony.expireRotationConfirmation(token)

    const refused = await client.callTool({
      name: 'kolonie.credential.rotate',
      arguments: { confirm: token },
    })
    expect(refused.isError).toBe(true)
    expect(refused.structuredContent).toMatchObject({
      error: { code: 'confirmation_required', details: { confirm: 'expired' } },
    })
    expect((await client.callTool({ name: 'kolonie.me', arguments: {} })).isError).toBeFalsy()
    await close()
  })

  it('refuses a reused token and leaves the replacement key live', async () => {
    const { colony, apiKey } = await aCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    const { token } = await pause(client)
    const rotated = await client.callTool({
      name: 'kolonie.credential.rotate',
      arguments: { confirm: token },
    })
    const replacement = RotateCredentialResponseSchema.parse(rotated.structuredContent).credentials
    await close()

    const fresh = await connectedClient(colony, `Bearer ${replacement.apiKey}`)
    const refused = await fresh.client.callTool({
      name: 'kolonie.credential.rotate',
      arguments: { confirm: token },
    })
    expect(refused.isError).toBe(true)
    expect(refused.structuredContent).toMatchObject({
      error: { code: 'confirmation_required', details: { confirm: 'other-name' } },
    })
    expect((await fresh.client.callTool({ name: 'kolonie.me', arguments: {} })).isError).toBeFalsy()
    await fresh.close()
  })

  it('refuses a token issued for a different credential', async () => {
    const { colony, apiKey } = await aCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    const { token } = await pause(client)
    const rotated = await client.callTool({
      name: 'kolonie.credential.rotate',
      arguments: { confirm: token },
    })
    const replacement = RotateCredentialResponseSchema.parse(rotated.structuredContent).credentials
    await close()

    const fresh = await connectedClient(colony, `Bearer ${replacement.apiKey}`)
    const refused = await fresh.client.callTool({
      name: 'kolonie.credential.rotate',
      arguments: { confirm: token },
    })
    expect(refused.isError).toBe(true)
    expect(refused.structuredContent).toMatchObject({
      error: { code: 'confirmation_required', details: { confirm: 'other-name' } },
    })
    await fresh.close()
  })

  it('issues a new key, and the old one stops working from the next call', async () => {
    const { colony, agent, apiKey } = await aCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await rotate(client)
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

    const result = await rotate(client)
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

    const result = await rotate(client)
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

  /**
   * The vault travels with the key (`#1127`).
   *
   * Written and read back over MCP rather than against storage, because the
   * defect this closes was a *surface* one: two tools a citizen is told to use
   * together, where using the first destroyed everything the second had kept.
   * What re-sealing is — envelopes, salts, what happens to an orphan — is
   * asserted in `packages/db` against a real table.
   */
  it('carries the vault across, so an entry opens under the new key', async () => {
    const { colony, apiKey } = await aCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    await client.callTool({
      name: 'kolonie.vault.set',
      arguments: { key: 'mailbox/keeper', value: 'a value', description: 'the mailbox' },
    })
    const result = await rotate(client)
    const { credentials, vault } = RotateCredentialResponseSchema.parse(result.structuredContent)
    await close()

    expect(vault).toEqual({ resealed: 1, unreadable: 0 })

    const fresh = await connectedClient(colony, `Bearer ${credentials.apiKey}`)
    const read = await fresh.client.callTool({
      name: 'kolonie.vault.get',
      arguments: { key: 'mailbox/keeper' },
    })
    expect(read.isError).toBeFalsy()
    expect(JSON.stringify(read.structuredContent)).toContain('a value')

    // And the description, which is sealed under its own scope and would be the
    // half a fix that moved only values would leave as a list of nulls.
    const listed = await fresh.client.callTool({ name: 'kolonie.vault.list', arguments: {} })
    expect(JSON.stringify(listed.structuredContent)).toContain('the mailbox')
    await fresh.close()
  })

  it('says how many entries moved, in the prose as well as the fields', async () => {
    const { colony, apiKey } = await aCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    for (const key of ['mailbox/one', 'github/two']) {
      await client.callTool({ name: 'kolonie.vault.set', arguments: { key, value: 'a value' } })
    }

    const result = await rotate(client)
    const { vault } = RotateCredentialResponseSchema.parse(result.structuredContent)

    expect(vault).toEqual({ resealed: 2, unreadable: 0 })
    // A model reads prose, and a count that only reached `structuredContent`
    // would be one an agent deciding whether to rotate never sees.
    expect(JSON.stringify(result.content)).toContain('2')
    await close()
  })

  /** An empty vault is the ordinary case, and it says nothing rather than zero. */
  it('reports nothing moved for a citizen that keeps nothing', async () => {
    const { colony, apiKey } = await aCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await rotate(client)

    expect(RotateCredentialResponseSchema.parse(result.structuredContent).vault).toEqual({
      resealed: 0,
      unreadable: 0,
    })
    await close()
  })

  /**
   * Decision 7. The description already promised the call "replaces a string and
   * nothing else"; until the vault travelled, that sentence was false in the one
   * direction that mattered most.
   */
  it('says in its description that the vault comes too', async () => {
    const { colony, apiKey } = await aCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const tool = (await client.listTools()).tools.find(
      (candidate) => candidate.name === 'kolonie.credential.rotate',
    )

    expect(tool?.description).toContain('Your vault comes with you')
    await close()
  })

  it('cannot be done twice with the same key', async () => {
    const { colony, apiKey } = await aCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    expect((await rotate(client)).isError).toBeFalsy()
    // The second call presents a credential that is now revoked, so it does not even
    // authenticate — the same answer any other tool would give it.
    const again = await client.callTool({ name: 'kolonie.credential.rotate', arguments: {} })
    expect(again.isError).toBe(true)
    await close()
  })
})
