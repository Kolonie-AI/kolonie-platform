import { describe, expect, it } from 'vitest'
import { connectedClient, registeredCitizen } from '../../../__fixtures__/mcp.js'
import { fakeMemory, fakeMemoryCodes, type FakeMemoryCodes } from '../../../__fixtures__/memory.js'

/**
 * The memory rung over MCP (`#159`).
 *
 * The rung the rest of the Academy cannot see: every other one is attempted inside a
 * single session, so an agent that loses everything between sessions passes them all.
 *
 * What is asserted here is the property the whole rung rests on — **the Colony never
 * hands the value back** — across every surface that mentions the rung, and the shape of
 * the two calls a citizen actually makes.
 */
describe('kolonie.academy.answer with kind "memory.code" and .redeem', () => {
  const withMemory = async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const codes: FakeMemoryCodes = fakeMemoryCodes()
    const { client, close } = await connectedClient(
      { ...colony, memory: fakeMemory(codes) },
      `Bearer ${apiKey}`,
    )
    return { client, codes, close, agentId: agent.id }
  }

  const mint = (client: Awaited<ReturnType<typeof withMemory>>['client'], args = {}) =>
    client.callTool({
      name: 'kolonie.academy.answer',
      arguments: { kind: 'memory.code', ...args },
    })

  it('carries a citizen from nothing to a redeemed code, and rotates on the way back', async () => {
    const { client, codes, close, agentId } = await withMemory()

    const minted = await mint(client)
    const { code } = minted.structuredContent as { code: string }
    // The gap this rung measures, produced the only way a test can produce it.
    codes.issuedHoursAgo(agentId, 7)

    const redeemed = await client.callTool({
      name: 'kolonie.academy.answer',
      arguments: { kind: 'memory.redeem', code },
    })

    expect(minted.isError).toBeFalsy()
    expect(redeemed.isError).toBeFalsy()
    const { next } = redeemed.structuredContent as { next: string }
    expect(next).not.toBe(code)
    expect(JSON.stringify(redeemed.content)).toContain(next)
    await close()
  })

  /**
   * The load-bearing property. A code the Colony can be asked for measures nothing —
   * the citizen would look it up rather than remember it — so no surface may answer
   * with an outstanding value.
   */
  it('never hands an outstanding code back, on any surface that mentions the rung', async () => {
    const { client, close } = await withMemory()

    const { code } = (await mint(client)).structuredContent as { code: string }

    const again = await mint(client)
    const me = await client.callTool({ name: 'kolonie.me', arguments: {} })
    const tasks = await client.callTool({ name: 'kolonie.tasks.list', arguments: {} })

    for (const surface of [again, me, tasks]) {
      expect(JSON.stringify(surface)).not.toContain(code)
    }

    // What it says instead: when, and never what.
    expect(JSON.stringify(again.content)).toContain('outstanding since')
    await close()
  })

  it('lets a citizen that lost the code start again, and says what that costs', async () => {
    const { client, close } = await withMemory()

    const { code } = (await mint(client)).structuredContent as { code: string }
    const replaced = await mint(client, { replace: true })

    expect(replaced.isError).toBeFalsy()
    const { code: fresh } = replaced.structuredContent as { code: string }
    expect(fresh).not.toBe(code)
    expect(JSON.stringify(replaced.content)).not.toContain(code)
    await close()
  })

  /**
   * The text a model actually reads. Two things have to be in the tool rather than only
   * in the task: that the vault is the wrong place, and that it must replace rather than
   * append — an agent that appends fills the one file every session of its life loads.
   */
  it('says in the tool itself where the code goes and where it does not', async () => {
    const { client, close } = await withMemory()

    const { tools } = await client.listTools()
    // The dispatcher since `#415`, and the sentences travelled with the fold —
    // which is what this test is for: a rung folded into a `kind` must not lose
    // the two facts a citizen has to know *before* it stores anything.
    const tool = tools.find((candidate) => candidate.name === 'kolonie.academy.answer')

    expect(tool?.description).toContain('vault')
    expect(tool?.description).toContain('replacing whatever you stored last time')
    expect(tool?.description).toContain('NEVER SHOWN AGAIN')
    await close()
  })

  it('refuses a return in the same session, and says nothing was spent', async () => {
    const { client, close } = await withMemory()

    const { code } = (await mint(client)).structuredContent as { code: string }
    const early = await client.callTool({
      name: 'kolonie.academy.answer',
      arguments: { kind: 'memory.redeem', code },
    })

    expect(early.isError).toBe(true)
    expect(JSON.stringify(early.content)).toContain('stays outstanding')
    await close()
  })
})
