import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it } from 'vitest'
import { connectedClient, registeredCitizen } from '../__fixtures__/mcp.js'
import type { PublishedTool } from './catalogue-size.js'

/**
 * A nullable argument reaches a real client, in whichever spelling zod emits
 * (`#1923`).
 *
 * ## What moved, and why a test rather than a reading of the specification
 *
 * zod 4.5.4 publishes a bare nullable field as `"type": ["string","null"]` where
 * 4.4.3 published `anyOf: [{"type":"string"},{"type":"null"}]`. Both are valid
 * JSON Schema and both state the same constraint, so nothing in the draft
 * settles the question that actually matters: **does the new spelling survive to
 * a citizen's client, and does the boundary still refuse what it refused?** The
 * catalogue is published over MCP, and a form the SDK's own result schema
 * dropped would be invisible to every real client while every server-side
 * assertion stayed green.
 *
 * So this reads the value back through `Client.request` against
 * `ListToolsResultSchema` — the SDK's own parse, the one a citizen's client
 * runs — which is the standard `#1917` held itself to and the reason
 * `catalogue-handshake.test.ts` reads off the wire rather than off the module.
 *
 * ## Why it is not written against one spelling
 *
 * The Colony does not choose how zod spells a union, and pinning the array form
 * would make the next bump red for a change that costs a citizen nothing. What
 * is asserted is the property both spellings have to carry: the field is
 * published, `null` is one of the types it admits, and a value of the wrong type
 * is still refused at the door. A bump that dropped `null` from the published
 * shape — the failure worth catching — fails here in either spelling.
 */

/** Which types one published field admits, whichever way the union was spelled. */
const typesOf = (field: unknown): readonly string[] => {
  const schema = field as { type?: unknown; anyOf?: readonly { type?: unknown }[] }

  if (Array.isArray(schema.type)) return schema.type.filter((one) => typeof one === 'string')
  if (Array.isArray(schema.anyOf))
    return schema.anyOf.map((branch) => branch.type).filter((one) => typeof one === 'string')
  return typeof schema.type === 'string' ? [schema.type] : []
}

/** The catalogue as the SDK parses it, rather than as this process built it. */
const catalogueViaClientRequest = async (): Promise<readonly PublishedTool[]> => {
  const { colony, apiKey } = await registeredCitizen()
  const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

  try {
    // `Client.request` with the SDK's own result schema is the parse a citizen's
    // client performs. `listTools` goes through the same schema; this names it,
    // because the name is the evidence.
    const listed = await client.request({ method: 'tools/list', params: {} }, ListToolsResultSchema)
    return listed.tools as readonly PublishedTool[]
  } finally {
    await close()
  }
}

const propertiesOf = (tool: PublishedTool | undefined): Record<string, unknown> =>
  ((tool?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ??
    {}) as Record<string, unknown>

describe('a nullable argument, as a real client parses it', () => {
  it('survives ListToolsResultSchema still admitting null', async () => {
    const tools = await catalogueViaClientRequest()
    const answer = tools.find((tool) => tool.name === 'kolonie.academy.answer')

    // `address` is the field the 4.5.4 diff named first, and it is bare — no
    // `maxLength`, no `format` — which is the case whose spelling moved.
    const address = propertiesOf(answer)['address']

    expect(address, 'kolonie.academy.answer publishes no `address`').toBeDefined()
    expect(typesOf(address)).toContain('string')
    expect(typesOf(address)).toContain('null')
  })

  /**
   * **Every nullable field, not the one that was looked at.** 144 published
   * fields changed spelling in this bump; an assertion about one of them would
   * pass for a catalogue in which the other 143 had lost `null` altogether.
   */
  it('admits null on every field of the catalogue that is nullable at all', async () => {
    const tools = await catalogueViaClientRequest()

    const nullable = tools.flatMap((tool) =>
      Object.entries(propertiesOf(tool))
        .filter(([, field]) => typesOf(field).includes('null'))
        .map(([name]) => `${tool.name} » ${name}`),
    )

    // The floor is what makes this a measurement rather than a tautology: an
    // empty list would satisfy every assertion about the members of a list.
    expect(nullable.length).toBeGreaterThan(50)
  })

  /**
   * **The other half, and the one that would make a loosening look like a
   * spelling change.** A published union is a description; Zod at the boundary
   * is what enforces it, and this says the two still agree — `null` is accepted
   * because it is published, and a number is refused because it is not.
   */
  it('accepts null and refuses a type the union never named', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    try {
      const withNull = await client.callTool({
        name: 'kolonie.academy.answer',
        arguments: { kind: 'solana.address', address: null, signature: null },
      })
      const withNumber = await client.callTool({
        name: 'kolonie.academy.answer',
        arguments: { kind: 'solana.address', address: 42, signature: null },
      })

      // `null` reaches the tool: it is refused by the rung's own rule, in the
      // Colony's own words, rather than by the argument parser.
      expect(JSON.stringify(withNull.content)).not.toContain('Input validation error')
      // A number never reaches it, and the parser names the field.
      expect(withNumber.isError).toBe(true)
      expect(JSON.stringify(withNumber.content)).toContain('expected string, received number')
    } finally {
      await close()
    }
  })
})
