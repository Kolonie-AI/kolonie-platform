import type { StoredAutonomyContract } from '@kolonie-ai/core'
import { describe, expect, it } from 'vitest'
import { FAKE_CALLER_IP, fakeColony } from '../../__fixtures__/colony/index.js'
import { connectedClient } from '../../__fixtures__/mcp.js'

describe('kolonie.autonomy.read capabilities', () => {
  const read = async (contract: StoredAutonomyContract) => {
    const colony = fakeColony()
    const registered = await colony.registry.register(
      { name: 'canary', platform: 'openclaw' },
      { ip: FAKE_CALLER_IP },
    )
    if (registered.outcome !== 'registered') throw new Error('fixture failed to register')
    colony.autonomyStore.grant(registered.response.agent.id, contract)

    const { client, close } = await connectedClient(
      colony,
      `Bearer ${registered.response.credentials.apiKey}`,
    )
    const result = await client.callTool({ name: 'kolonie.autonomy.read', arguments: {} })
    await close()
    return result
  }

  const contract = (capabilities?: readonly ['web-server']): StoredAutonomyContract => ({
    level: 'accompanied',
    challengesAllowed: false,
    ...(capabilities === undefined ? {} : { capabilities: [...capabilities] }),
    defaultRule: 'ask',
    operatorRoute: 'Use the operator page.',
    recordedAt: '2026-08-10T08:00:00.000Z',
    reviewDueAt: '2027-08-10T08:00:00.000Z',
  })

  it('reports the named web-server grant as text and data', async () => {
    const result = await read(contract(['web-server']))
    const text = (result.content as Array<{ text: string }>)[0]?.text

    expect(text).toContain('Web server (`web-server`): granted')
    expect(text).toContain('on a port it names')
    expect(result.structuredContent).toMatchObject({ capabilities: ['web-server'] })
  })

  /**
   * A capability nobody granted used to read as *none granted*, which a citizen
   * cannot tell from *your operator said no* (`#779`). What the text now carries
   * is the decision `capabilityDecision` reached, and for a contract whose rule
   * is to ask that decision is a question rather than a stop.
   */
  it('reports a legacy contract with no capability field as one still to ask about', async () => {
    const result = await read(contract())
    const text = (result.content as Array<{ text: string }>)[0]?.text

    expect(text).toContain('Web server (`web-server`): not granted')
    expect(text).toContain('is to ask')
    expect(text).not.toContain('Do not do it for Colony work')
    expect(result.structuredContent).toMatchObject({ capabilities: [] })
  })

  it('sends a citizen to the channel rather than to a question when the rule is to refrain', async () => {
    const result = await read({ ...contract(), defaultRule: 'refrain' })
    const text = (result.content as Array<{ text: string }>)[0]?.text

    expect(text).toContain('Web server (`web-server`): not granted')
    expect(text).toContain('`kolonie.autonomy.blocked`')
  })
})

/**
 * What the label the citizen types actually does (`#1014`).
 *
 * The report behind the issue called this tool with a person's display name,
 * got a working link, and could not tell whether it had just made an orphan
 * page. It had not: the page's subject is the agent, so an unexpected label
 * mints a *second link* and never a wrong page. These tests pin the three
 * things that make that legible from the outside — the label comes back, the
 * listing names it, and two spellings of one label are one page.
 */
describe('the label a durable page is filed under', () => {
  const citizen = async () => {
    const colony = fakeColony()
    const registered = await colony.registry.register(
      { name: 'canary', platform: 'openclaw' },
      { ip: FAKE_CALLER_IP },
    )
    if (registered.outcome !== 'registered') throw new Error('fixture failed to register')

    return connectedClient(colony, `Bearer ${registered.response.credentials.apiKey}`)
  }

  const textOf = (result: unknown) =>
    ((result as { content?: Array<{ text: string }> }).content ?? [])[0]?.text ?? ''

  it('comes back with the link, so a later session knows what to name in a revoke', async () => {
    const { client, close } = await citizen()
    const result = await client.callTool({
      name: 'kolonie.operator.page',
      arguments: { operatorAddress: 'Ada Lovelace' },
    })
    await close()

    expect(result.structuredContent).toMatchObject({ operatorAddress: 'Ada Lovelace' })
    expect(textOf(result)).toContain('Ada Lovelace')
  })

  /**
   * Proposal (3) of the report — *"`kolonie.operator.pages` should show which
   * address each page was minted for (it may already — worth ensuring)"*. It
   * already did; this is the ensuring, and it asserts the citizen's own
   * capitals rather than a folded form.
   */
  it('is what the listing names each page by', async () => {
    const { client, close } = await citizen()
    await client.callTool({
      name: 'kolonie.operator.page',
      arguments: { operatorAddress: 'Ada Lovelace' },
    })
    const listed = await client.callTool({ name: 'kolonie.operator.pages', arguments: {} })
    await close()

    expect(textOf(listed)).toContain('Ada Lovelace')
  })

  it('is one label however it is capitalised, on the way in and on the way out', async () => {
    const { client, close } = await citizen()
    const first = await client.callTool({
      name: 'kolonie.operator.page',
      arguments: { operatorAddress: 'Ada Lovelace' },
    })
    const second = await client.callTool({
      name: 'kolonie.operator.page',
      arguments: { operatorAddress: '  ada LOVELACE ' },
    })
    const revoked = await client.callTool({
      name: 'kolonie.operator.page.revoke',
      arguments: { operatorAddress: 'ADA lovelace' },
    })
    const listed = await client.callTool({ name: 'kolonie.operator.pages', arguments: {} })
    await close()

    expect((second.structuredContent as { url: string }).url).toBe(
      (first.structuredContent as { url: string }).url,
    )
    expect(revoked.structuredContent).toMatchObject({ revoked: true })
    expect(textOf(listed)).toContain('You have not given anybody a page')
  })
})
