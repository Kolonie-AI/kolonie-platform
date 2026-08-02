import { ACADEMY_TASKS } from '@kolonie-ai/db'
import { describe, expect, it } from 'vitest'
import { anonymousClient } from '../__fixtures__/mcp.js'
import { AUTHENTICATED_TOOLS, UNAUTHENTICATED_TOOLS } from '../mcp.js'

/**
 * **A task text may only name a tool that exists** (`#196`).
 *
 * `browser-perception` and `heartbeat` both told a citizen to call
 * `kolonie.tasks.struggle.report`, which has never been on the surface. The name
 * fires exactly when an agent is already stuck, so the agent it misdirects is
 * the one with the least patience left — and a client-side validation error
 * reads as a broken connection rather than a wrong name, which makes silence
 * the natural next move. The Colony then never hears about the task at all.
 *
 * This is the parity assertion the two halves needed and did not have: the
 * seed lives in `@kolonie-ai/db` and the surface in this file, so nothing
 * compared them. A renamed tool now fails here rather than in a support ticket.
 */
describe('the tools the Academy tells a citizen to call', () => {
  it('names no tool the MCP surface does not register', () => {
    const registered = new Set<string>([...UNAUTHENTICATED_TOOLS, ...AUTHENTICATED_TOOLS])
    const named = new Map<string, string[]>()

    for (const task of ACADEMY_TASKS) {
      const text = `${task.description}\n${task.instructions}`
      // Trailing punctuation is not part of a name: the texts write
      // "`kolonie.about`." and "call kolonie.tasks.list to see what is open."
      for (const match of text.matchAll(/kolonie(?:\.[a-z]+)+/g)) {
        const tool = match[0].replace(/\.$/, '')
        named.set(tool, [...(named.get(tool) ?? []), task.type])
      }
    }

    const unknown = [...named.entries()]
      .filter(([tool]) => !registered.has(tool))
      .map(([tool, tasks]) => `${tool} (named by ${[...new Set(tasks)].join(', ')})`)

    expect(unknown).toEqual([])
  })
})

describe('the unauthenticated tier', () => {
  it('offers exactly the tools a stranger is meant to see', async () => {
    const { client, close } = await anonymousClient()

    const { tools } = await client.listTools()

    // Equality, not containment. A tool added without a decision about which
    // tier it belongs to fails here, which is the point: the front door of the
    // Colony must widen deliberately or not at all.
    expect(tools.map((tool) => tool.name).sort()).toEqual([...UNAUTHENTICATED_TOOLS].sort())
    await close()
  })

  it('does not leak the authenticated surface to a caller with no key', async () => {
    const { client, close } = await anonymousClient()

    const listing = JSON.stringify(await client.listTools())

    // Not merely absent from the names — absent from the listing altogether, so
    // no description can name a tool the caller cannot reach.
    for (const tool of AUTHENTICATED_TOOLS) expect(listing).not.toContain(tool)
    await close()
  })

  /**
   * **The guard is the security boundary, and this is what pins it** (`#138`).
   *
   * `if (!authenticated) return server` is one line, and everything registered
   * above it is reachable by anyone on the internet. Asserting the exact set —
   * rather than that some particular tool is present — is what makes a fourth
   * tool drifting across that line fail the build instead of quietly widening
   * the front door.
   *
   * Three, and each earns its place: `about` is what a stranger reads before it
   * trusts anything, `name.check` supports a decision that happens before a
   * credential exists, and `register` is what issues one.
   */
  it('offers a stranger exactly three tools, and no more', async () => {
    const { client, close } = await anonymousClient()

    const { tools } = await client.listTools()

    expect(tools.map((tool) => tool.name).sort()).toEqual(
      ['kolonie.about', 'kolonie.name.check', 'kolonie.register'].sort(),
    )
    expect(tools).toHaveLength(3)
    await close()
  })

  it('fails an authenticated tool called without a key', async () => {
    const { client, close } = await anonymousClient()

    // The tool is not registered at all, so the protocol itself refuses it —
    // a caller that guesses the name gets nothing but the refusal.
    const result = await client.callTool({ name: 'kolonie.me', arguments: {} })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('not found')
    await close()
  })
})

/** A narrative with one field answered — see the db fixtures for why `broke`. */
