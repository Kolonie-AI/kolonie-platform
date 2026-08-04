import { readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// @ts-expect-error — the generator is a build script, deliberately outside the
// TypeScript project so that nothing in `src/` can import it by accident. It is
// imported here because a test of a generator that reimplements the generator
// tests itself.
import { barrelIsCurrent, storageEntries } from '../../scripts/generate-storage-barrel.mjs'

/**
 * The storage barrel is generated and is not in git (`#271`).
 *
 * Which means the thing that can go wrong is not a stale commit — there is no
 * commit — but a generator that has quietly stopped covering the directory.
 * These two assertions are the whole of what the arrangement promises: what is
 * on disk is what the generator writes, and every module in the directory is in
 * it.
 */
describe('the generated storage barrel', () => {
  it('is what the generator writes, so no build produces a different one', async () => {
    const { current } = (await barrelIsCurrent()) as { current: boolean }

    expect(current).toBe(true)
  })

  it('covers every module in the directory, which is why nobody adds a line', async () => {
    const directory = fileURLToPath(new URL('.', import.meta.url))
    const modules = (await readdir(directory, { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.endsWith('.ts') &&
          !entry.name.endsWith('.test.ts') &&
          entry.name !== 'index.ts',
      )
      .map((entry) => entry.name)

    // The directory is the whole basis of the check, so an empty read would make
    // it pass by finding nothing rather than by everything being covered.
    expect(modules.length).toBeGreaterThan(40)

    const covered = new Set(
      ((await storageEntries()) as readonly { name: string }[]).map((entry) => entry.name),
    )

    expect(modules.filter((name) => !covered.has(name))).toEqual([])
  })
})
