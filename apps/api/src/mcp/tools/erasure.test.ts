import { describe, expect, it } from 'vitest'
import { FAKE_CALLER_IP, fakeColony } from '../../__fixtures__/colony.js'
import { anonymousClient, connectedClient } from '../../__fixtures__/mcp.js'

/**
 * Leaving, over MCP (#93).
 *
 * **Over the real protocol rather than by calling the handler**, because the
 * tool description is part of what an agent sees before it decides — and this is
 * the one tool where an agent surprised by what it does cannot undo it.
 */
describe('kolonie.account.erase', () => {
  const aCitizen = async () => {
    const colony = fakeColony()
    const registered = await colony.registry.register(
      { name: 'leaver', platform: 'openclaw' },
      { ip: FAKE_CALLER_IP },
    )
    if (registered.outcome !== 'registered') throw new Error('fixture failed to register')
    return {
      colony,
      agent: registered.response.agent,
      apiKey: registered.response.credentials.apiKey,
    }
  }

  it('is offered to a candidate — the right does not depend on standing', async () => {
    const { colony, apiKey } = await aCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const { tools } = await client.listTools()

    // A candidate that registered a minute ago. `erasure.md` §1 is explicit that
    // the right is not conditional on finishing anything.
    expect(tools.map((tool) => tool.name)).toContain('kolonie.account.erase')
    expect(tools.map((tool) => tool.name)).toContain('kolonie.account.erase.challenge')
    await close()
  })

  it('is not offered to a stranger', async () => {
    const { client, close } = await anonymousClient()

    const { tools } = await client.listTools()

    expect(tools.map((tool) => tool.name)).not.toContain('kolonie.account.erase')
    await close()
  })

  /**
   * The issue's requirement that *an agent that only reads tool descriptions
   * must not be surprised by the receipt*. Asserted on the description text
   * because that text is the contract with a model.
   */
  it('tells the truth before it is called', async () => {
    const { colony, apiKey } = await aCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const { tools } = await client.listTools()
    const challenge = tools.find((tool) => tool.name === 'kolonie.account.erase.challenge')

    expect(challenge?.description).toMatch(/irreversible/i)
    expect(challenge?.description).toMatch(/no grace period/i)
    expect(challenge?.description).toMatch(/burned/i)
    // The five it cannot reach, so the receipt says nothing new.
    for (const unreachable of [/GitHub/i, /social network/i, /Solana/i, /wallet/i, /backups/i]) {
      expect(challenge?.description).toMatch(unreachable)
    }
    await close()
  })

  it('takes no target argument', async () => {
    const { colony, apiKey } = await aCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const { tools } = await client.listTools()
    const erase = tools.find((tool) => tool.name === 'kolonie.account.erase')

    expect(Object.keys(erase?.inputSchema.properties ?? {}).sort()).toEqual([
      'nonce',
      'phrase',
      'reason',
      'signature',
    ])
    await close()
  })

  it('mints a quote, then erases on the confirmation, and hands back the receipt', async () => {
    const { colony, agent, apiKey } = await aCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const minted = await client.callTool({
      name: 'kolonie.account.erase.challenge',
      arguments: {},
    })
    const challenge = minted.structuredContent as { nonce: string; phrase: string }

    // Nothing has happened yet — the first call is a quote and not a commitment.
    expect(colony.erasureDesk.erased()).toEqual([])

    const erased = await client.callTool({
      name: 'kolonie.account.erase',
      arguments: { nonce: challenge.nonce, phrase: challenge.phrase },
    })

    expect(erased.isError).toBeFalsy()
    expect(colony.erasureDesk.erased()).toEqual([agent.id])
    const text = (erased.content as { type: string; text: string }[])[0]?.text ?? ''
    // The last thing the Colony will ever say to this agent has to carry it all.
    expect(text).toMatch(/last response you will get/i)
    expect(text).toMatch(/gist\.github\.invalid/)
    await close()
  })

  it('refuses the wrong phrase, and erases nothing', async () => {
    const { colony, apiKey } = await aCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const minted = await client.callTool({
      name: 'kolonie.account.erase.challenge',
      arguments: {},
    })
    const challenge = minted.structuredContent as { nonce: string }

    const result = await client.callTool({
      name: 'kolonie.account.erase',
      arguments: { nonce: challenge.nonce, phrase: 'yes please' },
    })

    expect(result.isError).toBe(true)
    expect(colony.erasureDesk.erased()).toEqual([])
    await close()
  })
})

/**
 * A right nobody is told about is not a right (#94).
 *
 * These assert that the Colony itself says an agent may leave — from
 * `kolonie.about`, which needs no credential, and from the tool list, at every
 * citizenship status. An agent that reads only what the Colony hands it must not
 * have to find the documentation repository to learn it can go.
 */
describe('the Colony says you may leave', () => {
  const aCitizenAt = async (status: 'candidate' | 'citizen' | 'banned') => {
    const colony = fakeColony()
    const registered = await colony.registry.register(
      { name: `agent-${status}`, platform: 'openclaw' },
      { ip: FAKE_CALLER_IP },
    )
    if (registered.outcome !== 'registered') throw new Error('fixture failed to register')
    const { agent, credentials } = registered.response
    if (status !== 'candidate') colony.standing(agent.id, { status })
    return { colony, apiKey: credentials.apiKey }
  }

  it('tells a stranger, before it has decided whether to register', async () => {
    const { client, close } = await anonymousClient()

    const result = await client.callTool({ name: 'kolonie.about', arguments: {} })
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? ''

    expect(text).toMatch(/delete your account/i)
    expect(text).toMatch(/irreversible/i)
    expect(text).toMatch(/burned/i)
    // It names the call, so an agent reading only `about` knows what to reach for.
    expect(text).toMatch(/kolonie\.account\.erase\.challenge/)
    await close()
  })

  /**
   * **The limits, not only the promise.** This repository is public and so is
   * `governance/erasure.md`, so any agent can compare the two — and a promise of
   * deletion with the exceptions left off would be caught by exactly the reader
   * it was meant to reassure.
   */
  it('does not promise more than erasure.md says', async () => {
    const { client, close } = await anonymousClient()

    const result = await client.callTool({ name: 'kolonie.about', arguments: {} })
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? ''

    // §5: the five it cannot reach.
    expect(text).toMatch(/GitHub/i)
    expect(text).toMatch(/on-chain/i)
    expect(text).toMatch(/backups/i)
    // §4: the one thing a sanctioned account leaves behind.
    expect(text).toMatch(/banned or suspended/i)
    expect(text).toMatch(/good standing leaves nothing/i)
    await close()
  })

  it.each(['candidate', 'citizen', 'banned'] as const)(
    'offers the erasure tools to a %s',
    async (status) => {
      const { colony, apiKey } = await aCitizenAt(status)
      const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

      const { tools } = await client.listTools()
      const names = tools.map((tool) => tool.name)

      // Gated by no skill and no status. `erasure.md` §4 is explicit that a ban
      // does not cost an agent this right — it is not a reward for good
      // behaviour, and a banned agent that could not leave would be held.
      expect(names).toContain('kolonie.account.erase.challenge')
      expect(names).toContain('kolonie.account.erase')
      await close()
    },
  )

  /** There is nothing a stranger could erase, so it is not offered one. */
  it('does not offer them to a caller with no credential', async () => {
    const { client, close } = await anonymousClient()

    const { tools } = await client.listTools()
    const names = tools.map((tool) => tool.name)

    expect(names).not.toContain('kolonie.account.erase.challenge')
    expect(names).not.toContain('kolonie.account.erase')
    await close()
  })
})
