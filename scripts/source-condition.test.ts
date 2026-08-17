import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { createServer } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
// @ts-expect-error — a build script, deliberately outside the TypeScript project,
// for the same reason the workspace runner and the dist check are.
import { SOURCE_CONDITION, sourceResolve } from './source-condition.mjs'

/**
 * `#1156`. A test used to reach its sibling workspaces through `dist`, so nothing
 * downstream could run until `tsc -b` had finished for everything upstream — and
 * `npm run test` began by building the whole repository to make that true.
 *
 * The mechanism that replaced it is an export condition. The reasoning is in
 * `source-condition.mjs`; what is here is the property, and the reason it needs a
 * test at all is that **the failure is silent in both directions**. A config that
 * loses the condition goes back to reading `dist` and stays green — against a
 * stale artefact, which is `#309` again. A package that stops exporting the
 * condition is caught nowhere until somebody deletes `dist` and wonders why.
 *
 * So this asserts the whole chain rather than one link of it: the packages
 * export it, the vitest configs opt into it, and a sibling import out of a test
 * file lands in `src`.
 */
const ROOT = path.join(import.meta.dirname, '..')

/** The workspaces that publish an `exports` map — the four a sibling can import. */
const LIBRARIES = ['packages/core', 'packages/db', 'packages/mcp', 'packages/verifiers']

const manifest = (workspace: string): Record<string, never> =>
  JSON.parse(readFileSync(path.join(ROOT, workspace, 'package.json'), 'utf8'))

describe('the export condition, as the packages declare it', () => {
  it.each(LIBRARIES)('%s resolves to source under the condition', (workspace) => {
    const entry = (manifest(workspace) as Record<string, Record<string, string>>)['exports']?.['.']
    expect(entry).toBeDefined()
    expect(entry?.[SOURCE_CONDITION]).toMatch(/^\.\/src\//)
  })

  /**
   * **Order is not cosmetic here.** Node and Vite both take the first matching
   * key, so a condition listed after `default` is a condition that never applies
   * — and the symptom is that everything keeps working, through `dist`.
   */
  it.each(LIBRARIES)('%s lists the condition before `default`', (workspace) => {
    const entry = (manifest(workspace) as Record<string, Record<string, string>>)['exports']?.['.']
    const keys = Object.keys(entry ?? {})
    expect(keys.indexOf(SOURCE_CONDITION)).toBeGreaterThanOrEqual(0)
    expect(keys.indexOf(SOURCE_CONDITION)).toBeLessThan(keys.indexOf('default'))
  })

  /**
   * The other half of the same decision, and the reason the condition is
   * namespaced rather than called `development`: a consumer that has not opted
   * in must still get the artefact. `types` and `default` are what everybody
   * outside this repository reads.
   */
  it.each(LIBRARIES)('%s still points every other consumer at dist', (workspace) => {
    const entry = (manifest(workspace) as Record<string, Record<string, string>>)['exports']?.['.']
    expect(entry?.['types']).toMatch(/^\.\/dist\//)
    expect(entry?.['default']).toMatch(/^\.\/dist\//)
  })

  /**
   * **The hazard the namespacing exists for, asserted rather than only written
   * down.** A published package ships `dist` and not `src`, so a condition that
   * something applies by itself — `development`, which Vite sets in dev mode —
   * would point a stranger's build at a path that is not in the tarball.
   *
   * Only the published ones, because only they have a tarball: `packages/db` and
   * `packages/verifiers` are `private` and are consumed from the tree. If `src`
   * is ever added to a published `files`, the trade this was chosen under has
   * changed and the naming should be reconsidered — which is what this failing
   * test is for.
   */
  it.each(LIBRARIES)('%s does not ship src, which is why the name is namespaced', (workspace) => {
    const declared = manifest(workspace) as Record<string, unknown>
    if (declared['private'] === true) {
      expect(declared['files']).toBeUndefined()
      return
    }
    expect(declared['files']).toBeDefined()
    expect(declared['files'] as string[]).not.toContain('src')
  })
})

describe('the export condition, as the test configurations read it', () => {
  /**
   * Every `vitest.config.ts` in the tree, found rather than listed. A workspace
   * added later gets no reminder to opt in, and the whole point of one shared
   * condition is that a workspace resolving its siblings differently from its
   * neighbours cannot happen quietly.
   */
  const configs = [
    'vitest.config.ts',
    ...['packages', 'apps'].flatMap((group) =>
      readdirSync(path.join(ROOT, group))
        .map((name) => path.join(group, name, 'vitest.config.ts'))
        .filter((candidate) => {
          try {
            readFileSync(path.join(ROOT, candidate))
            return true
          } catch {
            return false
          }
        }),
    ),
  ]

  it('finds every workspace that has one', () => {
    expect(configs.length).toBeGreaterThanOrEqual(11)
  })

  it.each(configs)('%s spreads the shared resolve', (config) => {
    expect(readFileSync(path.join(ROOT, config), 'utf8')).toContain('...sourceResolve')
  })

  /**
   * **A `test.projects` entry inherits `resolve` only under `extends: true`.**
   *
   * The two config keys sit one line apart and behave nothing alike: `maxWorkers`
   * and `coverage` are read from the root whatever a project says, so a config
   * missing `extends` looks entirely healthy — and then every project builds its
   * own Vite server with Vitest's default conditions and reads `dist`.
   *
   * `apps/api` was exactly that, and the symptom was the whole workspace failing
   * at collection with no `dist` present while `packages/db` beside it passed.
   * The assertion is textual because the alternative is loading eleven configs to
   * ask one question of two of them.
   */
  it.each(configs)('%s extends the root config in every project it declares', (config) => {
    const source = readFileSync(path.join(ROOT, config), 'utf8')
    const projects = source.indexOf('projects: [')
    if (projects < 0) return

    // Every `{` that opens a project entry — one indentation level in from the
    // `projects: [` that holds them — must be followed by `extends: true` before
    // the `test: {` it wraps.
    const entries = source
      .slice(projects)
      .split(/^ {6}\{$/m)
      .slice(1)
    expect(entries.length).toBeGreaterThan(0)
    for (const entry of entries) {
      expect(entry.slice(0, entry.indexOf('test: {'))).toContain('extends: true')
    }
  })

  /**
   * **The three environments, asserted as three, because each was found by
   * removing `dist` and watching what still failed.**
   *
   * `ssr` carries the test files and `__vitest__` carries `globalSetup` — two
   * runners, two resolvers, and a config that sets one of them looks entirely
   * healthy while the other quietly reads the build output. `__vitest__` is
   * Vitest's own internal environment name; this is the assertion that turns a
   * rename of it into a failure here rather than into a suite that passes
   * against a stale artefact.
   */
  it('names every environment vitest resolves through', () => {
    expect(sourceResolve.resolve.conditions).toContain(SOURCE_CONDITION)
    expect(sourceResolve.ssr.resolve.conditions).toContain(SOURCE_CONDITION)
    expect(sourceResolve.environments.__vitest__.resolve.conditions).toContain(SOURCE_CONDITION)
  })

  /**
   * `module` is not in the list, because Vitest's own
   * `getDefaultResolveOptions` removes it. Spreading Vite's server conditions
   * unchanged would put it back and silently change which entry point every
   * third-party dependency resolves to under test — a far larger change than
   * this one, arriving as a side effect of it.
   */
  it('otherwise resolves exactly as vitest would', () => {
    expect(sourceResolve.resolve.conditions).not.toContain('module')
  })
})

describe('a sibling import out of a test file', () => {
  let resolve: (id: string, importer: string) => Promise<string | undefined>
  let close: () => Promise<void>

  beforeAll(async () => {
    const server = await createServer({
      configFile: false,
      server: { middlewareMode: true },
      ...sourceResolve,
    })
    close = () => server.close()
    // The `ssr` environment, because that is the one vitest runs node tests
    // through — see the measurement in `source-condition.mjs`. Resolving through
    // any other environment here would assert a path the tests do not take.
    resolve = async (id, importer) =>
      (await server.environments.ssr.pluginContainer.resolveId(id, importer))?.id
  })

  afterAll(async () => {
    await close()
  })

  /**
   * **The rejection case.** Not *the import works* — it worked before, through
   * `dist`. This asserts where it lands, which is the only difference between
   * the two states and the one a green suite cannot otherwise tell apart.
   *
   * It holds with no `dist` on disk at all, which is the acceptance criterion
   * this issue was written for.
   */
  it.each(LIBRARIES)('lands in %s/src and not in its dist', async (workspace) => {
    const importer = path.join(ROOT, 'packages/verifiers/src/a-test-file.test.ts')
    const id = await resolve(manifest(workspace)['name'] as unknown as string, importer)

    expect(id).toBeDefined()
    expect(id).toContain(`${path.join(ROOT, workspace, 'src')}${path.sep}`)
    expect(id).not.toContain(`${path.sep}dist${path.sep}`)
  })
})
