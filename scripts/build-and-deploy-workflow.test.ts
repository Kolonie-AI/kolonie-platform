import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Assertions about `.github/workflows/build-and-deploy.yml`, on its text, in the
 * shape `ci-workflow.test.ts` argues for: the repository installs no YAML
 * parser, and what matters here is largely which strings a step is given.
 *
 * **What these cover is `#1790`**: a commit-keyed smoke finding that a later
 * green deploy has cleared must be closed by the workflow that holds the
 * evidence, and must not be closed by anything weaker.
 */
const TEXT = readFileSync(
  new URL('../.github/workflows/build-and-deploy.yml', import.meta.url),
  'utf8',
)

/** The step blocks of the `smoke` job, keyed by their `name:`. */
function smokeSteps(): Map<string, string> {
  const job = TEXT.slice(TEXT.indexOf('\n  smoke:\n') + 1)
  const next = /^ {2}[a-z][a-z0-9-]*:$/m.exec(job.slice(1))
  const body = next === null ? job : job.slice(0, next.index + 1)
  const found = new Map<string, string>()
  const starts = [...body.matchAll(/^ {6}- name: (.+)$/gm)]

  starts.forEach((start, index) => {
    const from = start.index ?? 0
    const to = starts[index + 1]?.index ?? body.length
    found.set(start[1]!, body.slice(from, to))
  })

  return found
}

describe('the finding a red smoke files', () => {
  /**
   * A settlement that cannot name the run that filed the finding sends a reader
   * looking for evidence nobody kept, so the filing run is recorded on the
   * issue as it is filed.
   */
  it('records the run that filed it', () => {
    const step = [...smokeSteps().values()].join('\n')

    expect(step).toContain('--run-url')
  })
})

describe('settling an earlier revision’s finding', () => {
  const step = (): string => {
    const found = [...smokeSteps().entries()].find(([name]) => /settle/i.test(name))
    expect(found, 'the smoke job has a settlement step').toBeDefined()
    return found![1]
  }

  /**
   * **Both halves of the evidence, and no third.** `/health` says a process is
   * listening, which was true throughout `#1789`; only a green MCP smoke says
   * the surface a citizen speaks to answers. So the step runs when the deploy
   * job succeeded and this job's own smoke step succeeded, and at no other time.
   */
  it('runs only when the deploy succeeded and the smoke succeeded', () => {
    expect(step()).toMatch(/if:.*needs\.deploy\.result == 'success'/s)
    expect(step()).toMatch(/steps\.smoke\.outcome == 'success'/)
  })

  it('never settles on health alone', () => {
    expect(step()).not.toMatch(/\/health/)
  })

  it('runs the settlement driver rather than deciding in shell', () => {
    expect(step()).toContain('scripts/settle-smoke-findings.mjs')
  })

  /** Nothing here reverts, re-runs or suppresses anything (`#1790` non-goals). */
  it('rolls nothing back and re-runs nothing', () => {
    const whole = TEXT
    expect(whole).not.toContain('gh run rerun')
    expect(whole).not.toContain('deploy-set.sh rollback')
    expect(step()).not.toContain('gh issue reopen')
  })
})

/**
 * **The rehearsal has to be able to prove the comment without writing** — the
 * criterion `#1790` states, and the reason the driver takes `--dry-run`.
 */
describe('the settlement driver', () => {
  const DRIVER = readFileSync(new URL('./settle-smoke-findings.mjs', import.meta.url), 'utf8')

  it('renders the comment and writes nothing under --dry-run', () => {
    expect(DRIVER).toContain('--dry-run')
    expect(DRIVER).toMatch(/if \(dryRun\)[\s\S]*continue/)
  })

  /** Comment first, close second: a finding never ends without saying why. */
  it('comments before it closes', () => {
    const comment = DRIVER.indexOf("'comment'")
    const close = DRIVER.indexOf("'close'")
    expect(comment).toBeGreaterThan(-1)
    expect(close).toBeGreaterThan(comment)
  })

  /** The decision is the tested function, not a second copy in this driver. */
  it('takes its verdict from smokeFindingsToSettle', () => {
    expect(DRIVER).toContain('smokeFindingsToSettle')
    expect(DRIVER).toContain('smokeSettlementComment')
  })

  it('reopens nothing and rolls nothing back', () => {
    expect(DRIVER).not.toContain('issue reopen')
    expect(DRIVER).not.toContain('rollback')
  })
})
