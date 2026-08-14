import { randomUUID } from 'node:crypto'
import { API_BASE_PATH } from '@kolonie-ai/core'
import { describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { FAKE_CALLER_IP, fakeColony } from '../__fixtures__/colony/index.js'
import { fakeConsole } from '../__fixtures__/console.js'
import { fakeStore } from '../__fixtures__/store.js'
import { connectedClient } from '../__fixtures__/mcp.js'
import { registeredTools } from './tool-names.js'

/**
 * The third operator channel, withdrawn (`#911`).
 *
 * `#736` gave an agent a way to hand its live tab to the person who operates it,
 * for the one thing neither words nor a secret can solve: a challenge that has to
 * be cleared *on the page*. `#894` measured what that was worth. The challenge
 * reads the browser as driven and never opens, so the operator arrived at a page
 * with nothing on it to clear — and the mechanism was not failing at the relay,
 * which worked, but at the thing it existed to reach.
 *
 * **A removal is only finished when the surface says so, and that is what is
 * asserted here rather than in the diff.** Three properties, and each one is a
 * different way a citizen could still meet a channel that is gone:
 *
 * - **The names are not offered.** Not in any tier and not to any set of skills —
 *   `browser-session` was the skill that unlocked the offer, and holding it now
 *   unlocks nothing, because D-013's way of switching a surface off is to not
 *   register it.
 * - **The names answer as unknown rather than as forbidden.** The difference is
 *   the whole of what a citizen does next: *you may not* is a thing to go and
 *   earn, and an agent told that about a withdrawn channel spends a rung's worth
 *   of effort on a door that no longer has a wall around it.
 * - **The relay is not dialable.** The agent-side socket was a documented wire
 *   (`#866`) and a sharer written against it is still out there; what it meets is
 *   a 404, which is what an address that no longer names anything says.
 *
 * **The names are not reused.** `kolonie.browser.share.*` now means a thing that
 * was tried and did not work, so a later mechanism gets its own vocabulary rather
 * than inheriting a write-up that reads as an instruction and is an obituary.
 */

const WITHDRAWN = [
  'kolonie.browser.share.open',
  'kolonie.browser.share.status',
  'kolonie.browser.share.close',
] as const

describe('the browser share, withdrawn', () => {
  it('is not registered in any tier', () => {
    const registered = [...registeredTools()]

    expect(registered.filter((name) => name.startsWith('kolonie.browser.'))).toEqual([])
  })

  /**
   * Through a real client rather than over the constant, because the constant is
   * what a tier is built from and `tools/list` is what an agent actually reads.
   * The citizen here holds the skill that used to open the channel, which is the
   * only set of skills that could tell this apart from a list nobody unlocked.
   */
  it('is named by no tool a citizen holding the skill is offered', async () => {
    const colony = fakeColony()
    const registered = await colony.registry.register(
      { name: `withdrawn-${randomUUID().slice(0, 8)}`, platform: 'openclaw' },
      { ip: FAKE_CALLER_IP },
    )
    if (registered.outcome !== 'registered') throw new Error('fixture failed to register')
    const { agent, credentials } = registered.response
    colony.shares.allow(agent.id)

    const { client, close } = await connectedClient(colony, `Bearer ${credentials.apiKey}`)
    const { tools } = await client.listTools()
    await close()

    expect(tools.filter((tool) => tool.name.startsWith('kolonie.browser.'))).toEqual([])

    /**
     * The two channels that survive, in the same breath. Nothing here took a
     * dependency off them, and the way to keep that true is to say it where a
     * change to the share would be read.
     */
    const names = tools.map((tool) => tool.name)
    for (const surviving of [
      'kolonie.operator.request.open',
      'kolonie.operator.request.reply',
      'kolonie.operator.drop.open',
      'kolonie.operator.drop.read',
    ]) {
      expect(names, surviving).toContain(surviving)
    }
  })

  it.each(WITHDRAWN)('answers %s as a name it does not know', async (name) => {
    const colony = fakeColony()
    const registered = await colony.registry.register(
      { name: `withdrawn-${randomUUID().slice(0, 8)}`, platform: 'openclaw' },
      { ip: FAKE_CALLER_IP },
    )
    if (registered.outcome !== 'registered') throw new Error('fixture failed to register')
    colony.shares.allow(registered.response.agent.id)

    const { client, close } = await connectedClient(
      colony,
      `Bearer ${registered.response.credentials.apiKey}`,
    )
    const refused = await client.callTool({ name, arguments: {} })
    await close()

    expect(refused.isError).toBe(true)
    const said = JSON.stringify(refused.content)

    // The protocol's own answer for a name that was never registered, naming it.
    expect(said).toContain('not found')
    expect(said).toContain(name)

    // Unknown, not forbidden: nothing here is a standing to go and earn, so
    // nothing in the answer may read as one.
    expect(said.toLowerCase()).not.toContain('skill')
    expect(said.toLowerCase()).not.toContain('forbidden')
  })
})

/**
 * The wire, unplugged.
 *
 * The agent's end dialled `${API_BASE_PATH}/browser/share/relay` with the share
 * token in `Authorization`; the route that answered it is gone with the tool that
 * minted the token. What an old sharer meets is the app's own 404 — no upgrade,
 * no socket, and nothing that reads a CDP frame.
 */
describe('the relay the sharer dialled', () => {
  it('answers 404', async () => {
    const app = buildApp({
      ...fakeColony(),
      store: fakeStore(),
      console: fakeConsole(),
    })
    await app.ready()

    const answered = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/browser/share/relay`,
      headers: { authorization: 'Bearer a-token-nothing-mints-any-more' },
    })
    await app.close()

    expect(answered.statusCode).toBe(404)
  })
})
