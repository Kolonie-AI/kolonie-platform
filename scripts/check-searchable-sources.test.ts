import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * `#1644`. The gate read `git ls-files`, so its set was *what is tracked* — and a
 * file that has not been `git add`ed yet is not in it. That is the whole time a
 * file is new, which is the case the NUL actually arrives in: nobody pastes one
 * into a file they have been editing for a week.
 *
 * The symptom was not a missed byte. It was a byte caught **on CI, one push
 * later**, on a change that was otherwise finished — `apps/api/src/atlas/
 * figures-cache.ts` passed `npm run check` locally and failed the same commit on
 * the runner. Same verdict, six minutes and a round trip apart.
 *
 * So what is asserted here is not *does it find a NUL* — `#1527` settled that —
 * but **which files it looks at**, in both directions. A gate that grew to read
 * ignored files would report `node_modules` and be removed from the chain within
 * a week, taking the defect it was written for with it.
 *
 * It runs the script rather than importing a function out of it: the set is
 * assembled by `git` in a subprocess against a working tree, and a unit test
 * around a helper would assert the part that was never in doubt.
 */
const SCRIPT = path.join(import.meta.dirname, 'check-searchable-sources.mjs')

/**
 * A file whose bytes carry a raw NUL.
 *
 * Built from the escape, which is what the gate's own failure message tells an
 * author to do — a literal one in this file would trip the gate on the test that
 * asserts the gate works.
 */
const WITH_NUL = 'export const separator = `a\u0000b`\n'

let repo: string | undefined

const git = (cwd: string, ...argv: string[]): void => {
  execFileSync('git', argv, { cwd, stdio: 'pipe' })
}

/**
 * A throwaway repository, because the set under test is *this working tree* and
 * the repository the suite runs in is not one a test may add files to.
 */
const aRepo = (): string => {
  const at = mkdtempSync(path.join(tmpdir(), 'searchable-'))
  repo = at
  git(at, 'init', '--quiet')
  // `commit` needs an identity, and a machine running the suite may have none
  // configured. Local to this repository, so nothing leaks into the caller's.
  git(at, 'config', 'user.email', 'test@example.invalid')
  git(at, 'config', 'user.name', 'test')
  return at
}

const write = (at: string, file: string, contents: string): void => {
  mkdirSync(path.join(at, path.dirname(file)), { recursive: true })
  writeFileSync(path.join(at, file), contents)
}

/** The script's own verdict: its exit status, and what it said. */
const run = (at: string): { ok: boolean; output: string } => {
  try {
    return { ok: true, output: execFileSync('node', [SCRIPT], { cwd: at, encoding: 'utf8' }) }
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string }
    return { ok: false, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` }
  }
}

afterEach(() => {
  if (repo !== undefined) rmSync(repo, { recursive: true, force: true })
  repo = undefined
})

describe('which files the searchable gate reads', () => {
  /** The `#1644` case itself. */
  it('fails on a NUL in a file that has not been added yet', () => {
    const at = aRepo()
    write(at, 'src/figures-cache.ts', WITH_NUL)

    const { ok, output } = run(at)

    expect(ok).toBe(false)
    expect(output).toContain('src/figures-cache.ts')
  })

  it('still fails on a NUL in a tracked file', () => {
    const at = aRepo()
    write(at, 'src/tracked.ts', WITH_NUL)
    git(at, 'add', '--all')

    const { ok, output } = run(at)

    expect(ok).toBe(false)
    expect(output).toContain('src/tracked.ts')
  })

  /**
   * The direction that decides whether the check survives. Reading untracked
   * files is only safe because the ignore rules still apply — `node_modules` and
   * `dist` are full of bytes this gate has no opinion about.
   */
  it('says nothing about an ignored file, however many NULs it carries', () => {
    const at = aRepo()
    write(at, '.gitignore', 'node_modules/\ndist/\n')
    write(at, 'node_modules/pkg/index.js', WITH_NUL)
    write(at, 'dist/bundle.js', WITH_NUL)

    const { ok } = run(at)

    expect(ok).toBe(true)
  })

  it('says nothing about a working tree that carries none', () => {
    const at = aRepo()
    write(at, 'src/clean.ts', 'export const separator = `a\\u0000b`\n')

    const { ok } = run(at)

    expect(ok).toBe(true)
  })

  /**
   * A NUL in a `.png` is the file working correctly. The allowlist was already
   * the reason, and it has to keep holding now that untracked files are read —
   * a new binary fixture is exactly the kind of file that sits unadded.
   */
  it('says nothing about a binary extension, added or not', () => {
    const at = aRepo()
    write(at, 'fixtures/icon.png', WITH_NUL)

    const { ok } = run(at)

    expect(ok).toBe(true)
  })
})
