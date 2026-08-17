import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * **Every test file is run once, and a workspace that runs one twice says so
 * here** (`#1190`).
 *
 * `packages/db` ran all 188 of its files twice for as long as it had two
 * projects. `test.include` is one of the keys `extends: true` *merges* rather
 * than replaces, so the root-level `include` was concatenated onto each
 * project's own and `isolated` — whose whole purpose is one file — matched
 * everything. Nothing failed. Both copies were green, the file count in the
 * summary was the doubled one, and the only visible symptom was that the
 * package took twice as long as its own measurements said it should.
 *
 * That is why this lives in the root suite rather than in `packages/db`: it is
 * a property of how the workspaces are run, like the runner test beside it, and
 * the failure it catches is one no workspace's own suite can report. A doubled
 * run is not a red test. It is a green one, twice.
 *
 * It asserts against the filesystem rather than against a number. A count
 * written down here would have to be edited by whoever adds a test file, which
 * makes it a chore rather than a check — and the one edit that matters, adding
 * a file that never gets enumerated, is the one that would look like all the
 * others.
 */
const ROOT = path.join(import.meta.dirname, '..')

const VITEST = path.join(ROOT, 'node_modules/vitest/vitest.mjs')

/** Directories that never hold a test file this repository owns. */
const NOT_OURS = new Set(['node_modules', 'dist', 'coverage', 'drizzle'])

/** The nested workspaces, which the root workspace does not run. */
const NESTED = new Set(['apps', 'packages'])

const posix = (file: string): string => file.split(path.sep).join('/')

const hasConfig = (workspace: string): boolean => {
  try {
    readFileSync(path.join(ROOT, workspace, 'vitest.config.ts'))
    return true
  } catch {
    return false
  }
}

/**
 * Every workspace with a vitest config, found rather than listed — for the same
 * reason `source-condition.test.ts` finds them: a workspace added later gets no
 * reminder to be checked, and one running its files twice in silence is exactly
 * the thing that would go unnoticed.
 */
const WORKSPACES = [
  '.',
  ...['apps', 'packages'].flatMap((group) =>
    readdirSync(path.join(ROOT, group), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${group}/${entry.name}`)
      .filter(hasConfig),
  ),
]

const walk = (directory: string, skip: Set<string>): string[] =>
  readdirSync(path.join(ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
    const here = `${directory}/${entry.name}`
    if (entry.isDirectory()) return skip.has(entry.name) ? [] : walk(here, skip)
    return entry.name.endsWith('.test.ts') ? [here] : []
  })

/** The test files a workspace owns, as paths relative to it. */
const onDisk = (workspace: string): string[] => {
  const skip = workspace === '.' ? new Set([...NOT_OURS, ...NESTED]) : NOT_OURS
  return walk(workspace, skip)
    .map((file) => posix(path.relative(path.join(ROOT, workspace), path.join(ROOT, file))))
    .sort()
}

/** One line of `vitest list --filesOnly`: `src/foo.test.ts`, or `[project] src/foo.test.ts`. */
interface Enumerated {
  readonly project: string | undefined
  readonly file: string
}

/**
 * What vitest itself would collect, asked of vitest itself. Reading the config
 * and reasoning about the globs would assert what the config says; this asserts
 * what vitest does with it, and the whole defect was the gap between the two.
 */
const enumerate = (workspace: string, config?: string): Enumerated[] =>
  execFileSync(
    process.execPath,
    [
      VITEST,
      'list',
      '--filesOnly',
      '--root',
      workspace,
      ...(config === undefined ? [] : ['--config', config]),
    ],
    { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const named = /^\[(.+?)] (.+)$/.exec(line)
      return named === null
        ? { project: undefined, file: line.trim() }
        : { project: named[1], file: (named[2] ?? '').trim() }
    })

describe('what each workspace collects', () => {
  it('finds every workspace that has a vitest config', () => {
    expect(WORKSPACES.length).toBeGreaterThanOrEqual(8)
  })

  /**
   * Equality of the whole sorted list rather than of its length, which catches
   * both directions at once: a file enumerated twice makes the collected list
   * longer than the disk, and a file matched by no project makes it shorter.
   */
  it.each(WORKSPACES)(
    '%s enumerates every test file it owns, exactly once',
    (workspace) => {
      expect(
        enumerate(workspace)
          .map((entry) => entry.file)
          .sort(),
      ).toEqual(onDisk(workspace))
    },
    60_000,
  )
})

/**
 * **The two projects in `packages/db`, and what happens to them when the
 * isolation list changes.**
 *
 * The list is the moving part — `#295` created it empty, `#1127` put a file in
 * it — so what is asserted is that the split follows it, in both directions. A
 * config that has stopped reading the list can still be right about today's one
 * entry.
 */
const DB = 'packages/db'

const DB_CONFIG = path.join(ROOT, DB, 'vitest.config.ts')

const DECLARATION = /const ISOLATED: string\[] = (\[[\s\S]*?])/

const isolatedList = (source: string): string[] =>
  JSON.parse(
    (DECLARATION.exec(source)?.[1] ?? '[]').replace(/'/g, '"').replace(/,(\s*])/, '$1'),
  ) as string[]

/**
 * The config as it is, with a different isolation list, run once and removed.
 *
 * Written beside the real config rather than out of the tree because a project's
 * `include` glob is resolved against the directory the config file is in, not
 * against `--root` — a probe anywhere else collects nothing and passes for the
 * wrong reason. It is safe there because the gates that read the tree all finish
 * before `npm test` starts it, and it is in both ignore files in case a crash
 * leaves one behind.
 */
const withIsolated = <T>(name: string, isolated: string[], ask: (config: string) => T): T => {
  const source = readFileSync(DB_CONFIG, 'utf8')
  const declared = DECLARATION.exec(source)?.[1]
  expect(declared).toBeDefined()
  // `--config` is resolved against `--root`, so what the caller passes on is the
  // name alone rather than the path this writes to.
  const file = `vitest.${name}-probe.config.ts`
  writeFileSync(
    path.join(ROOT, DB, file),
    source.replace(declared ?? '', JSON.stringify(isolated).replace(/"/g, "'")),
  )
  try {
    return ask(file)
  } finally {
    rmSync(path.join(ROOT, DB, file), { force: true })
  }
}

describe('the isolation list in packages/db', () => {
  const ISOLATED = isolatedList(readFileSync(DB_CONFIG, 'utf8'))

  it('is read at all', () => {
    expect(ISOLATED.length).toBeGreaterThan(0)
    for (const file of ISOLATED) expect(onDisk(DB)).toContain(file)
  })

  it('puts exactly the files on it in the isolated project, and the rest in the shared one', () => {
    const collected = enumerate(DB)
    const isolated = collected.filter((entry) => entry.project === 'isolated')
    expect(isolated.map((entry) => entry.file).sort()).toEqual([...ISOLATED].sort())
    expect(collected.filter((entry) => entry.project === 'shared')).toHaveLength(
      onDisk(DB).length - ISOLATED.length,
    )
  }, 60_000)

  /**
   * **The rejection case, upwards.** A second entry must move exactly one more
   * file across, and move it rather than copy it — under the merged `include`
   * the total went up by 188 instead of staying still.
   */
  it('moves one more file, and only one, when something is added to it', () => {
    const also = onDisk(DB).find((file) => !ISOLATED.includes(file))
    expect(also).toBeDefined()
    const collected = withIsolated('grown', [...ISOLATED, also ?? ''], (config) =>
      enumerate(DB, config),
    )

    expect(collected.map((entry) => entry.file).sort()).toEqual(onDisk(DB))
    expect(collected.filter((entry) => entry.project === 'isolated')).toHaveLength(
      ISOLATED.length + 1,
    )
  }, 60_000)

  /**
   * **The rejection case, downwards, and the older trap.** An empty list must
   * leave one project holding everything once. A project whose `include` is
   * empty falls back to vitest's default and matches everything, which is the
   * doubling `#295` measured before the second project was made conditional —
   * so this is the assertion that the guard around it still guards.
   */
  it('leaves one project holding everything when it is emptied', () => {
    const collected = withIsolated('emptied', [], (config) => enumerate(DB, config))

    expect(collected.map((entry) => entry.file).sort()).toEqual(onDisk(DB))
    expect(collected.filter((entry) => entry.project === 'isolated')).toHaveLength(0)
  }, 60_000)
})
