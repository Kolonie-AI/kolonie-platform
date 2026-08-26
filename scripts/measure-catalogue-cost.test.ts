import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The committed measurement carries **both** runs (`#1654`).
 *
 * ## Why this is a test and not a review note
 *
 * `measure-catalogue-cost.mjs --out` writes the whole file, so the ordinary way
 * to take a second reading destroys the first one — and the loss is invisible,
 * because what is left is a valid report with a recent date on it. The 4.32 %
 * baseline is the only figure the Colony has to compare a catalogue change
 * against, and `#1654` exists precisely because two weeks of trimming went
 * unmeasured against it. A baseline that can be overwritten by the command that
 * reads it is a baseline nobody can rely on being there.
 *
 * So the document is assembled by hand from the script's output, and this holds
 * the property that assembly is for: the earlier run stays quotable.
 *
 * **It asserts the shape, never the verdict.** Nothing here requires a rate to
 * be low, or to have moved in either direction — `#1654` introduces no
 * threshold and no gate, and a test that pinned the conclusion would be one.
 */
const REPORT = readFileSync(
  new URL('../docs/measurements/catalogue-cost.md', import.meta.url),
  'utf8',
)

describe('the committed catalogue-cost measurement', () => {
  /**
   * The baseline figures, verbatim as the 2026-08-17 run stated them. If a
   * later `--out` overwrites the file, every one of these disappears at once.
   */
  it('still carries the 2026-08-17 run and its headline', () => {
    expect(REPORT).toContain('2026-08-17')
    expect(REPORT).toContain('4.32 %')
    expect(REPORT).toContain('215 of 4,977 calls')
  })

  it('carries the second run beside it', () => {
    expect(REPORT).toContain('2026-08-26')
    expect(REPORT).toContain('4.70 %')
    expect(REPORT).toContain('170 of 3,614 calls')
  })

  /** A run nobody can reproduce is an assertion, so each states its command. */
  it('states the command that produced each run', () => {
    const commands = REPORT.match(/node scripts\/measure-catalogue-cost\.mjs/g) ?? []
    expect(commands.length).toBeGreaterThanOrEqual(2)
  })

  /**
   * The three tools `#1654` names. `kolonie.accounts.prove` is the interesting
   * one: it fell below the floor in the second window, and the report has to say
   * so rather than leaving a reader to conclude its refusals went away.
   */
  it('accounts for each of the three named tools in both windows', () => {
    for (const tool of [
      'kolonie.academy.answer',
      'kolonie.accounts.prove',
      'kolonie.accounts.walk-report',
    ]) {
      expect(REPORT, tool).toContain(tool)
    }
  })

  /**
   * The standard the 2026-08-17 run set for itself. A later run that quietly
   * upgraded *no evidence of harm* into *evidence of no harm* would be the one
   * failure mode this document cannot recover from, because the flattering
   * reading is the one that gets quoted.
   */
  it('keeps the honest form of the conclusion', () => {
    expect(REPORT).toContain('no evidence of harm')
    expect(REPORT).toContain('not evidence of no harm')
  })

  /** `#1654` is explicit that it introduces no rollback, gate or threshold. */
  it('proposes no threshold and no gate', () => {
    expect(REPORT).toContain('proposes nothing')
    expect(REPORT).not.toMatch(/\bfails? the build\b/i)
  })

  /** No credential, host or address reaches a committed measurement. */
  it('carries no credential and no address', () => {
    expect(REPORT).not.toMatch(/Bearer\s+\S/i)
    expect(REPORT).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/)
    expect(REPORT).not.toMatch(/sk-[A-Za-z0-9]/)
  })
})
