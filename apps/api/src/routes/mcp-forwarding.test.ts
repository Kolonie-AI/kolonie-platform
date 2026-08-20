import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Everything the MCP door is holding, it hands on.
 *
 * This exists because of `#614`. `McpDependencies` makes almost every field
 * optional so that a Colony missing a capability starts anyway and tells a
 * citizen so — which means a field the route literal simply forgets compiles,
 * type-checks and passes the whole suite, and is then indistinguishable at
 * runtime from a deployment that was never configured for it. `drops`,
 * `handovers` and `dropBaseUrl` were forgotten for as long as they existed —
 * all three are retired now (`#1443`, `#1444`) and `operatorShares` is the field
 * this guards in their place. The failure was the same either way: the
 * sealing key was set, the HTTP door carried secrets, and every MCP tool
 * reported no sealed channel to every citizen that asked for one.
 *
 * The suite could not catch it because the MCP tests build `McpDependencies`
 * directly from `fakeColony()` and never go through the route. So this reads the
 * source, which is the only place the omission is visible.
 */
const HERE = new URL('.', import.meta.url).pathname
const API_SRC = join(HERE, '..')

/**
 * The top-level fields of one interface. Two-space indentation on purpose —
 * anything deeper belongs to a nested object type and is not a dependency.
 */
function fieldsOf(path: string, name: string): string[] {
  const source = readFileSync(join(API_SRC, path), 'utf8')
  const body = new RegExp(`export interface ${name} \\{(.*?)\\n\\}`, 's').exec(source)?.[1]
  expect(body, `${name} in ${path}`).toBeDefined()
  return [...(body as string).matchAll(/^ {2}readonly (\w+)\??\s*:/gm)].map(
    (match) => match[1] as string,
  )
}

describe('what the MCP route forwards', () => {
  it('names every dependency it holds and the MCP surface accepts', () => {
    const wanted = fieldsOf('mcp/dependencies.ts', 'McpDependencies')
    const held = new Set(fieldsOf('routes/dependencies.ts', 'RouteDependencies'))
    const route = readFileSync(join(API_SRC, 'routes/mcp.ts'), 'utf8')

    const forgotten = wanted
      .filter((field) => held.has(field))
      .filter((field) => !new RegExp(`\\b${field}\\b`).test(route))

    expect(forgotten).toEqual([])
  })

  /**
   * The rejection case. Both lists are parsed out of source, and a parse that
   * quietly returned nothing would make the assertion above vacuously true
   * forever — the failure mode this whole file is about.
   */
  it('is comparing two lists that were actually found', () => {
    expect(fieldsOf('mcp/dependencies.ts', 'McpDependencies').length).toBeGreaterThan(40)
    expect(fieldsOf('routes/dependencies.ts', 'RouteDependencies')).toContain('operatorShares')
  })
})
