import { describe, expect, it } from 'vitest'
// @ts-expect-error — a build script, deliberately outside the TypeScript project,
// like the workspace runner beside it.
import { argumentsFor, cacheKeyFor, exitCodeFrom, installedVersion, TOOLS } from './cached-lint.mjs'

/**
 * `#304`. Caching the two checks that read every file takes 30 seconds off a warm
 * `npm run check`, and introduces exactly one way to be wrong: **answering green
 * about a file that was never looked at**.
 *
 * Both tools key their own cache on file contents, so an edited file is always
 * re-read and is not the hazard. The hazard is configuration — ESLint's cache is
 * not invalidated by a change to `eslint.config.js` — and the answer here is a
 * cache file per configuration rather than an invalidation step somebody has to
 * remember. What follows asserts that property directly, because the alternative
 * is running a linter twice and believing the second answer.
 */
describe('a cache that cannot outlive its configuration', () => {
  const versions = ['eslint@10.8.0']

  it('gives the same configuration the same cache', () => {
    expect(cacheKeyFor(['rules'], versions)).toBe(cacheKeyFor(['rules'], versions))
  })

  /** The case the whole arrangement exists for: a rule added today. */
  it('gives a changed config file a different cache', () => {
    expect(cacheKeyFor(['rules'], versions)).not.toBe(
      cacheKeyFor(['rules, and one more'], versions),
    )
  })

  /**
   * A tool that changed its mind about what a pass is has changed what a pass is.
   * The version is read from `node_modules` rather than from a range in
   * `package.json`, because a range is not what ran.
   */
  it('gives a different tool version a different cache', () => {
    expect(cacheKeyFor(['rules'], ['eslint@10.8.0'])).not.toBe(
      cacheKeyFor(['rules'], ['eslint@10.9.0']),
    )
  })

  /**
   * Deleting `.prettierignore` changes which files are checked, so it must not
   * address the cache written while it existed. `absent` is a value rather than an
   * error for exactly that reason.
   */
  it('treats a config file that is gone as a different configuration', () => {
    expect(cacheKeyFor(['ignored paths'], versions)).not.toBe(cacheKeyFor(['absent'], versions))
  })

  it('does not confuse two inputs whose contents are swapped', () => {
    // A digest that concatenated without a separator would call these equal, and
    // the day it mattered would be a config change that appeared to be none.
    expect(cacheKeyFor(['ab', 'c'], versions)).not.toBe(cacheKeyFor(['a', 'bc'], versions))
  })

  it('reports a package that is not installed rather than throwing', async () => {
    expect(await installedVersion('not-a-real-package')).toBe('not-a-real-package@absent')
  })

  it('reads the version that is actually installed', async () => {
    expect(await installedVersion('eslint')).toMatch(/^eslint@\d+\.\d+\.\d+/)
  })
})

/**
 * CI installs from scratch, so its cache is cold whatever this does — and it is
 * the one run whose answer nobody re-checks. It gets the uncached command.
 */
describe('what the tool is run with', () => {
  it('passes no cache flag in CI', () => {
    const args = argumentsFor(TOOLS.eslint, 'abc123', { ci: true })

    expect(args).not.toContain('--cache')
    expect(args.join(' ')).not.toContain('abc123')
  })

  it('caches everywhere else, in a location named for the configuration', () => {
    const args = argumentsFor(TOOLS.eslint, 'abc123', { ci: false })

    expect(args).toContain('--cache')
    expect(args.join(' ')).toContain('abc123')
  })

  it('keeps the arguments the tool needs in either case', () => {
    for (const ci of [true, false]) {
      expect(argumentsFor(TOOLS.prettier, 'abc123', { ci })).toEqual(
        expect.arrayContaining(['--check', '.']),
      )
    }
  })

  /**
   * The cache lives under `node_modules`, which `.gitignore` already covers and
   * `.dockerignore` excludes from every build context — so it cannot be committed
   * and cannot reach an image.
   */
  it('puts the cache under node_modules', () => {
    expect(argumentsFor(TOOLS.prettier, 'abc123', { ci: false }).join(' ')).toContain(
      'node_modules/.cache/kolonie/abc123',
    )
  })
})

/** The one line that can be wrong in the direction nobody notices. */
describe('deciding whether the tool passed', () => {
  it('passes on a zero exit code', () => {
    expect(exitCodeFrom(0, null)).toBe(0)
  })

  it('fails on a non-zero exit code', () => {
    expect(exitCodeFrom(1, null)).toBe(1)
  })

  it('fails on a process killed by a signal, which reports no code at all', () => {
    expect(exitCodeFrom(null, 'SIGKILL')).toBe(1)
  })

  it('fails on a null code with no signal, rather than treating it as zero', () => {
    expect(exitCodeFrom(null, null)).toBe(1)
  })
})
