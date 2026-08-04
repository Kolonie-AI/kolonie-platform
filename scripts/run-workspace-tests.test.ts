import { describe, expect, it } from 'vitest'
// @ts-expect-error — the runner is a build script, deliberately outside the
// TypeScript project. Imported here because the sentence it uses to decide the
// exit code is the one thing about it that must never be wrong.
import { verdictFrom } from './run-workspace-tests.mjs'

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
