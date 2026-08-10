/**
 * The changelog assembler (`#672`).
 *
 * **What is worth testing here is the refusals.** Concatenation either works or
 * produces visible nonsense; a malformed entry file is the case that could
 * silently drop a paragraph out of a released changelog, which is the one thing
 * `#672` insists must not happen — *assembling them is a concatenation, not a
 * summarisation*.
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assemble, readEntries } from './build-changelog.mjs'

let dir: string | undefined

afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

function withEntries(files: Record<string, string>): string {
  dir = mkdtempSync(join(tmpdir(), 'changes-'))
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
  return dir
}

describe('reading an entry', () => {
  it('takes the section off the first line and the entry off the rest', () => {
    const at = withEntries({ '001-a.md': '<!-- section: Added -->\n\n- **A thing** happened.\n' })

    expect(readEntries(at)).toEqual([
      { name: '001-a.md', section: 'Added', body: '- **A thing** happened.' },
    ])
  })

  it('reads in filename order, which is what the numeric prefix is for', () => {
    const at = withEntries({
      '010-b.md': '<!-- section: Added -->\n\n- second\n',
      '002-a.md': '<!-- section: Added -->\n\n- first\n',
    })

    expect(readEntries(at).map((entry) => entry.body)).toEqual(['- first', '- second'])
  })

  it('ignores anything that is not a numbered entry, so a README can live beside them', () => {
    const at = withEntries({
      'README.md': '# changes\n\nHow to add one.\n',
      'RELEASED.md': '## 0.1.0\n',
      '001-a.md': '<!-- section: Added -->\n\n- kept\n',
    })

    expect(readEntries(at).map((entry) => entry.body)).toEqual(['- kept'])
  })

  /**
   * The three rejections. Each is a file that would otherwise assemble into a
   * changelog that reads wrongly rather than one that fails.
   */
  it('refuses an entry with no section, because nothing could place it', () => {
    const at = withEntries({ '001-a.md': '- **A thing** happened.\n' })

    expect(() => readEntries(at)).toThrow(/first line must be/)
  })

  it('refuses a section Keep a Changelog does not have', () => {
    const at = withEntries({ '001-a.md': '<!-- section: Improved -->\n\n- a thing\n' })

    expect(() => readEntries(at)).toThrow(/unknown section "Improved"/)
  })

  it('refuses an entry that is not a bullet, which would break the list around it', () => {
    const at = withEntries({ '001-a.md': '<!-- section: Added -->\n\nA thing happened.\n' })

    expect(() => readEntries(at)).toThrow(/starts with "- "/)
  })

  it('refuses a file that is a section and nothing else', () => {
    const at = withEntries({ '001-a.md': '<!-- section: Added -->\n\n' })

    expect(() => readEntries(at)).toThrow(/section and no entry/)
  })
})

describe('assembling', () => {
  const released = '## 0.1.0 — 2026-07-26\n\nInitial domain model.\n'

  it('groups by section in Keep a Changelog order, not alphabetically', () => {
    const built = assemble(
      [
        { name: '001', section: 'Fixed', body: '- a fix' },
        { name: '002', section: 'Added', body: '- an addition' },
        { name: '003', section: 'Changed', body: '- a change' },
      ],
      released,
    )

    expect(built.indexOf('### Added')).toBeLessThan(built.indexOf('### Changed'))
    expect(built.indexOf('### Changed')).toBeLessThan(built.indexOf('### Fixed'))
  })

  it('writes no heading for a section with nothing in it', () => {
    const built = assemble([{ name: '001', section: 'Added', body: '- an addition' }], released)

    expect(built).not.toContain('### Removed')
    expect(built).toContain('### Added')
  })

  /**
   * **One heading per section, however many entries.** The file this replaced
   * had fourteen `### Added` and `### Changed` headings inside one
   * `## Unreleased`, because every append wrote its own rather than finding the
   * last one — the structural symptom of the defect `#672` is about.
   */
  it('gives a section one heading however many entries it has', () => {
    const built = assemble(
      [
        { name: '001', section: 'Added', body: '- one' },
        { name: '002', section: 'Added', body: '- two' },
        { name: '003', section: 'Added', body: '- three' },
      ],
      released,
    )

    expect(built.split('### Added')).toHaveLength(2)
  })

  it('carries every entry through unchanged, because this concatenates and never summarises', () => {
    const body = '- **A thing** happened.\n  With a second line, and `code`, and a — dash.'
    const built = assemble([{ name: '001', section: 'Added', body }], released)

    expect(built).toContain(body)
  })

  it('keeps the released history at the end, where a reader scrolls to find it', () => {
    const built = assemble([{ name: '001', section: 'Added', body: '- an addition' }], released)

    expect(built.trimEnd().endsWith('Initial domain model.')).toBe(true)
    expect(built.indexOf('## Unreleased')).toBeLessThan(built.indexOf('## 0.1.0'))
  })
})
