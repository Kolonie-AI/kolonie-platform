import { describe, expect, it } from 'vitest'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

/**
 * **This runner holds no GitHub credential, and that is asserted rather than
 * promised** (`#839`).
 *
 * ## Why it is a test and not a sentence in a comment
 *
 * The whole argument for a fourth runner rests on this. `#407` decided once
 * already that **two processes each holding a write credential is the outcome to
 * avoid**: log-derived defects were routed through the support triage runner —
 * the only process with a GitHub App key — rather than being given a runner of
 * their own. A doctor runner that acquired a key would silently undo that
 * decision, and the way it would arrive is somebody adding a convenient
 * escalation two years from now, in one file, reviewed by somebody who never
 * read `#839`.
 *
 * A reviewer cannot be the check for that. This can.
 *
 * ## What it looks for
 *
 * The environment variable names the App is configured with, the shapes a token
 * takes, and the hostname of the API. Comments are stripped first, for the reason
 * `check:fixtures` strips them before hashing: this file's own paragraphs name
 * every one of those things, and a check that sent somebody to a file for
 * explaining the rule it obeys is a check people learn to ignore.
 *
 * ## What it deliberately does not do
 *
 * It does not stop this runner reaching *anything*. A future rule may need to
 * read a log store or a metrics endpoint, and neither is a write credential. The
 * rule is about GitHub, because GitHub is where this Colony's issues are and
 * writing one is the act `#407` reserved to a single process.
 */
describe('the doctor runner', () => {
  const FORBIDDEN = [
    { pattern: /GITHUB_APP_ID/, what: 'the GitHub App id' },
    { pattern: /GITHUB_APP_KEY_PATH/, what: 'the GitHub App key path' },
    { pattern: /GITHUB_TOKEN/, what: 'a GitHub token' },
    { pattern: /\bghp_/, what: 'a classic token' },
    { pattern: /\bgithub_pat_/, what: 'a fine-grained token' },
    { pattern: /api\.github\.com/, what: 'the GitHub API' },
    { pattern: /@octokit/, what: 'an octokit client' },
  ]

  it('names no GitHub credential and reaches no GitHub API, anywhere in its source', async () => {
    const directory = fileURLToPath(new URL('.', import.meta.url))
    const offenders: string[] = []

    for (const entry of await readdir(directory)) {
      if (!entry.endsWith('.ts')) continue
      // This file, which names every one of those things as a pattern. A check
      // that flagged itself would be a check somebody switches off, and it is
      // the one file in the directory whose *purpose* is to hold the names —
      // the same exemption `origins.test.ts` grants itself, for the same reason.
      if (entry === 'no-credential.test.ts') continue

      const source = await readFile(`${directory}${entry}`, 'utf8')
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

      for (const { pattern, what } of FORBIDDEN) {
        if (pattern.test(code)) offenders.push(`${entry} reaches ${what}`)
      }
    }

    expect(offenders).toEqual([])
  })

  /**
   * And it declares no dependency that could carry one. `@kolonie-ai/core` and
   * `@kolonie-ai/db` are the whole list — the same two the verifier runner
   * declares, and neither of them has ever spoken to GitHub.
   */
  it('declares only core and db as dependencies', async () => {
    const manifest = JSON.parse(
      await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { dependencies?: Record<string, string> }

    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      '@kolonie-ai/core',
      '@kolonie-ai/db',
    ])
  })
})
