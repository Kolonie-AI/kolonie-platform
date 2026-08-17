import { describe, expect, it } from 'vitest'
// @ts-expect-error — a build script, deliberately outside the TypeScript project.
import {
  affectedFrom,
  closingLine,
  graphFrom,
  withDependents,
  workspaceOf,
} from './check-affected.mjs'

type Node = { directory: string; name: string; dependsOn: string[] }

/**
 * The real shape of this repository, small enough to read: `core` under
 * everything, `db` and `verifiers` on top of it, `api` on top of those, and
 * `mcp` off to one side depending on nothing.
 */
const GRAPH: Node[] = [
  { directory: 'packages/core', name: '@kolonie-ai/core', dependsOn: [] },
  { directory: 'packages/db', name: '@kolonie-ai/db', dependsOn: ['@kolonie-ai/core'] },
  { directory: 'packages/mcp', name: '@kolonie.ai/mcp', dependsOn: [] },
  {
    directory: 'packages/verifiers',
    name: '@kolonie-ai/verifiers',
    dependsOn: ['@kolonie-ai/core'],
  },
  {
    directory: 'apps/api',
    name: '@kolonie-ai/api',
    dependsOn: ['@kolonie-ai/core', '@kolonie-ai/db', '@kolonie-ai/verifiers'],
  },
]

describe('which workspace a path belongs to', () => {
  it('finds the workspace a file sits under', () => {
    expect(workspaceOf('apps/api/src/mcp/tools.ts', GRAPH).directory).toBe('apps/api')
  })

  it('gives nothing for a file outside every workspace', () => {
    expect(workspaceOf('tsconfig.base.json', GRAPH)).toBeUndefined()
    expect(workspaceOf('scripts/check-affected.mjs', GRAPH)).toBeUndefined()
  })

  /**
   * A prefix match on the bare string would put `apps/api-docs/readme.md` inside
   * `apps/api`, and the reader would be told a workspace was affected that does
   * not exist. The separator is part of the comparison.
   */
  it('does not mistake a longer sibling directory for the workspace', () => {
    expect(workspaceOf('apps/api-docs/readme.md', GRAPH)).toBeUndefined()
  })
})

describe('who else has to run', () => {
  it('pulls in everything above a changed workspace', () => {
    expect(withDependents(['packages/core'], GRAPH)).toEqual([
      'apps/api',
      'packages/core',
      'packages/db',
      'packages/verifiers',
    ])
  })

  it('leaves a leaf on its own', () => {
    expect(withDependents(['apps/api'], GRAPH)).toEqual(['apps/api'])
  })

  /**
   * Walked to a fixed point rather than one level deep. `api` reaches `core` only
   * through `db` and `verifiers` here as well as directly, but a package added
   * tomorrow may reach it through one hop only, and a two-level walk would be
   * wrong that day without failing.
   */
  it('follows the graph further than one hop', () => {
    const chain: Node[] = [
      { directory: 'packages/core', name: 'core', dependsOn: [] },
      { directory: 'packages/db', name: 'db', dependsOn: ['core'] },
      { directory: 'apps/api', name: 'api', dependsOn: ['db'] },
    ]

    expect(withDependents(['packages/core'], chain)).toEqual([
      'apps/api',
      'packages/core',
      'packages/db',
    ])
  })
})

describe('what a change means', () => {
  it('runs one workspace for a one-file change in it', () => {
    const affected = affectedFrom(['apps/api/src/mcp/tools.ts'], GRAPH)

    expect(affected.directories).toEqual(['apps/api'])
    expect(affected.skipped).toContain('packages/db')
    expect(affected.everything).toBe(false)
  })

  it('runs every workspace for a change in core', () => {
    const affected = affectedFrom(['packages/core/src/agent.ts'], GRAPH)

    expect(affected.directories).toEqual([
      'apps/api',
      'packages/core',
      'packages/db',
      'packages/verifiers',
    ])
    expect(affected.skipped).toEqual(['packages/mcp'])
  })

  /**
   * The coarse answer, and the honest one. A root file can reach any workspace,
   * so every workspace runs — and the file that forced it is named, because a
   * one-line edit that ran all ten is otherwise inexplicable.
   */
  it('runs everything when a file belongs to no workspace, and says which file', () => {
    const affected = affectedFrom(['tsconfig.base.json', 'apps/api/src/x.ts'], GRAPH)

    expect(affected.everything).toBe(true)
    expect(affected.because).toBe('tsconfig.base.json')
    expect(affected.skipped).toEqual([])
  })

  /** The rejection case `#1157` asks for by name. */
  it('runs no tests at all when nothing differs from the base', () => {
    const affected = affectedFrom([], GRAPH)

    expect(affected.nothing).toBe(true)
    expect(affected.directories).toEqual([])
    expect(affected.everything).toBe(false)
  })
})

describe('the last line', () => {
  it('names what was skipped and sends the reader to npm run check', () => {
    const line = closingLine(affectedFrom(['apps/api/src/x.ts'], GRAPH))

    expect(line).toContain('packages/db')
    expect(line).toContain('npm run check')
  })

  /**
   * **Even when everything ran.** That is the moment somebody is most likely to
   * push, and this command still skips the migrations and changelog checks.
   */
  it('still refuses to be the gate when every workspace ran', () => {
    const line = closingLine(affectedFrom(['tsconfig.base.json'], GRAPH))

    expect(line).toContain('not npm run check')
  })

  it('says so plainly when nothing was skipped', () => {
    expect(closingLine({ everything: false, skipped: [] })).toContain('Skipped nothing')
  })
})

/**
 * Against the repository itself, so that a workspace added tomorrow is caught by
 * the arithmetic rather than by the fixture above.
 */
describe('the real graph', () => {
  it('reads every workspace that has tests', async () => {
    const graph = await graphFrom()

    expect(graph.length).toBeGreaterThanOrEqual(10)
    expect(graph.map((node: Node) => node.directory)).toContain('apps/api')
  })

  it('puts every workspace above core', async () => {
    const graph = await graphFrom()
    const all = graph.map((node: Node) => node.directory).sort()

    expect(withDependents(['packages/core'], graph)).toEqual(
      all.filter((directory: string) => directory !== 'packages/mcp'),
    )
  })

  it('leaves the database alone for a change in the API', async () => {
    const graph = await graphFrom()
    const affected = affectedFrom(['apps/api/src/mcp/tools.ts'], graph)

    expect(affected.directories).toEqual(['apps/api'])
    expect(affected.skipped).toContain('packages/db')
  })
})
