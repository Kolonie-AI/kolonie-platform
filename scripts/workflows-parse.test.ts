import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * **Every workflow file is a file GitHub can read** (`#1379`).
 *
 * ## The failure this exists for
 *
 * A conflict marker was committed into `.github/workflows/ci.yml` on a branch —
 * a `git add -A` in front of a scripted `rebase --continue`, which is how a
 * conflict becomes a commit without anybody reading it. Everything downstream
 * stayed green: `format:check` does not parse YAML, `lint` does not read this
 * directory, and the suite had no assertion that a workflow is loadable at all.
 * `ci-workflow.test.ts` reads the file as **text** and its regexes matched the
 * surviving halves of the conflict quite happily.
 *
 * What GitHub does with an unparseable workflow is the part worth knowing: it
 * does not fail the run, because there is no run. The workflow simply has no
 * triggers, so **no CI is created for that branch at all** — and a pull request
 * with zero check-runs renders as *waiting for a check*, which is what `#971`
 * already records as indistinguishable from a check that has not finished. The
 * only visible symptom was `gh workflow run` answering *"Workflow does not have
 * 'workflow_dispatch' trigger"* about a file that plainly has one.
 *
 * ## Why the parser is written here rather than installed
 *
 * The repository has neither `yaml` nor `js-yaml`, and `ci-workflow.test.ts`
 * argues at length for not adding one: half of what it asserts is about strings.
 * That argument holds and this is not a counter-example — **what is needed here
 * is not a parse, it is the absence of the four markers `git` writes.** A merge
 * conflict is the only way this file has ever been broken, the markers are
 * unambiguous at the start of a line, and a check that names the marker tells a
 * reader more than a parser error pointing at column 7 of line 306.
 */
const WORKFLOWS = new URL('../.github/workflows/', import.meta.url)

const files = readdirSync(WORKFLOWS).filter(
  (name) => name.endsWith('.yml') || name.endsWith('.yaml'),
)

/** `git`'s own four, anchored: prose may contain any of these mid-line. */
const MARKERS = [/^<<<<<<< /m, /^\|\|\|\|\|\|\| /m, /^=======$/m, /^>>>>>>> /m]

describe('the workflow files', () => {
  it('finds some, so a wrong path cannot make this vacuously true', () => {
    expect(files.length).toBeGreaterThan(5)
  })

  it.each(files)('%s carries no conflict marker', (name) => {
    const text = readFileSync(new URL(name, WORKFLOWS), 'utf8')

    for (const marker of MARKERS) {
      expect(marker.test(text), `${name} carries ${String(marker)}`).toBe(false)
    }
  })

  /**
   * The one structural fact worth asserting without a parser: a workflow that
   * lost its `on:` block has no triggers and produces no runs, which is the same
   * silence an unparseable file produces.
   */
  it.each(files)('%s declares when it runs', (name) => {
    expect(readFileSync(new URL(name, WORKFLOWS), 'utf8')).toMatch(/^on:$/m)
  })
})
