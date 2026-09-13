import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it } from 'vitest'
import { anonymousClient, connectedClient, registeredCitizen } from '../__fixtures__/mcp.js'
import type { PublishedTool } from './catalogue-size.js'

/**
 * No published tool puts a JSON Schema combinator at the root (`#1964`).
 *
 * ## Why this is a wire-compatibility rule and not a style one
 *
 * Anthropic's tool-use API refuses a tool whose `input_schema` carries `oneOf`,
 * `allOf` or `anyOf` at the top level:
 *
 * ```
 * 400: tools.9.custom.input_schema: input_schema does not support oneOf, allOf,
 *      or anyOf at the top level
 * ```
 *
 * The refusal happens *before* inference and names the whole request, so one
 * offending schema makes the entire Kolonie catalogue unusable on that API
 * whatever the message said — and no fallback routing helps, because no model was
 * reached. Measured 2026-09-13: eight consecutive failures from a client carrying
 * the catalogue, from two tools out of a hundred and thirty.
 *
 * The same combinator *nested inside* a `properties` entry is accepted, so the
 * rule is about the root position only. That is what this asserts, and it is why
 * `kolonie.accounts.give`'s `anyOf` under a field is left alone.
 *
 * ## Why it reads the real list, on every tier
 *
 * A unit test on the two tools that were wrong on the day is a test of the past.
 * D-013 builds the tiers by registering *different sets of tools*, so a tool that
 * only a steward is served is invisible to a citizen's list — and the failing
 * request carried the catalogue, not one tier of it. So this walks the actual
 * `tools/list` response for stranger, citizen and steward, and fails naming the
 * tool and the keyword, which is the sentence somebody debugging a 400 needs.
 *
 * It reads through `Client.request` against `ListToolsResultSchema` — the SDK's
 * own parse, the one a citizen's client runs — for the reason
 * `nullable-spelling.test.ts` records: the thing under test is what survives to a
 * real client, not what this process built.
 */

/** The three keywords Anthropic refuses at the top level of an input schema. */
const REFUSED_AT_THE_ROOT = ['oneOf', 'allOf', 'anyOf'] as const

/** Every root-level combinator in one published catalogue, as `tool.keyword`. */
const rootCombinatorsIn = (tools: readonly PublishedTool[]): readonly string[] =>
  tools.flatMap((tool) => {
    const schema = tool.inputSchema as Record<string, unknown> | undefined
    if (schema === undefined || schema === null) return []
    return REFUSED_AT_THE_ROOT.filter((keyword) => keyword in schema).map(
      (keyword) => `${tool.name}.${keyword}`,
    )
  })

/** The catalogue as the SDK parses it, rather than as this process built it. */
const catalogueOf = async (
  open: () => Promise<{
    client: { request: (...args: never[]) => unknown }
    close: () => Promise<unknown>
  }>,
): Promise<readonly PublishedTool[]> => {
  const { client, close } = (await open()) as unknown as Awaited<ReturnType<typeof connectedClient>>

  try {
    const listed = await client.request({ method: 'tools/list', params: {} }, ListToolsResultSchema)
    return listed.tools as readonly PublishedTool[]
  } finally {
    await close()
  }
}

describe('the root of every published input schema (#1964)', () => {
  it('carries no oneOf, allOf or anyOf on the citizen tier', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const tools = await catalogueOf(() => connectedClient(colony, `Bearer ${apiKey}`))

    expect(tools.length).toBeGreaterThan(0)
    expect(rootCombinatorsIn(tools)).toEqual([])
  })

  it('carries none on the steward tier either, which registers more tools', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const tools = await catalogueOf(() =>
      connectedClient(colony, `Bearer ${apiKey}`, undefined, true),
    )

    expect(tools.length).toBeGreaterThan(0)
    expect(rootCombinatorsIn(tools)).toEqual([])
  })

  it('carries none on the tier a stranger is served', async () => {
    const tools = await catalogueOf(() => anonymousClient())

    expect(tools.length).toBeGreaterThan(0)
    expect(rootCombinatorsIn(tools)).toEqual([])
  })

  /**
   * The published root is an object, which is the other half of the same rule:
   * a combinator at the root is precisely what replaces `"type": "object"` there.
   */
  it('declares type object at the root of every tool a citizen is served', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const tools = await catalogueOf(() => connectedClient(colony, `Bearer ${apiKey}`))

    const notAnObject = tools
      .filter((tool) => (tool.inputSchema as { type?: unknown } | undefined)?.type !== 'object')
      .map((tool) => tool.name)

    expect(notAnObject).toEqual([])
  })
})
