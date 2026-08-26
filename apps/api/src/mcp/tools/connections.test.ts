import { CONNECTION_PENDING_LIMIT, CONNECTION_REASON_MAX, type AgentId } from '@kolonie-ai/core'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { describe, expect, it } from 'vitest'
import { anonymousClient, connectedClient, registeredCitizen } from '../../__fixtures__/mcp.js'

/**
 * The tool half of `#1293` — who is offered these, what the acts answer, and
 * what a refusal says.
 *
 * What the database decides is tested against a real PostgreSQL in
 * `packages/db/src/storage/connections.test.ts` and not repeated here: that one
 * pending request per unordered pair is a unique index rather than a check in
 * TypeScript, that accepting is one transaction, and that an erasure takes both
 * sides with it. A fake asserting those would be asserting a copy of the schema.
 */
const connect = (args: Record<string, unknown>) => ({
  name: 'kolonie.citizens.connect',
  arguments: args,
})

const connections = () => ({ name: 'kolonie.citizens.connections', arguments: {} })

/** The house idiom for reading what a model would actually be shown. */
const textOf = (result: Awaited<ReturnType<Client['callTool']>>) => JSON.stringify(result.content)

const REASON = 'We both walked mail.tm last week and reached opposite conclusions.'

/**
 * The other citizen, as the identifier its own acts arrive under.
 *
 * The fixture keys rows by identifier and a citizen written without one is its
 * own handle, so this is `'walker'` either way. It is spelled once, branded,
 * because `act` takes the caller's identifier and a handle in that order — and
 * the two being the same string here is what would otherwise let a plain
 * `'walker'` pass unnoticed in the wrong position.
 */
const WALKER = 'walker' as AgentId

/**
 * A citizen asking, and a colony of citizens to be asked.
 *
 * The asker is a real registration rather than a made-up key: both tools
 * authenticate before they do anything, and one of them writes against the
 * caller's own identifier.
 */
const aColonyWith = async (citizens: readonly { handle: string; discoverable: boolean }[]) => {
  const { colony, agent, apiKey } = await registeredCitizen()
  for (const citizen of citizens) colony.connections.citizen(citizen.handle, citizen.discoverable)
  // The caller's own handle, with the identifier behind it, so that *a citizen
  // does not connect to itself* is assertable at this layer.
  colony.connections.citizen(agent.profile.name, true, agent.id)

  return { colony, agent, ...(await connectedClient(colony, `Bearer ${apiKey}`)) }
}

describe('kolonie.citizens.connect and kolonie.citizens.connections (#1293)', () => {
  it('is offered to neither an anonymous caller', async () => {
    const { client, close } = await anonymousClient()

    const listing = await client.listTools()

    const names = listing.tools.map((tool) => tool.name)
    expect(names).not.toContain('kolonie.citizens.connect')
    expect(names).not.toContain('kolonie.citizens.connections')
    await close()
  })

  it('is offered to a citizen presenting its key', async () => {
    const { client, close } = await aColonyWith([])

    const names = (await client.listTools()).tools.map((tool) => tool.name)

    expect(names).toContain('kolonie.citizens.connect')
    expect(names).toContain('kolonie.citizens.connections')
    await close()
  })

  /**
   * The absence `#1292` freezes: no count on a public profile, and therefore no
   * tool that could produce one for anybody but the caller.
   */
  it('offers no tool that reads another citizen’s connections', async () => {
    const { client, close } = await aColonyWith([])

    const names = (await client.listTools()).tools.map((tool) => tool.name)

    expect(names).not.toContain('kolonie.citizens.connections.of')
    expect(names).not.toContain('kolonie.citizens.connected')
    await close()
  })

  it('asks with a reason, and gives the handle back as it is held', async () => {
    const { client, close } = await aColonyWith([{ handle: 'Cartographer', discoverable: true }])

    const result = await client.callTool(connect({ handle: 'cartographer', reason: REASON }))

    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toEqual({ handle: 'Cartographer', state: 'pending' })
    await close()
  })

  /** The rejection case the definition of done asks for. */
  it('refuses a request with no reason, and one that is only spaces', async () => {
    const { client, close } = await aColonyWith([{ handle: 'cartographer', discoverable: true }])

    for (const args of [{ handle: 'cartographer' }, { handle: 'cartographer', reason: '   ' }]) {
      const result = await client.callTool(connect(args))

      expect(result.isError, JSON.stringify(args)).toBe(true)
      expect(result.structuredContent).toMatchObject({
        error: { code: 'validation_failed' },
      })
      expect(textOf(result)).toContain('cannot be blank')
    }
    await close()
  })

  it('refuses a reason over the cap before it reaches the Colony', async () => {
    const { client, close } = await aColonyWith([{ handle: 'cartographer', discoverable: true }])

    const result = await client.callTool(
      connect({ handle: 'cartographer', reason: 'x'.repeat(CONNECTION_REASON_MAX + 1) }),
    )

    expect(result.isError).toBe(true)
    await close()
  })

  it('refuses a citizen connecting to itself', async () => {
    const { client, agent, close } = await aColonyWith([])

    const result = await client.callTool(connect({ handle: agent.profile.name, reason: REASON }))

    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({ error: { code: 'validation_failed' } })
    expect(textOf(result)).toContain('nobody to agree')
    await close()
  })

  it('refuses a handle nobody holds', async () => {
    const { client, close } = await aColonyWith([])

    const result = await client.callTool(connect({ handle: 'nobody', reason: REASON }))

    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({ error: { code: 'not_found' } })
    await close()
  })

  it('refuses a request to a citizen that has not switched discovery on', async () => {
    const { client, close } = await aColonyWith([{ handle: 'quiet', discoverable: false }])

    const result = await client.callTool(connect({ handle: 'quiet', reason: REASON }))

    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({ error: { code: 'forbidden' } })
    await close()
  })

  it('lists what is waiting either way, with the reason', async () => {
    const { client, colony, agent, close } = await aColonyWith([
      { handle: 'cartographer', discoverable: true },
    ])
    await client.callTool(connect({ handle: 'cartographer', reason: REASON }))
    // And one coming the other way, written straight onto the fixture.
    colony.connections.citizen('walker', true)
    await colony.connections.act(WALKER, agent.profile.name, 'request', 'I read your Atlas entry.')

    const result = await client.callTool(connections())

    expect(result.structuredContent).toMatchObject({
      pendingIn: [{ handle: 'walker' }],
      pendingOut: [{ handle: 'cartographer', reason: REASON }],
      accepted: [],
    })
    expect(textOf(result)).toContain('I read your Atlas entry.')
    await close()
  })

  it('says nothing is open when nothing is', async () => {
    const { client, close } = await aColonyWith([])

    const result = await client.callTool(connections())

    expect(result.structuredContent).toEqual({ pendingIn: [], pendingOut: [], accepted: [] })
    expect(textOf(result)).toContain('Nothing open')
    await close()
  })

  it('accepts a request, and both sides then hold the connection', async () => {
    const { client, colony, agent, close } = await aColonyWith([])
    colony.connections.citizen('walker', true)
    await colony.connections.act(WALKER, agent.profile.name, 'request', 'I read your Atlas entry.')

    const accepted = await client.callTool(connect({ handle: 'walker', act: 'accept' }))

    expect(accepted.isError).toBeFalsy()
    expect(accepted.structuredContent).toEqual({ handle: 'walker', state: 'connected' })
    expect(colony.connections.connected(agent.id, 'walker')).toBe(true)

    const held = await client.callTool(connections())
    expect(held.structuredContent).toMatchObject({
      pendingIn: [],
      accepted: [{ handle: 'walker' }],
    })
    await close()
  })

  it('declines a request, and leaves nothing behind', async () => {
    const { client, colony, agent, close } = await aColonyWith([])
    colony.connections.citizen('walker', true)
    await colony.connections.act(WALKER, agent.profile.name, 'request', 'I read your Atlas entry.')

    const declined = await client.callTool(connect({ handle: 'walker', act: 'decline' }))

    expect(declined.structuredContent).toEqual({ handle: 'walker', state: 'none' })
    expect(colony.connections.connected(agent.id, 'walker')).toBe(false)
    expect((await client.callTool(connections())).structuredContent).toEqual({
      pendingIn: [],
      pendingOut: [],
      accepted: [],
    })
    await close()
  })

  it('cancels a request the caller made', async () => {
    const { client, close } = await aColonyWith([{ handle: 'cartographer', discoverable: true }])
    await client.callTool(connect({ handle: 'cartographer', reason: REASON }))

    const cancelled = await client.callTool(connect({ handle: 'cartographer', act: 'cancel' }))

    expect(cancelled.structuredContent).toEqual({ handle: 'cartographer', state: 'none' })
    expect((await client.callTool(connections())).structuredContent).toMatchObject({
      pendingOut: [],
    })
    await close()
  })

  it('refuses an act where there is no request in that direction', async () => {
    const { client, close } = await aColonyWith([{ handle: 'cartographer', discoverable: true }])
    await client.callTool(connect({ handle: 'cartographer', reason: REASON }))

    // The caller asked, so there is nothing here for it to accept or decline.
    for (const act of ['accept', 'decline']) {
      const result = await client.callTool(connect({ handle: 'cartographer', act }))

      expect(result.isError, act).toBe(true)
      expect(result.structuredContent).toMatchObject({ error: { code: 'not_found' } })
    }
    await close()
  })

  it('removes a connection, and removing again succeeds', async () => {
    const { client, colony, agent, close } = await aColonyWith([])
    colony.connections.citizen('walker', true)
    await colony.connections.act(WALKER, agent.profile.name, 'request', 'I read your Atlas entry.')
    await client.callTool(connect({ handle: 'walker', act: 'accept' }))

    const first = await client.callTool(connect({ handle: 'walker', act: 'remove' }))
    const again = await client.callTool(connect({ handle: 'walker', act: 'remove' }))

    expect(first.structuredContent).toEqual({ handle: 'walker', state: 'none' })
    expect(again.isError).toBeFalsy()
    expect(again.structuredContent).toEqual({ handle: 'walker', state: 'none' })
    expect(colony.connections.connected(agent.id, 'walker')).toBe(false)
    await close()
  })

  it('refuses the reverse request while one is already pending', async () => {
    const { client, colony, agent, close } = await aColonyWith([])
    colony.connections.citizen('walker', true)
    await colony.connections.act(WALKER, agent.profile.name, 'request', 'I read your Atlas entry.')

    const result = await client.callTool(connect({ handle: 'walker', reason: REASON }))

    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({ error: { code: 'conflict' } })
    expect(textOf(result)).toContain('Accept the one')
    await close()
  })

  it('refuses a request once the caller has as many open as it may', async () => {
    const { client, colony, close } = await aColonyWith([])
    for (let index = 0; index < CONNECTION_PENDING_LIMIT; index += 1) {
      colony.connections.citizen(`asked-${index}`, true)
      await client.callTool(connect({ handle: `asked-${index}`, reason: REASON }))
    }
    colony.connections.citizen('one-too-many', true)

    const result = await client.callTool(connect({ handle: 'one-too-many', reason: REASON }))

    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({ error: { code: 'conflict' } })
    expect(textOf(result)).toContain('Cancel one')
    await close()
  })
})

describe('connections teaching behind _meta (#1692)', () => {
  /**
   * `connect` keeps that it is mutual, that a reason is required and the
   * contrast with following; `connections` keeps that the answer is its own.
   * Everything else is reachable at the `_meta` URL.
   */
  it('leaves only the choice-time sentences on the two tools', async () => {
    const { client, close } = await aColonyWith([])
    const { tools } = await client.listTools()
    await close()

    const tool = (name: string) => tools.find((candidate) => candidate.name === name)
    const connecting = tool('kolonie.citizens.connect')
    const listing = tool('kolonie.citizens.connections')

    expect(connecting?.description).toMatch(/both sides agreeing/i)
    expect(connecting?.description).toMatch(/a request needs a reason/i)
    expect(connecting?.description).toMatch(/this is not following/i)
    expect(connecting?.description).not.toContain('`cancel` withdraws one you made')
    expect(connecting?._meta).toBeDefined()

    expect(listing?.description).toMatch(/yours alone/i)
    expect(listing?.description).not.toContain('Answer a request with')
    expect(listing?._meta).toBeDefined()
  })
})
