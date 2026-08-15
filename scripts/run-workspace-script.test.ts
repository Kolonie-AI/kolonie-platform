import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error — the runner is a build script, deliberately outside the
// TypeScript project. Imported here because the sentence it uses to decide the
// exit code is the one thing about it that must never be wrong.
import {
  environmentFor,
  scriptFrom,
  verdictFrom,
  workspacesWithScript,
} from './run-workspace-script.mjs'
// @ts-expect-error — outside the TypeScript project, as above.
import { WORKER_BUDGET_VAR } from './test-workers.mjs'

/**
 * `#285`. Running the workspaces concurrently buys back most of the suite's wall
 * clock and introduces exactly one new way to be wrong: **finishing is not
 * passing.**
 *
 * The serial command it replaced could not make this mistake — `a && b && c`
 * stops at the first failure and carries its code out. A concurrent runner lets
 * every workspace finish and then has to *decide*, and a decision can be wrong in
 * a direction nobody notices. A green check over a red workspace is not a
 * degraded answer, it is a false one, and the only reader it has is somebody
 * deciding whether to push.
 *
 * This repository has the same trap recorded one layer down: `npm run check`
 * piped into `grep` reports the grep's exit code, and Prettier's failures are a
 * lowercase `[warn]` that a filter looking for `error` swallows.
 */
describe('deciding whether the suite passed', () => {
  const passed = (name: string) => ({ name, ok: true })
  const failed = (name: string) => ({ name, ok: false })

  it('passes only when every workspace passed', () => {
    const verdict = verdictFrom([passed('@kolonie-ai/core'), passed('@kolonie-ai/db')])

    expect(verdict.code).toBe(0)
    expect(verdict.failed).toEqual([])
  })

  /**
   * The rejection case, and the reason the function exists.
   *
   * The failure is deliberately **not** last. A runner that reports the exit code
   * of the process that finished most recently passes a test where the failure is
   * at the end, and ships the bug that matters — the one where a fast workspace
   * fails and six slower ones succeed after it.
   */
  it('fails when a workspace failed, even though a later one passed', () => {
    const verdict = verdictFrom([
      passed('@kolonie-ai/core'),
      failed('@kolonie-ai/db'),
      passed('@kolonie-ai/api'),
    ])

    expect(verdict.code).toBe(1)
    expect(verdict.failed).toEqual(['@kolonie-ai/db'])
  })

  it('names every workspace that failed, so one log answers where to look', () => {
    const verdict = verdictFrom([
      failed('@kolonie-ai/db'),
      passed('@kolonie-ai/core'),
      failed('@kolonie-ai/api'),
    ])

    expect(verdict.code).toBe(1)
    expect(verdict.failed).toEqual(['@kolonie-ai/db', '@kolonie-ai/api'])
  })

  /**
   * `[].every(...)` is `true`, so an empty run is a pass to anything that only
   * asks this function. The runner refuses to get here — it exits non-zero on
   * finding no workspaces — and this pins the reason that check has to exist
   * rather than leaving it looking like defensive noise.
   */
  it('is the reason the runner refuses an empty list before asking', () => {
    expect(verdictFrom([]).code).toBe(0)
  })
})

/**
 * `#303` made this runner take the script to run, because `typecheck` was serial
 * for the same reason `test` had been and a second runner would have been a second
 * copy of the property above.
 *
 * What is asserted here is the selection rather than the running: which workspaces
 * a script reaches, and which it does not.
 */
describe('choosing what to run', () => {
  const aRepository = async (
    workspaces: Record<string, Record<string, string>>,
    root: Record<string, string> = {},
  ) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'kolonie-runner-'))

    await writeFile(
      path.join(directory, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: ['packages/*'], scripts: root }),
    )

    for (const [name, scripts] of Object.entries(workspaces)) {
      const workspace = path.join(directory, 'packages', name)
      await mkdir(workspace, { recursive: true })
      await writeFile(
        path.join(workspace, 'package.json'),
        JSON.stringify({ name: `@kolonie-ai/${name}`, scripts }),
      )
    }

    return directory
  }

  const namesOf = (found: { name: string }[]) => found.map((entry) => entry.name)

  it('takes the workspaces that have the script', async () => {
    const root = await aRepository({
      core: { typecheck: 'tsc', test: 'vitest' },
      db: { typecheck: 'tsc', test: 'vitest' },
    })

    expect(namesOf(await workspacesWithScript('typecheck', root))).toEqual([
      '@kolonie-ai/core',
      '@kolonie-ai/db',
    ])
  })

  /**
   * What `--if-present` did, and the reason it is not a failure: a workspace
   * without a script is not a workspace that failed one. Adding a script to one
   * workspace must not become a change to every other.
   */
  it('drops a workspace that does not have it, rather than failing on it', async () => {
    const root = await aRepository({
      core: { typecheck: 'tsc' },
      db: { test: 'vitest' },
    })

    expect(namesOf(await workspacesWithScript('typecheck', root))).toEqual(['@kolonie-ai/core'])
  })

  /**
   * The root's own tests are the tests of these scripts, and they run under a
   * different script name so that `test` at the root cannot ask this runner to run
   * itself. It is deliberately not pulled in for anything else: `scripts/` sits
   * outside the TypeScript project, so a rule that added the root to every script
   * would have this file typechecked against a `tsconfig.json` that does not exist.
   */
  it('includes the root for test, under its own script name', async () => {
    const root = await aRepository({ core: { test: 'vitest' } }, { 'test:scripts': 'vitest' })

    const found = await workspacesWithScript('test', root)

    expect(namesOf(found)).toEqual(['root (scripts)', '@kolonie-ai/core'])
    expect(found[0]?.script).toBe('test:scripts')
  })

  it('leaves the root out of every other script', async () => {
    const root = await aRepository(
      { core: { typecheck: 'tsc' } },
      { 'test:scripts': 'vitest', typecheck: 'tsc' },
    )

    expect(namesOf(await workspacesWithScript('typecheck', root))).toEqual(['@kolonie-ai/core'])
  })

  /**
   * A pattern this does not understand contributes no workspaces, and a run that
   * quietly covers a third of the repository looks exactly like one that got
   * faster. Refusing is the only version of that which is visible.
   */
  it('refuses a workspace pattern it does not understand', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'kolonie-runner-'))
    await writeFile(
      path.join(directory, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: ['packages/**/deep'] }),
    )

    await expect(workspacesWithScript('test', directory)).rejects.toThrow(/Unsupported workspace/)
  })
})

/**
 * The argument is one word and it is required, so that the command somebody types
 * while guessing does not run the whole test suite.
 */
describe('reading the script name', () => {
  it('takes the first argument', () => {
    expect(scriptFrom(['typecheck'])).toBe('typecheck')
  })

  it('refuses an empty invocation', () => {
    expect(scriptFrom([])).toBeUndefined()
  })

  it('refuses a flag, which is what a mistyped invocation looks like', () => {
    expect(scriptFrom(['--workspaces'])).toBeUndefined()
  })
})

/**
 * `#963`. This runner sizes itself from the core count and so does each vitest it
 * starts, and until the budget below nothing multiplied the two together: on
 * CLAUDE002 that was thirteen Node processes and six Postgres backends on eight
 * cores, the machine swapped, and `packages/db` and `apps/api` both went red on
 * timeouts. The arithmetic lives in `test-workers.mjs`; what is asserted here is
 * that the number reaches the children, and that nothing else about their
 * environment moved.
 */
describe('what the children are told', () => {
  const environment = { DATABASE_URL: 'postgres://localhost/kolonie_test', PATH: '/usr/bin' }

  it('publishes a share of the machine to a test run', () => {
    expect(environmentFor('test', 2, environment)[WORKER_BUDGET_VAR]).toBeDefined()
  })

  /**
   * A `tsc` is one process and divides into nothing, so a budget published to it
   * would be a number nobody reads — and a number nobody reads is one the next
   * reader has to work out is inert.
   */
  it('says nothing to a script that has no workers', () => {
    expect(environmentFor('typecheck', 4, environment)[WORKER_BUDGET_VAR]).toBeUndefined()
  })

  /**
   * The whole reason the children inherited the environment in the first place:
   * without `DATABASE_URL`, `packages/db` fails every file with the message
   * D-009 requires instead of skipping silently.
   */
  it('leaves the rest of the environment exactly as it was', () => {
    expect(environmentFor('test', 2, environment)).toMatchObject(environment)
    expect(environmentFor('typecheck', 2, environment)).toEqual(environment)
  })
})
