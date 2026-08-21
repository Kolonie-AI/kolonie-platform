import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Assertions about `.github/workflows/red-on-main.yml`, on its text.
 *
 * The quoted failure block is what an agent reads to decide *is this failure
 * mine*. ANSI from vitest and `gh run view --log-failed`'s job/timestamp
 * prefix make it look like a corrupted paste (`#1362`).
 */
const TEXT = readFileSync(new URL('../.github/workflows/red-on-main.yml', import.meta.url), 'utf8')

describe('the quoted failure in red-on-main', () => {
  it('strips ANSI before the assertion is copied into the issue', () => {
    expect(TEXT).toContain('\\x1b')
    expect(TEXT).toContain('#1362')
  })

  it('only strips the job/timestamp prefix where the line has that shape', () => {
    expect(TEXT).toContain('[^\\t]*\\t[^\\t]*\\t[0-9T:.Z-]+')
  })
})

/**
 * **What this watcher covers, and why it is more than CI** (`#1564`, `#1566`).
 *
 * `MCP surface` commits the catalogue floor. When the merge queue went on it lost
 * its route to `main` and failed on ten consecutive merges, and because the floor
 * is a *required* check a stale figure then evicted queued pull requests that had
 * touched nothing under `apps/api/src/mcp/`. Nobody was told: the only symptom
 * anywhere a person looks was somebody else's branch being refused for something
 * it did not do.
 *
 * The rule: a workflow on `main` that gates other people's branches has to reach
 * somebody when it stops.
 */
describe('which workflows on main reach somebody', () => {
  it('reads more than CI', () => {
    expect(TEXT).toContain('workflows: [CI, MCP surface]')
  })

  /**
   * **The trap this arrangement walks into if the marker is shared**, and the
   * reason it is computed rather than fixed. Both workflows run on the same
   * push. One marker would let CI's `success` close an issue `MCP surface`'s
   * `failure` had just opened — *treating an absence of evidence as green*,
   * which is the exact defect `#1308` rewrote this file to remove, arriving one
   * level up.
   */
  it('keeps one standing issue per workflow', () => {
    expect(TEXT).toContain('watch-finding: main-workflow-red:${slug}')
    expect(TEXT).toMatch(/MARKER=.*>> "\$GITHUB_ENV"/)
  })

  /**
   * CI keeps the marker it has had since `#1280`, so the standing issue that is
   * open at the moment this lands is adopted rather than orphaned — a renamed
   * marker would leave a red `main` filed under a name nothing looks for, and
   * file a second issue beside it.
   */
  it('leaves CI’s own marker exactly where it was', () => {
    expect(TEXT).toContain('MARKER=<!-- watch-finding: main-is-red -->')
  })

  /** A finding about another workflow must not claim `main` is red — CI may be
   * perfectly green, and a title that overstates is one a reader learns to skip. */
  it('does not call another workflow’s failure a red tip', () => {
    expect(TEXT).toContain('is failing on main')
    expect(TEXT).toContain('steps.run.outputs.isCI')
  })
})
