import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { connectedClient, registeredCitizen } from '../__fixtures__/mcp.js'
import { createMcpServer } from '../mcp.js'
import { withoutSchemaNoise } from './published-schema.js'

/**
 * What the client is handed, and what the boundary still refuses (`#382`).
 *
 * The two halves have to be asserted together or the change reads as a
 * loosening. They are not: the published schema is a description, and Zod is
 * what parses an argument on the way in.
 */

const schemasIn = (tools: readonly { inputSchema?: unknown }[]): unknown[] =>
  tools.map((tool) => tool.inputSchema).filter((schema) => schema !== undefined)

const countKeys = (value: unknown, key: string): number => {
  if (Array.isArray(value))
    return value.reduce<number>((sum, item) => sum + countKeys(item, key), 0)
  if (value === null || typeof value !== 'object') return 0
  return Object.entries(value as Record<string, unknown>).reduce(
    (sum, [name, nested]) => sum + (name === key ? 1 : 0) + countKeys(nested, key),
    0,
  )
}

describe('the schemas the Colony publishes', () => {
  it('declares no JSON Schema dialect, on any tool of any tier', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`, undefined, true)

    const tools = (await client.listTools()).tools
    expect(tools.length).toBeGreaterThan(0)
    expect(countKeys(schemasIn(tools), '$schema')).toBe(0)

    await close()
  })

  it('spells a uuid and a timestamp as a format, never also as a regex', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`, undefined, true)

    const schemas = schemasIn((await client.listTools()).tools)

    // The formats are still published — this removes the duplicate, not the bound.
    expect(JSON.stringify(schemas)).toContain('"format":"uuid"')

    const patterns: string[] = []
    const collect = (value: unknown): void => {
      if (Array.isArray(value)) return value.forEach(collect)
      if (value === null || typeof value !== 'object') return
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        if (key === 'pattern' && typeof nested === 'string') patterns.push(nested)
        collect(nested)
      }
    }
    collect(schemas)

    // No hand-expanded leap years and no UUID character classes survive.
    expect(patterns.some((pattern) => pattern.includes('02-29'))).toBe(false)
    expect(patterns.some((pattern) => pattern.includes('[0-9a-fA-F]{12}'))).toBe(false)

    await close()
  })

  /**
   * **The pattern that is the only statement of its rule stays.** Removing a
   * bound would be the opposite of this change, and it is the mistake a
   * strip-every-pattern implementation makes on its first day.
   */
  it('keeps a pattern that no format restates', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`, undefined, true)

    const published = JSON.stringify(schemasIn((await client.listTools()).tools))
    expect(published).toContain('[a-z0-9]+(?:-[a-z0-9]+)*')

    await close()
  })

  /**
   * **Nothing about validation moved**, and this is the assertion that says so.
   * A malformed id is refused by the same code with the same message, from a
   * schema that no longer publishes the regex.
   */
  it('still refuses an argument the published schema no longer spells out', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const refused = await client.callTool({
      name: 'kolonie.accounts.set',
      arguments: { accountId: 'not-a-uuid', note: null },
    })

    expect(refused.isError).toBe(true)
    expect(JSON.stringify(refused.content)).toContain('Invalid UUID')

    await close()
  })

  /**
   * The full boundary reported in `#1931`: the raw list response carries both
   * the current source schema and the cache rule a deferred client persists.
   * Asserting either half alone would have stayed green on the `#1928` deploy.
   *
   * The list result is captured before the SDK parses it. The pinned SDK predates
   * these 2026-07-28 fields; a test reading only `client.listTools()` could pass
   * because an SDK default supplied the same values rather than the server.
   */
  it('publishes the current accounts.list schema with an immediately stale private cache', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const server = createMcpServer(colony, `Bearer ${apiKey}`)
    const client = new Client({ name: 'test', version: '0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const results: Record<string, unknown>[] = []
    const receive = clientTransport.onmessage
    clientTransport.onmessage = (message, extra) => {
      const result = 'result' in message ? message.result : undefined
      if (
        result !== undefined &&
        typeof result === 'object' &&
        Array.isArray((result as Record<string, unknown>)['tools'])
      ) {
        results.push(result as Record<string, unknown>)
      }
      receive?.(message, extra)
    }

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    await client.listTools()
    await Promise.all([client.close(), server.close()])

    const result = results[0]
    const tools = result?.['tools'] as
      | readonly { name?: string; inputSchema?: { properties?: Record<string, unknown> } }[]
      | undefined
    const properties = tools?.find((tool) => tool.name === 'kolonie.accounts.list')?.inputSchema
      ?.properties

    expect(result?.['ttlMs']).toBe(0)
    expect(result?.['cacheScope']).toBe('private')
    expect(Object.keys(properties ?? {})).toEqual(['kind', 'includeRetired', 'limit', 'cursor'])
    expect(properties?.['limit']).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 16,
      default: 8,
    })
    expect(properties?.['cursor']).toMatchObject({ type: 'string', minLength: 1 })
  })

  /**
   * **A conditionally required argument is never published as required**
   * (`#1064`).
   *
   * `direction` is required on a directional kind and refused on every other
   * one, and which of those a call is cannot be read off the shape — it depends
   * on a sibling argument. So the only honest publication is optional, and the
   * refusal at the door is what states the rule. A citizen reported the opposite
   * and was right about the outcome: they sent `both` on a `website` walk and
   * were refused three times. That was the description, which is fixed in the
   * same change; this is the assertion that keeps the shape from ever agreeing
   * with the report.
   */
  it('publishes a conditionally required argument as optional', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`, undefined, true)

    const tools = (await client.listTools()).tools
    for (const name of ['kolonie.accounts.walk-report', 'kolonie.accounts.provider-report']) {
      const schema = tools.find((tool) => tool.name === name)?.inputSchema as
        { properties?: Record<string, unknown>; required?: readonly string[] } | undefined

      // Published, or the tool would not be the one this is about.
      expect(schema?.properties).toHaveProperty('direction')
      expect(schema?.required ?? []).not.toContain('direction')
    }

    await close()
  })

  /**
   * The other half, and it has to be here rather than only in the accounts
   * tests: the pair is the claim. A schema that stopped requiring the field
   * *and* a door that stopped refusing it would pass the assertion above and be
   * the loosening `#1023` wrote the refusal to prevent.
   */
  it('still refuses a direction on a kind whose verdicts have none', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const refused = await client.callTool({
      name: 'kolonie.accounts.walk-report',
      arguments: {
        kind: 'website',
        provider: 'localhost.run',
        outcome: 'abandoned',
        direction: 'both',
      },
    })

    expect(refused.isError).toBe(true)
    expect(JSON.stringify(refused.content)).toContain('Leave it out')

    await close()
  })
})

describe('withoutSchemaNoise', () => {
  it('leaves the schema it was given untouched', () => {
    const original = { $schema: 'x', type: 'string', format: 'uuid', pattern: '^.+$' }
    const pruned = withoutSchemaNoise(original)

    expect(pruned).toEqual({ type: 'string', format: 'uuid' })
    expect(original).toEqual({ $schema: 'x', type: 'string', format: 'uuid', pattern: '^.+$' })
  })

  it('drops a pattern only where a format already says it', () => {
    expect(withoutSchemaNoise({ type: 'string', format: 'email', pattern: '^a$' })).toEqual({
      type: 'string',
      format: 'email',
      pattern: '^a$',
    })
    expect(withoutSchemaNoise({ type: 'string', pattern: '^a$' })).toEqual({
      type: 'string',
      pattern: '^a$',
    })
    expect(withoutSchemaNoise({ type: 'string', format: 'date-time', pattern: '^a$' })).toEqual({
      type: 'string',
      format: 'date-time',
    })
  })

  it('reaches a schema nested in an anyOf', () => {
    expect(
      withoutSchemaNoise({
        anyOf: [{ type: 'string', format: 'uuid', pattern: '^a$' }, { type: 'null' }],
        $schema: 'x',
      }),
    ).toEqual({ anyOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }] })
  })
})
