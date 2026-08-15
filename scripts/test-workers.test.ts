import { describe, expect, it } from 'vitest'
// @ts-expect-error — a build script, deliberately outside the TypeScript
// project, imported here for the same reason the runner beside it is: the
// arithmetic decides how much of the machine a check gets, and getting it wrong
// is not visible from the outside.
import { shareOfMachine, testWorkers, WORKER_BUDGET_VAR } from './test-workers.mjs'

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
