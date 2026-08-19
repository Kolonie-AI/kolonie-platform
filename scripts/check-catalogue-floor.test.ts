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
})
