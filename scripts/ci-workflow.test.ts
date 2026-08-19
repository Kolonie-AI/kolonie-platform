import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Assertions about `.github/workflows/ci.yml`, on its text.
 *
 * **No YAML parser, deliberately.** The repository has neither `yaml` nor
 * `js-yaml` installed, and `scripts/github-issue-labels.test.ts` already reads
 * workflow files this way. Adding a dependency so that a handful of assertions
 * can be written as property lookups is a poor trade — and half of what matters
 * here is not structure anyway. That the cache key *names* `tsconfig.base.json`
 * is a fact about a string, and a parser would not make it easier to see.
 */
const TEXT = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')

/** The blocks under `jobs:`, keyed by the job id. Job ids are the only keys at
 * two-space indentation, so this needs no more than a regular expression. */
function jobs(): Map<string, string> {
  const body = TEXT.slice(TEXT.indexOf('\njobs:\n'))
  const found = new Map<string, string>()
  const starts = [...body.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)]

  starts.forEach((start, index) => {
    const from = start.index ?? 0
    const to = starts[index + 1]?.index ?? body.length
    found.set(start[1]!, body.slice(from, to))
  })

  return found
}

/** The `name:` a job renders as on a pull request, which is not its id. */
function displayName(job: string): string | undefined {
  return jobs()
    .get(job)
    ?.match(/^ {4}name: (.+)$/m)?.[1]
}

describe('the jobs the split produced', () => {
  it('has the four the decision names, and no others', () => {
    expect([...jobs().keys()]).toEqual(['tree', 'build', 'test', 'check'])
  })

  /**
   * The point of the split. `tree` and `build` can tell each other nothing — a
   * formatting error does not stop a compile and a type error does not stop a
   * lint — so making either wait costs the whole reason the other is separate.
   */
  it('starts tree and build together, waiting on nothing', () => {
    expect(jobs().get('tree')).not.toMatch(/^ {4}needs:/m)
    expect(jobs().get('build')).not.toMatch(/^ {4}needs:/m)
  })

  /** So a change that does not compile costs three minutes, not seventeen. */
  it('makes the long job wait for the compiler', () => {
    expect(jobs().get('test')).toMatch(/^ {4}needs: build$/m)
  })

  /**
   * **`test` generates the storage barrel itself, and skips the build** (`#1159`).
   *
   * `packages/db/src/storage/index.ts` is generated and git-ignored, and since
   * `#1156` the suite resolves `@kolonie-ai/db` to source — so the file the
   * generator writes is the file the tests import. Root `build` runs the
   * generator before `tsc -b`, which is how this was covered before the split;
   * the first run of the split proved it was not covered after, taking db, api
   * and moderation-runner down with `ERR_MODULE_NOT_FOUND` on a tree that
   * compiles.
   *
   * The second half is the half a later editor is likely to get wrong: reaching
   * for `npm run build` here fixes the same symptom and costs the entire point of
   * `#1156`, so this pins the generator alone.
   */
  it('generates the storage barrel in the test job without building', () => {
    const block = jobs().get('test') ?? ''

    expect(block).toContain('run: npm run barrel')
    expect(block).not.toContain('run: npm run build')
  })
})

/**
 * **The name is a setting in the repository, not a string in this file.**
 *
 * `main`'s branch protection requires a check called exactly
 * *"format, lint, build, typecheck, test"*. Rename this job and the protection
 * waits forever on a check nobody will report, which GitHub renders as *pending*
 * — indistinguishable, on a repository whose pull requests merge on green, from
 * a run that has not finished yet.
 *
 * This test is here to be read by whoever is about to do that, more than to
 * catch them.
 */
describe('the required check', () => {
  const PROTECTED = 'format, lint, build, typecheck, test'

  it('is carried by the summary job under its exact name', () => {
    expect(displayName('check')).toBe(PROTECTED)
  })

  it('is carried by exactly one job', () => {
    const carrying = [...jobs().keys()].filter((job) => displayName(job) === PROTECTED)

    expect(carrying).toEqual(['check'])
  })

  it('waits for all three', () => {
    expect(jobs().get('check')).toMatch(/^ {4}needs: \[tree, build, test\]$/m)
  })

  /**
   * A job that is skipped is not a job that passed. Without `always()` a failing
   * `build` skips `test`, skips this, and leaves the required check neither green
   * nor red — which is the failure this whole arrangement was meant to avoid.
   */
  it('runs even when something upstream failed', () => {
    expect(jobs().get('check')).toMatch(/^ {4}if: always\(\)$/m)
  })

  it('treats anything short of success as failure', () => {
    const block = jobs().get('check') ?? ''

    expect(block).toContain('if [ "$result" != "success" ]')
    expect(block).toContain('FAILED: ${name}')
    expect(block).toContain('exit $fail')
  })
})

describe('the incremental build cache', () => {
  const block = () => jobs().get('build') ?? ''
  /** The `path:` list on its own — the prose above it argues about globs and
   * would otherwise answer the question the glob assertion is asking. */
  const paths = () => block().match(/^ {10}path: \|\n((?: {12}.+\n)+)/m)?.[1] ?? ''

  /**
   * **The correctness argument for the whole cache**, and the reason the narrow
   * reading of `#1159` — cache the state file — is the one arrangement that is
   * unsafe. `tsc -b` decides what to rebuild from `.tsbuildinfo` and never looks
   * at the outputs, so a restored state file without the files it describes makes
   * the compiler skip every project, emit nothing and exit zero.
   */
  it('caches the outputs together with the state that describes them', () => {
    expect(paths()).toContain('packages/*/dist')
    expect(paths()).toContain('apps/*/dist')
    expect(paths()).toContain('packages/*/*.tsbuildinfo')
    expect(paths()).toContain('apps/*/*.tsbuildinfo')
  })

  // A double-star glob would sweep every `dist/` under `node_modules` into the
  // archive — which is both enormous and wrong, since `npm ci` puts them there.
  it('names the paths rather than globbing the tree', () => {
    expect(paths()).not.toContain('**/')
  })

  /** The rejection case `#1159` asks for by name: a change here rebuilds from
   * nothing, because it misses the prefix `restore-keys` falls back within. */
  it('invalidates on a change to the root TypeScript configuration', () => {
    const key = block().match(/^ {10}key: (.+)$/m)?.[1] ?? ''

    expect(key).toContain('tsconfig.base.json')
    expect(key).toContain('package-lock.json')
    expect(key).toContain('packages/*/tsconfig*.json')
    expect(key).toContain('apps/*/tsconfig*.json')
  })

  /** Otherwise every commit on a branch would restore, build, and race the next
   * one to overwrite a single entry. */
  it('gives each commit its own entry and falls back within the same inputs', () => {
    expect(block()).toMatch(
      /^ {10}key: build-\$\{\{ hashFiles\(.+\) \}\}-\$\{\{ github\.sha \}\}$/m,
    )
    expect(block()).toMatch(/^ {12}build-\$\{\{ hashFiles\(.+\) \}\}-$/m)
  })
})

describe('what the split was not allowed to change', () => {
  /**
   * Measured on 2026-08-02: `98a4687` and `0e70dc2` were cancelled on `main` by a
   * commit pushed behind them, and a cancelled run reads as red. The condition
   * that fixed it is an acceptance criterion of `#1159` in its own right.
   */
  it('still cancels superseded runs on branches and never on main', () => {
    expect(TEXT).toMatch(/github\.ref != 'refs\/heads\/main'/)
  })

  /**
   * **A queue entry is not a stale branch tip.** `refs/heads/gh-readonly-queue/…`
   * is not `main`, so the condition above alone would read it as superseded — and
   * a cancelled entry is a *dequeued* entry, so that would not merely lose an
   * answer, it would stop the queue. Each entry is a distinct merge result whose
   * verdict is the only one it will ever get, which is the argument `#1159` made
   * for `main` word for word.
   */
  it('never cancels a merge queue entry', () => {
    expect(TEXT).toMatch(/!startsWith\(github\.ref,\s*\n?\s*'refs\/heads\/gh-readonly-queue\/'\)/)
  })

  /**
   * **The queue cannot be turned on without this** (`#1308`). A queued pull
   * request is built onto a queue ref and GitHub waits for the *required*
   * context on it; this workflow is the only thing that produces
   * `format, lint, build, typecheck, test`, so without the trigger every entry
   * would sit until it timed out and be dequeued. Merging would stop, quietly,
   * on a repository whose checks all look green.
   */
  it('runs for a merge group, which is what makes the queue answer #1308', () => {
    expect(TEXT).toMatch(/^ {2}merge_group:$/m)
  })

  /** `#971`: a `branches:` filter under `pull_request:` gave stacked pull requests
   * zero check-runs, which on a repository that merges on green is a pull request
   * that cannot land. The one filter left in the file is the one on `push`. */
  it('still runs for a pull request against any base', () => {
    expect([...TEXT.matchAll(/^ *branches:/gm)]).toHaveLength(1)
    expect(TEXT).toMatch(/^ {2}push:\n {4}branches: \[main\]$/m)
  })

  /** `#1171`. Without it a branch whose first run was cancelled has no way back
   * to a check-run except an empty commit. */
  it('can still be started by hand', () => {
    expect(TEXT).toContain('workflow_dispatch:')
  })

  /** Both processes refuse to start without them (D-009), so a job missing either
   * fails every file rather than skipping quietly. */
  it('keeps a database and its two required literals wherever a process boots', () => {
    for (const job of ['build', 'test']) {
      const block = jobs().get(job) ?? ''

      expect(block).toContain('image: postgres:16')
      expect(block).toContain('DATABASE_URL:')
      expect(block).toContain('BAN_MARK_SALT:')
      expect(block).toContain('DEPOSIT_SEALING_KEY:')
    }
  })
})

/**
 * **CI and `npm run check` have to stay the same set of gates.** AGENTS.md §9
 * promises that a green local run means a green CI run, and the split is exactly
 * the sort of change that quietly breaks it: a phase dropped here is a phase
 * nobody notices is missing until something it would have caught reaches `main`.
 *
 * The phases are named rather than their contents, because that is the seam
 * `#1158` built — adding a gate to `gates:tree` should not require editing a
 * workflow.
 */
describe('the same gates as the command contributors run', () => {
  const script = (
    JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>
    }
  ).scripts['check']!

  it.each(['check:lock', 'gates:tree', 'build', 'gates:built', 'test'])(
    'runs npm run %s somewhere',
    (phase) => {
      expect(script).toContain(`npm run ${phase}`)
      expect(TEXT).toContain(`run: npm run ${phase}`)
    },
  )

  /** The one thing CI does that `check` does not: prove the built artefacts are
   * usable, rather than merely present. */
  it('still boots the built API against a real socket', () => {
    const block = jobs().get('build') ?? ''

    expect(block).toContain('node apps/api/dist/server.js &')
    expect(block).toContain('http://127.0.0.1:3000/health')
  })
})

/**
 * **The catalogue-floor ratchet cannot fail on a depth-1 checkout** (`#1373`).
 *
 * `check:catalogue-floor` lives in `gates:built`, which only the `build` job
 * runs. The script's local fallback — report what it could not read and exit
 * zero — is right for an export and was the whole of every CI run, because
 * `actions/checkout@v7` defaults to `fetch-depth: 1`. Full history here is the
 * half that lets the guard see the last commit that touched the floor file;
 * failing closed when `GITHUB_ACTIONS` is set and the clone is still shallow is
 * the other half, in the script itself.
 */
describe('the catalogue-floor job can read history', () => {
  it('fetches full history in the job that runs the floor check', () => {
    const block = jobs().get('build') ?? ''

    expect(block).toContain('run: npm run gates:built')
    expect(block).toContain('uses: actions/checkout@v7')
    expect(block).toMatch(/fetch-depth: 0/)
  })

  it('does not spend a full clone on jobs that never read git history', () => {
    expect(jobs().get('tree')).not.toContain('fetch-depth:')
    expect(jobs().get('test')).not.toContain('fetch-depth:')
  })
})
