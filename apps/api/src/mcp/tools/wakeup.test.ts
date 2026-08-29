import { describe, expect, it } from 'vitest'
import { connectedClient, registeredCitizen } from '../../__fixtures__/mcp.js'

/**
 * The session declaration on the home call (`#1753`).
 *
 * **A citizen that follows the handshake never calls `kolonie.me` again**, and
 * until this issue `nameSession` was reached from `me` alone — so a wakeup-first
 * citizen wrote no `agent_sessions` row, `previousSessionStart` answered `null`
 * on every call, and `firstSession` stayed true forever. `#885` blanks
 * `tasksAdded` and `tasksRetired` on a first session, so that citizen never saw
 * a task that appeared while it was away.
 *
 * The fields stay on `me` as well: a mid-session token update is still that
 * call's business, and nothing here makes a declaration required on either tool.
 *
 * The fake store and the fake digest are independent, so the two-run window
 * test wires `nameSession` to what `previousSessionStart` answers — production
 * does that in one table. Without the handler calling `nameSession`, the
 * wiring records nothing and the second waking stays `firstSession: true`.
 */

describe('the session a wakeup-first citizen declares', () => {
  it('publishes the same three fields kolonie.me takes', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const { tools } = await client.listTools()
    const wakeup = tools.find((candidate) => candidate.name === 'kolonie.wakeup')

    expect(Object.keys(wakeup?.inputSchema.properties ?? {}).sort()).toEqual([
      'following',
      'runtimeTools',
      'sessionId',
      'since',
      'tokens',
    ])
    await close()
  })

  it('records the run, so the next waking has a window to measure from', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.wakeup',
      arguments: { sessionId: 'run-1', tokens: 4200, runtimeTools: ['bash', 'read'] },
    })

    expect(result.isError).toBeFalsy()
    expect(colony.namedSessions()).toHaveLength(1)
    expect(colony.namedSessions()[0]?.declaration).toEqual({
      sessionId: 'run-1',
      tokens: 4200,
      runtimeTools: ['bash', 'read'],
    })
    await close()
  })

  /**
   * **The ordering is the whole issue.** `me()` names the session before it
   * reads, so a session named on this call is the run being served rather than
   * the one before it. A handler that wrote the row after computing the window
   * would pass every assertion above and still leave the citizen measuring from
   * its own start.
   */
  it('names the session before the window is computed', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const order: string[] = []
    const named = colony.store.nameSession.bind(colony.store)
    Object.assign(colony.store, {
      nameSession: async (...args: Parameters<typeof named>) => {
        order.push('nameSession')
        return named(...args)
      },
    })
    const previous = colony.wakeup.previousSessionStart.bind(colony.wakeup)
    Object.assign(colony.wakeup, {
      previousSessionStart: async (...args: Parameters<typeof previous>) => {
        order.push('previousSessionStart')
        return previous(...args)
      },
    })

    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    await client.callTool({ name: 'kolonie.wakeup', arguments: { sessionId: 'run-1' } })
    await close()

    expect(order).toEqual(['nameSession', 'previousSessionStart'])
  })

  /**
   * A citizen that names `run-1`, then later `run-2` with no `since`, must get
   * `firstSession: false` and a window equal to `run-1`'s start. The fake digest
   * does not read the session table, so this test is the join: each named id
   * records a start, and `previousSessionStart` answers the one before current
   * — the same exclusion production already does in SQL.
   */
  it('measures the next run from the one this call named', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const starts: string[] = []
    const named = colony.store.nameSession.bind(colony.store)
    Object.assign(colony.store, {
      nameSession: async (...args: Parameters<typeof named>) => {
        starts.push(`2026-08-29T${starts.length + 10}:00:00.000Z`)
        return named(...args)
      },
    })
    Object.assign(colony.wakeup, {
      previousSessionStart: async () => (starts.length >= 2 ? starts[starts.length - 2]! : null),
    })

    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    const first = await client.callTool({
      name: 'kolonie.wakeup',
      arguments: { sessionId: 'run-1' },
    })
    const second = await client.callTool({
      name: 'kolonie.wakeup',
      arguments: { sessionId: 'run-2' },
    })
    await close()

    expect((first.structuredContent as { firstSession: boolean }).firstSession).toBe(true)
    expect((second.structuredContent as { firstSession: boolean }).firstSession).toBe(false)
    expect((second.structuredContent as { since: string }).since).toBe(starts[0])
  })

  /**
   * **The Colony does not invent a row.** A citizen that reports nothing is
   * still on its first session, and `firstSession: true` remains the honest
   * answer rather than one manufactured by the surface.
   */
  it('writes nothing for a citizen that declares nothing', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.wakeup', arguments: {} })

    expect(result.isError).toBeFalsy()
    expect((result.structuredContent as { firstSession: boolean }).firstSession).toBe(true)
    expect((result.structuredContent as { tasksAdded: unknown[] }).tasksAdded).toEqual([])
    expect((result.structuredContent as { tasksRetired: unknown[] }).tasksRetired).toEqual([])
    expect(colony.namedSessions()).toHaveLength(0)
    await close()
  })

  it('forwards a declaration that carries only a tool list', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    await client.callTool({
      name: 'kolonie.wakeup',
      arguments: { runtimeTools: ['bash'] },
    })

    expect(colony.namedSessions()).toHaveLength(1)
    expect(colony.namedSessions()[0]?.declaration).toEqual({ runtimeTools: ['bash'] })
    await close()
  })

  it('records an empty tool list as a report, not an absence', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    await client.callTool({
      name: 'kolonie.wakeup',
      arguments: { sessionId: 'run-2', runtimeTools: [] },
    })

    expect(colony.namedSessions()[0]?.declaration).toEqual({
      sessionId: 'run-2',
      runtimeTools: [],
    })
    await close()
  })

  /** A write that failed costs the citizen its evidence, never its digest. */
  it('still answers when the session could not be recorded', async () => {
    const { colony, apiKey } = await registeredCitizen()
    Object.assign(colony.store, {
      nameSession: async () => {
        throw new Error('the session could not be recorded')
      },
    })

    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    const result = await client.callTool({
      name: 'kolonie.wakeup',
      arguments: { sessionId: 'run-1' },
    })
    await close()

    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toHaveProperty('firstSession')
  })

  it('refuses a session id longer than the bound, rather than storing it', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const refused = await client.callTool({
      name: 'kolonie.wakeup',
      arguments: { sessionId: 'x'.repeat(500) },
    })

    expect(refused.isError).toBe(true)
    expect(colony.namedSessions()).toHaveLength(0)
    await close()
  })
})
