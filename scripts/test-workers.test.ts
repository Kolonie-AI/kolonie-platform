import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
// @ts-expect-error — a build script, deliberately outside the TypeScript
// project, imported here for the same reason the runner beside it is: the
// arithmetic decides how much of the machine a check gets, and getting it wrong
// is not visible from the outside.
import { memoryCeiling, shareOfMachine, testWorkers, WORKER_BUDGET_VAR } from './test-workers.mjs'

/**
 * `#963`. `npm run check` had stopped carrying information when it was red: two
 * workspaces failed on contention with each other, twice in a row, on a branch
 * whose whole diff was two Markdown files.
 *
 * The cause was two independent numbers, each derived from the core count and
 * neither aware of the other — how many workspaces run at once, and how many test
 * workers each of those starts. Their product is what lands on the machine. These
 * tests pin the arithmetic that gives the product an owner.
 */
describe('one workspace’s share of the machine', () => {
  it('divides the cores between the workspaces running at once', () => {
    expect(shareOfMachine(2, 8)).toBe(4)
  })

  /**
   * The case CI is in — one workspace at a time gets the whole machine, which is
   * why CI never reproduced this and why the fix must not slow CI down.
   */
  it('gives a lone workspace all of them', () => {
    expect(shareOfMachine(1, 4)).toBe(4)
  })

  /**
   * Floor rather than round, because the point is that the shares *sum* to no
   * more than the machine. Three into eight is two each and not three each.
   */
  it('rounds down, so the shares never add up to more than there is', () => {
    expect(shareOfMachine(3, 8)).toBe(2)
  })

  /**
   * A workspace given zero workers runs no tests at all, which is a green suite
   * that tested nothing — the same class of wrong as the exit code
   * `run-workspace-script.test.ts` exists to pin.
   */
  it('never goes below one, however small the share', () => {
    expect(shareOfMachine(8, 2)).toBe(1)
    expect(shareOfMachine(0, 4)).toBe(4)
  })
})

describe('applying the budget to what a workspace wanted', () => {
  const withBudget = (budget: string) => ({ [WORKER_BUDGET_VAR]: budget })

  /**
   * **The direction that matters.** `packages/db` caps itself at six workers
   * because every worker holds a connection pool and a Postgres backend, and that
   * cap was measured against memory rather than cores. A budget must be able to
   * lower it and must never raise it: on a thirty-two-core machine an assignment
   * would hand that package eight workers and overrule the only measurement in
   * the repository that says what happens next.
   */
  it('lowers a preference to the budget', () => {
    expect(testWorkers(6, withBudget('4'))).toBe(4)
  })

  it('leaves a preference that is already below the budget alone', () => {
    expect(testWorkers(2, withBudget('4'))).toBe(2)
  })

  it('takes the budget when the workspace has no preference of its own', () => {
    expect(testWorkers(undefined, withBudget('4'))).toBe(4)
  })

  /**
   * `maxWorkers: undefined` is *unset* rather than *zero*, so a workspace with no
   * opinion keeps vitest's default. This is what makes `npx vitest run --root
   * apps/api` on its own unchanged by any of this — and that run is how a
   * contributor checks whether a red check was contention or a real failure.
   */
  it('constrains nothing when nobody is sharing the machine', () => {
    expect(testWorkers(undefined, {})).toBeUndefined()
    expect(testWorkers(6, {})).toBe(6)
  })

  /**
   * An empty string is what an exported-but-unset variable looks like, and it is
   * absence rather than a malformed number.
   */
  it('treats an empty value as no budget at all', () => {
    expect(testWorkers(6, withBudget(''))).toBe(6)
  })

  /**
   * **Refused rather than ignored.** The variable has exactly one writer, one
   * process above the reader, so a value that is not a worker count is a bug in
   * this repository. Ignoring it would restore the unbounded behaviour silently —
   * and silently unbounded is the state that cost two twelve-minute runs before
   * anybody looked at the process count. `testWorkerSlot` in `packages/db` refuses
   * a malformed slot for the same reason.
   */
  it.each([['four'], ['0'], ['-2'], ['2.5']])('refuses %s, rather than falling back', (value) => {
    expect(() => testWorkers(6, withBudget(value))).toThrow(new RegExp(WORKER_BUDGET_VAR))
  })
})

/**
 * `#1354`. `#1350` gave `apps/api` a ceiling written against cores, fixed the
 * local failure it was for, and cost CI 23 % — 471 s against 580 s, measured as
 * an A/B on two pull requests a minute apart. The constraint was always memory;
 * these tests pin the arithmetic that says so.
 */
describe('the memory ceiling on a database-backed suite', () => {
  const GiB = 1024 ** 3

  it('gives the host where the failure was measured the configuration that passed', () => {
    /**
     * 8 cores, 7186 MiB, baseline 1790 MiB resident. Four workers peaked at
     * 6405 MiB and passed all 4381 tests in 1m12s; eight failed fifteen of them
     * in 12m12s with `sys` at two and a half times `user`.
     */
    expect(memoryCeiling(7186 * 1024 ** 2)).toBe(4)
  })

  it('does not lower a CI runner that has memory to spare', () => {
    /**
     * The regression this corrects. A four-core runner is published a budget of
     * four; the core rule asked for two and won. Sixteen gigabytes has no memory
     * problem, so the preference must not be what lowers it — `testWorkers`
     * takes the smaller and the budget is meant to be the smaller one there.
     */
    expect(memoryCeiling(16 * GiB)).toBe(6)
    expect(testWorkers(memoryCeiling(16 * GiB), { KOLONIE_TEST_WORKERS: '4' })).toBe(4)
  })

  it('caps at six however much memory there is, because Postgres is the other wall', () => {
    expect(memoryCeiling(128 * GiB)).toBe(6)
  })

  it('never returns zero on a machine that could not fit one worker', () => {
    /** A refusal here would be a suite that cannot run at all. */
    expect(memoryCeiling(1 * GiB)).toBe(1)
    expect(memoryCeiling(0)).toBe(1)
  })

  it('is a preference, so the budget still only lowers it', () => {
    expect(testWorkers(memoryCeiling(7186 * 1024 ** 2), { KOLONIE_TEST_WORKERS: '2' })).toBe(2)
    expect(testWorkers(memoryCeiling(7186 * 1024 ** 2), {})).toBe(4)
  })
})

/**
 * **Which config uses which rule, and what the wrong one cost** (`#1571`).
 *
 * The helper above is well covered. What was not covered is the thing that
 * actually went wrong: `#1354` replaced the core rule with {@link memoryCeiling}
 * in `apps/api` and **left `packages/db` on it** — the workspace that matters.
 * In the `test` job of run `32504361754` (2026-08-21), `@kolonie-ai/db` was
 * **518.4 s** of 619 s, and all eight other workspaces together were 99 s.
 *
 * Measured on an idle 8-core box against a relaxed Postgres, same 212 files and
 * 4188 tests, green in every row: **437 s at two workers, 248 s at four, 205 s
 * at six.** Every pull request pays the job twice — branch and merge-queue ref.
 */
describe('the two suites that hold Postgres backends', () => {
  const configOf = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

  it.each(['../apps/api/vitest.config.ts', '../packages/db/vitest.config.ts'])(
    '%s sizes its pool from memory rather than from cores',
    (path) => {
      const text = configOf(path)

      expect(text).toContain('testWorkers(memoryCeiling())')
      expect(text).not.toContain('cpus().length - 2')
    },
  )

  /**
   * **The half that says `#1350` is not being reopened**, and the reason this is
   * a test rather than a paragraph: the argument is arithmetic, so it can be
   * checked.
   *
   * `npm run check` publishes a share of the machine — `test` concurrency first,
   * then `shareOfMachine` — and each suite takes the smaller of that and its own
   * preference. Run out on the only two machines this repository has.
   */
  describe('what packages/db ends up asking for', () => {
    const GiB = 1024 ** 3
    /** The rule `#1354` removed, here only to be compared against. */
    const byCores = (cores) => Math.max(1, Math.min(6, cores - 2))
    const budget = (cores) => shareOfMachine(Math.max(1, Math.min(4, Math.floor(cores / 4))), cores)

    it('rises from two to four on a four-core, 16 GiB runner', () => {
      // The job's own log for that run says `up to 4 test workers each`.
      expect(budget(4)).toBe(4)
      expect(Math.min(byCores(4), budget(4))).toBe(2)
      expect(Math.min(memoryCeiling(16 * GiB), budget(4))).toBe(4)
    })

    it('does not move on the 8-core, 7.2 GiB host where the thrash was measured', () => {
      // Both rules give the same answer there, so the change cannot reopen
      // `#1350` — 5.5 GiB of 7.2 and the first touch of swap.
      expect(Math.min(byCores(8), budget(8))).toBe(4)
      expect(Math.min(memoryCeiling(7186 * 1024 ** 2), budget(8))).toBe(4)
    })
  })
})
