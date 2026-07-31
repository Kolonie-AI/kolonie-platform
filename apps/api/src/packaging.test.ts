import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The api's *runtime* dependencies have to be declared and shipped, and neither
 * `tsc` nor the test suite can tell you when one is not.
 *
 * This exists because of a deploy on 2026-07-31. `server.ts` gained
 * `import { httpContributionReader } from '@kolonie-ai/verifiers'` — a value
 * import where every previous one from that package had been `import type`.
 * Types are erased at compile time, so the workspace resolved it, `npm run
 * check` was green, the image built and pushed, and the container exited on its
 * first import because the Dockerfile copied only `packages/verifiers/assets`.
 *
 * The rollback caught it, which is the system working. What nothing caught is
 * that the api's own manifest never listed the package it now imports — and a
 * green build plus a green test suite plus a successfully pushed image is a very
 * convincing way to be wrong.
 */
const HERE = new URL('.', import.meta.url).pathname
const API_ROOT = join(HERE, '..')

const manifest = JSON.parse(readFileSync(join(API_ROOT, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>
}

const dockerfile = readFileSync(join(API_ROOT, 'Dockerfile'), 'utf8')

/** Every `.ts` under `src`, excluding tests and fixtures — what actually ships. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === '__fixtures__' ? [] : sources(path)
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) return []
    return [path]
  })
}

/**
 * Workspace packages imported for their *values*, not their types.
 *
 * `import type { X } from '…'` and `import { type X } from '…'` are erased, so
 * they need nothing at runtime. Anything else does.
 */
function valueImports(source: string): string[] {
  const found = new Set<string>()

  for (const match of source.matchAll(
    /import\s+(type\s+)?([^'"]*?)from\s+'(@kolonie-ai\/[a-z-]+)'/g,
  )) {
    const [, typeKeyword, clause, pkg] = match
    if (typeKeyword !== undefined) continue

    // `import { type A, type B } from '…'` is also fully erased. Only a clause
    // with at least one binding that is *not* prefixed `type` needs the package.
    const bindings = (clause ?? '')
      .replace(/[{}]/g, '')
      .split(',')
      .map((binding) => binding.trim())
      .filter((binding) => binding.length > 0)

    if (bindings.length > 0 && bindings.every((binding) => binding.startsWith('type '))) continue

    found.add(pkg as string)
  }

  return [...found]
}

describe('what the api imports at runtime', () => {
  const imported = [
    ...new Set(
      sources(join(API_ROOT, 'src')).flatMap((file) => valueImports(readFileSync(file, 'utf8'))),
    ),
  ].sort()

  it('imports at least one workspace package for its values, or this test proves nothing', () => {
    expect(imported.length).toBeGreaterThan(0)
  })

  it.each(imported)('declares %s in its own package.json', (pkg) => {
    expect(Object.keys(manifest.dependencies ?? {})).toContain(pkg)
  })

  /**
   * The half the manifest cannot enforce. npm is satisfied by a workspace link;
   * the image is only satisfied by a `dist` that was copied into it.
   */
  it.each(imported)('copies %s into the runtime image', (pkg) => {
    const name = pkg.replace('@kolonie-ai/', '')
    expect(dockerfile).toContain(`./packages/${name}/dist`)
    expect(dockerfile).toContain(`./packages/${name}/package.json`)
  })
})
