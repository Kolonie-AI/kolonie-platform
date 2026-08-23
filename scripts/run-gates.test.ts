import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// @ts-expect-error — a build script, deliberately outside the TypeScript project,
// for the same reason the workspace runner is. Imported here because a runner
// that loses a failure is worse than no runner.
import { gatesFrom, report } from './run-gates.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

type Result = { name: string; ok: boolean; seconds: number; output: string }

const result = (name: string, ok: boolean, output = ''): Result => ({
  name,
  ok,
  seconds: 1.5,
  output,
})

describe('choosing what to run', () => {
  it('takes the gates named on the command line, in order', () => {
    expect(gatesFrom(['lint', 'format:check'])).toEqual(['lint', 'format:check'])
  })

  /**
   * The empty list is the one that must not read as a pass. A phase naming no
   * gate is a `package.json` somebody edited badly, and six checks silently
   * ceasing to run looks exactly like six checks passing quickly.
   */
  it('yields nothing when only flags are given, which the caller treats as a failure', () => {
    expect(gatesFrom([])).toEqual([])
    expect(gatesFrom(['--phase=tree'])).toEqual([])
  })
})

describe('what the reader gets', () => {
  it('prints each gate under its own name, with a rule around it', () => {
    const printed = report([result('lint', true, 'nothing to fix')])

    expect(printed).toContain('lint — passed')
    expect(printed).toContain('nothing to fix')
  })

  /**
   * **A gate that passes quietly still gets a banner.** `check:lock` prints
   * nothing at all when it is happy, and *"it printed nothing"* and *"it did not
   * run"* look identical in a log otherwise — only one of those is fine.
   */
  it('says so when a gate produced no output at all', () => {
    expect(report([result('check:lock', true)])).toContain('(no output)')
  })

  /**
   * The ordering guarantee. The runner resolves gates in whatever order they
   * finish — `check:lock` in 200 ms, `lint` in 20 s — and the blocks must still
   * appear in the order the phase declared them, so two runs of the same phase
   * can be read side by side.
   */
  it('keeps the declared order whatever order the gates finished in', () => {
    const declared = ['check:lock', 'format:check', 'lint']
    const printed = report(declared.map((name) => result(name, true, `output of ${name}`)))

    const positions = declared.map((name) => printed.indexOf(`output of ${name}`))
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    expect(positions.every((at) => at > 0)).toBe(true)
  })

  /**
   * The rejection case, and the reason the whole phase exists: **all six answers,
   * not the first one.** A shell chain would have stopped at `format:check` and
   * said nothing about `lint` or the four behind it.
   */
  it('reports every gate even when one has already failed', () => {
    const printed = report([
      result('check:lock', true, 'lock is in step'),
      result('format:check', false, '[warn] scripts/run-gates.mjs'),
      result('lint', true, 'clean'),
    ])

    expect(printed).toContain('lock is in step')
    expect(printed).toContain('[warn] scripts/run-gates.mjs')
    expect(printed).toContain('clean')
    expect(printed).toContain('  FAIL  format:check')
    expect(printed).toContain('  pass  lint')
  })

  /** Named on its own line, so the answer survives six blocks of scrollback. */
  it('names each failing gate on a line of its own', () => {
    const printed = report([
      result('check:lock', false),
      result('format:check', true),
      result('lint', false),
    ])

    const named = printed.split('\n').filter((line) => line.startsWith('FAILED: '))
    expect(named).toEqual(['FAILED: check:lock', 'FAILED: lint'])
  })

  it('names nothing when every gate passed', () => {
    expect(report([result('lint', true)])).not.toContain('FAILED:')
  })
})

/**
 * **The ordering that is not this script's to enforce, asserted where it lives.**
 *
 * `check:dist` reads every workspace's `dist/`, and `check:migrations` reads
 * `@kolonie-ai/core`'s `dist` (`#1367`). Hoisted into the tree-only phase they
 * would fail with a message about the wrong thing entirely, on a tree that is
 * fine. `check:catalogue-floor` was the third and is gone with the floor gate
 * (`#1649`, D-137).
 *
 * The gates are named in `package.json` rather than in the runner, so this is a
 * test about `package.json`, and it is the one `#1158` asks for by name.
 */
describe('the phases in package.json', () => {
  const scripts: Record<string, string> = manifest.scripts

  const positionsIn = (script: string) => {
    const parts = scripts[script].split('&&').map((part) => part.trim())
    return {
      lock: parts.findIndex((part) => part === 'npm run check:lock'),
      build: parts.findIndex((part) => part === 'npm run build'),
      tree: parts.findIndex((part) => part === 'npm run gates:tree'),
      built: parts.findIndex((part) => part === 'npm run gates:built'),
    }
  }

  it.each(['check', 'check:fast'])(
    '%s runs the tree gates, then build, then the built gates',
    (script) => {
      const { build, tree, built } = positionsIn(script)

      expect(tree).toBeGreaterThanOrEqual(0)
      expect(tree).toBeLessThan(build)
      expect(build).toBeLessThan(built)
    },
  )

  /**
   * **`check:lock` stays serial and stays first**, and is the one tree gate not
   * in the concurrent phase.
   *
   * It was the obvious sixth member — it takes 0.6s of the 27.6s this phase used
   * to spend, so folding it in buys nothing and costs the ordering
   * `check-lock.test.ts` already argues for: *"a lock file that cannot install is
   * not a tree whose formatting, types or tests mean anything."* Run
   * concurrently, drift in the lock file arrives beside five other failures that
   * are consequences of it, and the reader has to work out which one is the
   * cause. Half a second is not a reason to make a diagnosis harder.
   */
  it.each(['check', 'check:fast'])('%s checks the lock file before any of them', (script) => {
    const { lock, tree } = positionsIn(script)

    expect(lock).toBe(0)
    expect(lock).toBeLessThan(tree)
    expect(scripts['gates:tree']).not.toContain('check:lock')
  })

  it('keeps everything that reads dist in the phase after build', () => {
    expect(scripts['gates:built']).toContain('check:dist')
    expect(scripts['gates:built']).toContain('check:migrations')
    expect(scripts['gates:tree']).not.toContain('check:dist')
    expect(scripts['gates:tree']).not.toContain('check:migrations')
  })

  /**
   * **The floor gate is gone from both phases and from `package.json`
   * entirely** (`#1649`, D-137).
   *
   * Asserted rather than left to the absence of a line, because the failure it
   * guards against is silent in a way the ordering case above is not: a
   * `gates:built` that still named `check:catalogue-floor` would fail with
   * *"Missing script"*, and that reads as a typo somebody should fix rather
   * than as a gate somebody decided to remove. Reintroducing it is a maintainer
   * decision reversing D-137, not an edit to this line.
   */
  it('names no catalogue floor gate in any phase', () => {
    expect(scripts['gates:built']).not.toContain('catalogue-floor')
    expect(scripts['gates:tree']).not.toContain('catalogue-floor')
    expect(Object.keys(scripts)).not.toContain('check:catalogue-floor')
  })

  /**
   * Every gate the phases name has to exist. A typo would make `npm run` fail
   * with *"Missing script"*, which is a failure — but it is a failure that reads
   * as the gate itself being unhappy, and the check it was standing in for would
   * be gone.
   */
  it('names only scripts that exist', () => {
    const named = ['gates:tree', 'gates:built'].flatMap((phase) =>
      scripts[phase].replace('node scripts/run-gates.mjs', '').trim().split(/\s+/),
    )

    expect(named.length).toBeGreaterThanOrEqual(8)
    for (const gate of named) expect(scripts[gate]).toBeDefined()
  })

  /** `test` still comes last, and only `check` has it. */
  it('runs the suite last, and only in check', () => {
    expect(scripts['check'].trim().endsWith('npm run test')).toBe(true)
    expect(scripts['check:fast']).not.toContain('npm run test')
  })
})
