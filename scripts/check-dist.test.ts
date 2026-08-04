import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error — a build script, deliberately outside the TypeScript project,
// for the same reason the workspace runner is. Imported here because a check that
// is wrong in the quiet direction is worse than no check.
import { distGaps, excludeToRegExp, expectedOutputs, missingOutputs } from './check-dist.mjs'

/**
 * `#309`. This check exists because `tsc -b` reports a project up to date from
 * its `.tsbuildinfo` rather than from its outputs, so a missing emitted file
 * survives `npm run build` and surfaces as a test failure that names neither.
 *
 * **Its only failure mode that matters is passing a tree that is broken**, and
 * both halves of that are here: an exclude pattern it does not understand must
 * not silently exclude nothing, and a missing output must not be lost because the
 * workspace has hundreds of files that are fine.
 */
describe('turning a tsconfig exclude into a matcher', () => {
  it('matches a test file at any depth, including none', () => {
    const pattern = excludeToRegExp('src/**/*.test.ts')

    expect(pattern.test('src/guard.test.ts')).toBe(true)
    expect(pattern.test('src/mcp/tools/guard.test.ts')).toBe(true)
    expect(pattern.test('src/mcp/guard.ts')).toBe(false)
  })

  it('matches everything under a fixtures directory', () => {
    const pattern = excludeToRegExp('src/**/__fixtures__/**')

    expect(pattern.test('src/storage/__fixtures__/agents.ts')).toBe(true)
    expect(pattern.test('src/storage/__fixtures__/nested/rows.ts')).toBe(true)
    expect(pattern.test('src/storage/agents.ts')).toBe(false)
  })

  it('matches a single named file and nothing beside it', () => {
    const pattern = excludeToRegExp('src/test-worker-setup.ts')

    expect(pattern.test('src/test-worker-setup.ts')).toBe(true)
    expect(pattern.test('src/nested/test-worker-setup.ts')).toBe(false)
  })

  /**
   * The quiet-failure guard. A pattern this does not implement would match
   * nothing, every excluded test file would arrive as a missing output, and the
   * check would fail on a tree that is green — at which point somebody removes it
   * from `npm test` and the original defect comes back.
   */
  it('refuses a pattern it does not implement rather than excluding nothing', () => {
    expect(() => excludeToRegExp('src/**/*.{test,spec}.ts')).toThrow(/Unsupported exclude pattern/)
  })
})

describe('the outputs a build owes', () => {
  const sources = [
    'index.ts',
    'continuity/memory-code.ts',
    'continuity/memory-code.test.ts',
    'storage/__fixtures__/rows.ts',
    'test-worker-setup.ts',
    'notes.md',
  ]

  it('is one .js per source file, without the excluded ones', () => {
    expect(
      expectedOutputs(sources, [
        'src/**/*.test.ts',
        'src/**/__fixtures__/**',
        'src/test-worker-setup.ts',
      ]).sort(),
    ).toEqual(['continuity/memory-code.js', 'index.js'])
  })

  it('reports the expected outputs a dist has not got', () => {
    const expected = ['index.js', 'continuity/memory-code.js']

    expect(missingOutputs(expected, ['index.js'])).toEqual(['continuity/memory-code.js'])
    expect(missingOutputs(expected, ['index.js', 'continuity/memory-code.js'])).toEqual([])
  })

  /**
   * **Extra output is not a gap.** Every large workspace here carries orphaned
   * `.js` from renamed or deleted sources — 114 files against 80 sources in
   * `packages/core` on 2026-08-04 — and a check that failed on those would be red
   * on `main` on the day it landed.
   */
  it('does not mind a dist that carries more than it owes', () => {
    expect(missingOutputs(['index.js'], ['index.js', 'gone/renamed.js'])).toEqual([])
  })
})

describe('walking a tree', () => {
  const workspace = async (root: string, directory: string, files: Record<string, string>) => {
    for (const [relative, contents] of Object.entries(files)) {
      const full = path.join(root, directory, relative)
      await mkdir(path.dirname(full), { recursive: true })
      await writeFile(full, contents)
    }
  }

  const treeWith = async (dist: Record<string, string>) => {
    const root = await mkdtemp(path.join(tmpdir(), 'check-dist-'))
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }))
    await workspace(root, 'packages/core', {
      'tsconfig.build.json': JSON.stringify({ exclude: ['src/**/*.test.ts'] }),
      'src/index.ts': 'export const a = 1\n',
      'src/deep/thing.ts': 'export const b = 2\n',
      'src/deep/thing.test.ts': 'export const c = 3\n',
      ...dist,
    })
    return root
  }

  it('says nothing about a workspace whose dist is complete', async () => {
    const root = await treeWith({ 'dist/index.js': '', 'dist/deep/thing.js': '' })

    expect(await distGaps(root)).toEqual([])
  })

  it('names the workspace and the file when an output is missing', async () => {
    const root = await treeWith({ 'dist/index.js': '' })

    expect(await distGaps(root)).toEqual([
      { directory: path.join('packages', 'core'), missing: ['deep/thing.js'] },
    ])
  })

  /**
   * A workspace with no `dist` at all has never been built, which is the same
   * defect one step earlier and must not read as "nothing to check".
   */
  it('treats an absent dist as every output missing', async () => {
    const root = await treeWith({})

    expect(await distGaps(root)).toEqual([
      { directory: path.join('packages', 'core'), missing: ['deep/thing.js', 'index.js'] },
    ])
  })
})
