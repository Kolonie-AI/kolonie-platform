import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Assertions about `.github/workflows/mcp-surface.yml`, on its text (`#1566`).
 *
 * **No YAML parser, for the reason `ci-workflow.test.ts` gives at length**: the
 * repository has neither `yaml` nor `js-yaml`, and most of what matters here is
 * a fact about a string anyway — that a `git push` does *not* name a protected
 * ref is not something a parser makes easier to see.
 *
 * ## The failure this file is named after
 *
 * The floor job pushed straight to `main`. When the merge-queue ruleset went on
 * (2026-08-20) the push started being refused with `GH013`, and the job failed on
 * **every push to `main` since 07:00 on 2026-08-21** — ten consecutive merges,
 * with nobody watching, because until that day it had always worked.
 *
 * The floor then read 121 while the served catalogue had 123, and because the
 * floor is a **required** check a stale figure fails every merge-group build
 * whatever the queued pull request does. `#1561` entered the queue five times,
 * was evicted four, and spent ninety minutes failing on two tools somebody else
 * had added. A job that could not write its own output took the whole queue down
 * with it.
 *
 * So this file exists to make the two properties that failure needed — a push to
 * a protected branch, and a silent failure — assertions rather than habits.
 */
const TEXT = readFileSync(new URL('../.github/workflows/mcp-surface.yml', import.meta.url), 'utf8')

/** Every `git push` in the file, with whatever it pushes to. */
const pushes = (): string[] =>
  [...TEXT.matchAll(/^\s*(?:if !\s*)?git push[^\n]*/gm)].map((match) => match[0].trim())

describe('how the measured floor reaches main', () => {
  it('pushes somewhere, so a wrong regex cannot make this vacuously true', () => {
    expect(pushes().length).toBeGreaterThan(0)
  })

  /**
   * **The criterion `#1566` leads with.** `main` is behind the queue and a job
   * cannot be given permission to bypass it — the API refuses the built-in
   * Actions app as a bypass actor, verified 2026-08-21 — so the route had to
   * change rather than the permission.
   */
  it('never pushes to a protected branch', () => {
    for (const push of pushes()) {
      expect(push, push).not.toContain('HEAD:main')
      expect(push, push).not.toContain('github.ref_name')
      // Every push names the one branch, through the variable the step binds.
      expect(push, push).toContain('${BRANCH}')
    }
  })

  /** And the variable is the automation branch, not something that resolves to
   * `main` on a push to `main` — which is what `github.ref_name` did. */
  it('binds that branch to a name of its own', () => {
    expect(TEXT).toMatch(/^\s+BRANCH: automation\/catalogue-floor$/m)
  })

  /**
   * One branch, force-updated. Ten merges in a morning are one pull request and
   * one figure — the branch carries a measurement rather than a history, so the
   * older commit is worth nothing once a newer one exists.
   */
  it('reuses one open pull request rather than opening one per merge', () => {
    expect(TEXT).toContain('gh pr list --head "${BRANCH}" --state open')
    expect(TEXT).toContain('gh pr create --head "${BRANCH}"')
    expect(TEXT).toMatch(/gh api -X PATCH "repos\/\$\{GITHUB_REPOSITORY\}\/pulls\/\$\{NUMBER\}"/)
  })

  /**
   * **A pull request opened with `GITHUB_TOKEN` creates no workflow runs** —
   * GitHub's own loop guard — so the required check would never report and the
   * queue could never take the entry. `workflow_dispatch` is the documented
   * exception, and `#1171` put the trigger on `ci.yml` for this shape of problem.
   *
   * Without this line the whole arrangement is a pull request that sits for ever,
   * which is a quieter version of the failure it replaces.
   */
  it('starts CI on the floor branch itself, because nothing else will', () => {
    expect(TEXT).toContain('gh workflow run ci.yml --ref "${BRANCH}"')
    expect(TEXT).toMatch(/^\s+actions: write$/m)
  })

  /** A lowering still lands without anybody asking, and so does a justified raise. */
  it('arms auto-merge rather than waiting for a person', () => {
    expect(TEXT).toContain('gh pr merge "${NUMBER}" --auto')
  })

  /**
   * **The failure was invisible for eleven hours**, which is half of what made it
   * expensive. Every way this job can fail to land the figure now writes an
   * `::error::` and exits non-zero.
   */
  it('fails loudly on every path where the figure does not land', () => {
    const errors = [...TEXT.matchAll(/::error::[^\n"]*/g)].map((match) => match[0])

    expect(errors.length).toBeGreaterThanOrEqual(4)
    expect(errors.join('\n')).toContain('the floor cannot be landed')
    expect(errors.join('\n')).toContain('will not go green by itself')
  })

  /**
   * The one refusal to survive rather than report: a branch already in the queue
   * cannot be force-pushed (`GH006`). The version that is queued is about to
   * land, and the run after it re-measures — so this is a notice, not an error.
   */
  it('treats a queued floor branch as an ordinary outcome', () => {
    expect(TEXT).toContain("grep -q 'queued for merging'")
    expect(TEXT).toContain('::notice::')
  })

  /**
   * **The `#1317` trap, one step along.** `check:catalogue-floor` judges the last
   * commit to touch the floor file; the queue squashes, so the message that ends
   * up on `main` is the pull request's title and body. The landing message has to
   * be in both, or the floor commit refuses itself on the next run with no honest
   * edit available to clear it.
   */
  it('quotes the landing message into the body as well as the commit', () => {
    expect(TEXT).toContain('LANDED="$(git log -1 --pretty=%B HEAD)"')
    expect(TEXT).toMatch(/git commit -m "\$SUBJECT" -m "\$REASON" -m "\$LANDED"/)
    expect(TEXT).toMatch(/BODY="\$\(printf[\s\S]{0,600}"\$LANDED"/)
  })
})
