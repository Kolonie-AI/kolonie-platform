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
