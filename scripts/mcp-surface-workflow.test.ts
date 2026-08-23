import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Assertions about `.github/workflows/mcp-surface.yml`, on its text (`#1566`).
 *
 * **No YAML parser, for the reason `ci-workflow.test.ts` gives at length**: the
 * repository has neither `yaml` nor `js-yaml`, and most of what matters here is
 * a fact about a string anyway — that a workflow contains no `git push` at all
 * is not something a parser makes easier to see.
 *
 * ## What this file used to be for, and what it is for now
 *
 * It was written after the floor job pushed straight to `main`, was refused by
 * the merge-queue ruleset with `GH013`, and failed on **every push to `main`
 * since 07:00 on 2026-08-21** — ten consecutive merges, with nobody watching.
 * The floor then read 121 against a served catalogue of 123, and because the
 * floor was a **required** check a stale figure failed every merge-group build
 * whatever the queued pull request did: `#1561` entered the queue five times,
 * was evicted four, and spent ninety minutes failing on two tools somebody else
 * had added.
 *
 * **The floor is gone** (`#1649`, D-137). It raised itself on every merge, so it
 * recorded growth and never held it — and the machinery above is what it cost to
 * record. Every assertion here is therefore an absence, and that is the point:
 * this workflow measures and reports and can fail nothing, and the way to change
 * that is a maintainer decision reversing D-137 rather than an edit to this file.
 *
 * Reintroducing a gate would break these cases, which is what makes them worth
 * more than the sentence in the workflow's own header — a sentence can be
 * deleted in the same commit that contradicts it.
 */
const TEXT = readFileSync(new URL('../.github/workflows/mcp-surface.yml', import.meta.url), 'utf8')

/**
 * The same file with every comment line dropped.
 *
 * **The assertions below are about what this workflow does, and a comment is
 * what it says.** The header explains at length what the floor was and why it
 * went, so it names `automation/catalogue-floor` and `gh workflow run` — and a
 * check reading the raw text would fail on the account of the removal rather
 * than on the removal. Deleting the mechanism and the record of it would be
 * keeping neither.
 *
 * A `#` inside a `run: |` block is a shell comment and goes too, which is
 * correct for the same reason.
 */
const CODE = TEXT.split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n')

/** The steps' `name:` lines, which is where a verdict would announce itself. */
const stepNames = (): string[] =>
  [...CODE.matchAll(/^\s+- name: (.+)$/gm)].map((match) => match[1].trim())

describe('the surface workflow writes nothing', () => {
  it('names some steps, so a wrong regex cannot make this vacuously true', () => {
    expect(stepNames().length).toBeGreaterThan(0)
  })

  /**
   * **No push, to any ref.** The floor branch, the force-update, the queue-age
   * guard and the `GH006` carve-out were all machinery for landing a number
   * nobody typed. With no number to land there is nothing to push, and the
   * cheapest way to keep it that way is to assert the verb is absent rather than
   * to assert each of its guards is still correct.
   */
  it('contains no git push at all', () => {
    expect(CODE).not.toMatch(/\bgit push\b/)
    expect(CODE).not.toContain('automation/catalogue-floor')
    expect(CODE).not.toContain('FLOOR_BOT_TOKEN')
  })

  /** No commit either, and no branch to carry one. */
  it('commits nothing to any branch', () => {
    expect(CODE).not.toMatch(/\bgit commit\b/)
    expect(CODE).not.toMatch(/\bgit config user\./)
  })

  /**
   * **It opens no pull request and dispatches no workflow.** Both existed to get
   * a verdict onto a figure the workflow had written itself; `#1587` measured
   * that the dispatched run does not even satisfy a required check.
   */
  it('opens no pull request and starts no other workflow', () => {
    expect(CODE).not.toContain('gh pr create')
    expect(CODE).not.toContain('gh pr merge')
    expect(CODE).not.toContain('gh workflow run')
  })

  /**
   * **The token can do exactly one thing: leave a comment.** `contents: write`
   * and `actions: write` were the floor's, and a job that cannot write contents
   * cannot quietly regrow a branch that carries a number.
   */
  it('asks for no permission beyond the comment it leaves', () => {
    expect(CODE).toMatch(/^\s+contents: read$/m)
    expect(CODE).toMatch(/^\s+pull-requests: write$/m)
    expect(CODE).not.toMatch(/^\s+contents: write$/m)
    expect(CODE).not.toMatch(/^\s+actions: write$/m)
  })
})

describe('the surface workflow fails nothing', () => {
  /**
   * **No step exits non-zero on a figure.** `Fail the run when the catalogue
   * grew past its gate` was the whole of the gate as far as a merge was
   * concerned: everything before it computed a verdict and everything after it
   * carried one. A workflow with no `exit 1` in it cannot turn a pull request
   * red however large the catalogue gets.
   */
  it('has no step that exits non-zero', () => {
    expect(CODE).not.toMatch(/\bexit 1\b/)
    expect(CODE).not.toContain('::error::')
  })

  /** And nothing computes a verdict for such a step to read. */
  it('imports no budget rule and reads no floor file', () => {
    expect(CODE).not.toContain('catalogue-budget')
    expect(CODE).not.toContain('mainFloorRatchet')
    expect(CODE).not.toContain('branchBudgetVerdict')
  })

  /**
   * The two jobs that remain, by the names branch protection may still know them
   * by. Renaming one is a separate decision from removing the gate, and doing it
   * accidentally in this change would strand a required check reading *Expected*
   * for ever — the `#1587` failure, from the other end.
   */
  it('still weighs the surface and still reports the change', () => {
    expect(CODE).toMatch(/^\s+name: Weigh the surface$/m)
    expect(CODE).toMatch(/^\s+name: Report the change$/m)
    expect(CODE).toContain('node scripts/measure-mcp-surface.mjs')
    expect(CODE).toContain('gh pr comment "$PR" --body-file surface-report.md')
  })

  /**
   * **The queue trigger stays.** It was added because a gate that does not run
   * on `gh-readonly-queue/…` reports nothing and the entry is evicted at
   * `check_response_timeout_minutes` (issue 1379). Whether any of these jobs is
   * still named in branch protection is not readable from this repository, so
   * removing the trigger is a way to stop the queue by accident.
   */
  it('still answers on all three events', () => {
    expect(CODE).toMatch(/^\s+push:$/m)
    expect(CODE).toMatch(/^\s+pull_request:$/m)
    expect(CODE).toMatch(/^\s+merge_group:$/m)
  })
})
