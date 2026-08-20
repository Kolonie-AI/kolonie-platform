import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Assertions about `scripts/check-catalogue-floor.mjs`, on its text.
 *
 * The runner is an entry point over `git` and a built module; driving it for
 * these two properties would mean a fake repository and a stubbed import. The
 * properties that `#1373` cares about are in the source: CI must not inherit
 * the local "no history, exit zero" fallback, and the message has to name the
 * checkout depth so the next editor does not put the silent pass back.
 */
const TEXT = readFileSync(new URL('./check-catalogue-floor.mjs', import.meta.url), 'utf8')

describe('the catalogue-floor runner in CI', () => {
  it('fails closed when GitHub Actions cannot read history', () => {
    expect(TEXT).toContain("process.env.GITHUB_ACTIONS === 'true'")
    expect(TEXT).toContain('process.exit(1)')
    expect(TEXT).toContain('--is-shallow-repository')
  })

  it('names the checkout depth the build job has to set', () => {
    expect(TEXT).toContain('fetch-depth: 0')
    expect(TEXT).toContain('#1373')
  })

  it('judges the pull request text the squash will land', () => {
    expect(TEXT).toContain('CATALOGUE_FLOOR_PR_TEXT_FILE')
    expect(TEXT).toContain('#1379')
    expect(TEXT).toContain('squash commit message')
  })

  /**
   * **The half `#1379` left out**, and it made every pull request after a raise
   * red. The runner judges *the last commit that touched the floor file*, which
   * on a merge-group branch is whatever `main` carries — so from the moment a
   * justified raise merged, every unrelated pull request behind it was judged
   * against that raise, with its own title and body, which said nothing about
   * it. Measured 2026-08-20: `#1419`'s raise landed with the words in three
   * places, and the next two pull requests went red on it through four
   * merge-group attempts each.
   *
   * The guard is one condition and this is what stops it being deleted as
   * redundant. It is asserted on the source for the reason the file's own note
   * gives: driving the runner needs a fake repository and a stubbed import, and
   * what is worth pinning here is that the condition is *written*.
   */
  it('does not re-judge a raise that has already landed on the default branch', () => {
    expect(TEXT).toContain('alreadyLanded')
    expect(TEXT).toContain("git('merge-base', '--is-ancestor', sha, 'origin/main')")
    expect(TEXT).toContain('&& !alreadyLanded')
  })

  /**
   * The same condition read from the other side: it is computed once and used
   * by both branches. Two copies is how one of them gets a fix and the other
   * keeps the bug.
   */
  it('computes that condition once, for both the judgement and the warning', () => {
    expect(TEXT.split('--is-ancestor')).toHaveLength(2)
  })
})
