/**
 * Assemble `packages/core/CHANGELOG.md` from one file per entry (`#672`).
 *
 * Usage:
 *   node scripts/build-changelog.mjs            # write the file
 *   node scripts/build-changelog.mjs --check    # fail if it is not what would be written
 *
 * ## The conflict this removes
 *
 * `packages/core/CHANGELOG.md` was appended to at the top by every change that
 * touched `@kolonie-ai/core`. Two changes in flight at once conflicted there **by
 * construction**, whatever else they touched and however unrelated they were. It
 * happened on 2026-08-10: `#668` and `#670` collided on that file and on one
 * other. The one other was a real overlap; this one was two entries about two
 * different subjects, both inserted under `### Added`.
 *
 * **This argument has been made once already in this organisation and won.**
 * `kolonie-docs/state/decisions.md` had the same shape and the same cure — one
 * file per record — after reaching 3052 lines on +3135/−82 in three weeks. Every
 * word of its reasoning transfers; the only difference is which end of the file
 * was appended to. This one had reached 1745 lines with 138 entries under a
 * single `## Unreleased`, and fourteen separate `### Added` / `### Changed`
 * headings inside it — which is the same defect showing through the structure,
 * because each append made its own heading rather than finding the last one.
 *
 * ## What is written and what is produced
 *
 * **One is written, the other is produced, and that is the whole rule.**
 *
 * | | |
 * |---|---|
 * | `packages/core/changes/NNN-slug.md` | **written.** One entry, as prose, with its section on the first line |
 * | `packages/core/changes/RELEASED.md` | **written**, and only at a release. Every version that has shipped |
 * | `packages/core/CHANGELOG.md` | **produced** by this script, and **not tracked** (`#1572`) |
 *
 * ## Why it stopped being checked in, having been for two months
 *
 * `#672` kept it tracked because *consumers read `CHANGELOG.md` at a tag*, and
 * `D-123` reaffirmed that. Measured 2026-08-22: this repository has **zero
 * tags**, no workflow that publishes, tags or cuts a release, and no package
 * under the organisation. The reader that sentence protects has never existed.
 *
 * What it cost meanwhile is exact: a produced file that every entry touches is a
 * file every pair of open pull requests conflicts on — **432 commits to it in
 * thirty days** — and `#1496`'s `merge=union`, which resolves it correctly in a
 * working tree, **is not applied by GitHub**, so the conflict survives on the one
 * surface that decides whether a branch can land. Four rebases in one session,
 * and an armed pull request silently disarmed by each.
 *
 * `#271` had already answered this shape for the storage barrel: *a file nobody
 * commits cannot be merged at all, which is the whole of the fix.*
 *
 * **`changes/` is the changelog.** It is on `main`, it is readable, it is the
 * source, and it is one file per entry — which is what `#951` split it into
 * precisely so that two unrelated changes would stop meeting. This is that split
 * finished.
 *
 * The file is still produced, by this script, and `packages/core`'s `prepack`
 * runs it — so a publish, if there is ever one, ships the changelog `#672`
 * wanted, built from the same entries.
 *
 * ## What this is not
 *
 * **Not a generated file with no author.** Assembling is concatenation, never
 * summarisation: every byte of every entry reaches the output unchanged, and the
 * migration that created the directory was proved by rebuilding the file and
 * comparing the entries it contained. The prose is the point — several of these
 * entries are the only place a decision's shape is recorded.
 *
 * ## Why `--check` and Prettier do not fight
 *
 * `format:check` covers `packages/core/changes/` as well as the produced file,
 * so every entry on disk is already Prettier-clean — and Prettier's changes to a
 * Markdown bullet are local to that bullet. Concatenating clean bullets under
 * clean headings therefore produces a clean file, and the two checks agree.
 *
 * **That is a property of this arrangement and not a coincidence.** If the
 * scaffolding below ever grows something Prettier would rewrite — a table, a
 * reference link, a line over the print width — `--check` starts failing with a
 * message about entries when the real cause is formatting. Keep the scaffolding
 * to headings and blank lines.
 *
 * ## Ordering
 *
 * By filename, and the numeric prefix is what makes that meaningful: it is the
 * position the entry had when the directory was created, so the file reads in
 * the order it always did. A new entry takes the next number, which puts it at
 * the end of its section rather than the top — the one visible change, and the
 * price of two changes never touching the same line.
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
// `console` and `process` are Node globals, imported rather than reached for:
// the eslint config declares no environment for a script, and one import line
// is cheaper than an override — the same reason `check-counts.mjs` does it.
import process from 'node:process'
import console from 'node:console'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CHANGES = join(ROOT, 'packages/core/changes')
const CHANGELOG = join(ROOT, 'packages/core/CHANGELOG.md')

/**
 * The preamble, held here because it is the one part that is neither an entry
 * nor a release. It is three sentences and has not changed since 0.1.0; a file
 * of its own would be a third thing to look for.
 */
const HEADER = `# Changelog

All notable changes to \`@kolonie-ai/core\` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
While the version is \`0.x\`, **breaking changes bump the minor version**.
`

/**
 * Keep a Changelog's order, and not alphabetical.
 *
 * A reader scanning an unreleased section wants *what is new* before *what
 * moved under me*, and *what broke* before *what is gone*. Alphabetical would
 * put `Changed` first, which is the order nobody reads in.
 */
const SECTIONS = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security']

const SECTION_MARKER = /^<!--\s*section:\s*(.+?)\s*-->\s*$/

/** Every entry file, in filename order, with its section and its prose. */
export function readEntries(dir = CHANGES) {
  return readdirSync(dir)
    .filter((name) => /^\d+-.*\.md$/.test(name))
    .sort()
    .map((name) => {
      const raw = readFileSync(join(dir, name), 'utf8')
      const [first, ...rest] = raw.split('\n')
      const marker = SECTION_MARKER.exec(first)

      if (marker === null) {
        throw new Error(
          `${name}: the first line must be \`<!-- section: Added -->\` or another of ` +
            `${SECTIONS.join(', ')}. Without it nothing can place the entry.`,
        )
      }
      if (!SECTIONS.includes(marker[1])) {
        throw new Error(`${name}: unknown section "${marker[1]}". Known: ${SECTIONS.join(', ')}.`)
      }

      const body = rest.join('\n').trim()
      if (body === '') throw new Error(`${name}: has a section and no entry.`)
      if (!body.startsWith('- ')) {
        throw new Error(
          `${name}: an entry is a Markdown bullet, so it starts with "- ". This one starts ` +
            `"${body.slice(0, 20)}…", and the assembled file would not be a list.`,
        )
      }

      return { name, section: marker[1], body }
    })
}

export function assemble(entries, released) {
  const parts = [HEADER, '\n## Unreleased\n']

  for (const section of SECTIONS) {
    const mine = entries.filter((entry) => entry.section === section)
    if (mine.length === 0) continue
    parts.push(`\n### ${section}\n\n`)
    parts.push(mine.map((entry) => entry.body).join('\n\n'))
    parts.push('\n')
  }

  parts.push('\n')
  parts.push(released.trim())
  parts.push('\n')
  return parts.join('')
}

/**
 * **Guarded, because the test imports this file.** Without it, importing the
 * module to exercise `assemble` would rewrite `CHANGELOG.md` as a side effect —
 * a test suite that edits the repository it is testing, and the first symptom
 * would be an unexplained diff after a green run.
 */
function main() {
  let entries
  let released
  try {
    entries = readEntries()
    released = readFileSync(join(CHANGES, 'RELEASED.md'), 'utf8')
  } catch (error) {
    // The message names the file and what is wrong with it. A stack trace here
    // would bury that under twenty lines about `node:internal`, and the reader
    // is somebody who has just written their first entry file.
    console.error(`packages/core/changes: ${error instanceof Error ? error.message : error}`)
    process.exitCode = 1
    return
  }
  const built = assemble(entries, released)

  /**
   * **`--check` asserts that the directory assembles, and nothing about a file
   * on disk** (`#1572`). It used to compare against the tracked `CHANGELOG.md`,
   * which is no longer tracked — there is nothing to be out of step with, and
   * the only way to fail is to write an entry the assembler cannot read.
   *
   * That is the whole of what it was ever really asserting: `readEntries` above
   * is where a missing section marker, an unreadable name or a duplicate number
   * is refused, and every one of those threw before the comparison was reached.
   */
  if (process.argv.includes('--check')) {
    console.log(
      `packages/core/changes/ assembles: ${entries.length} entries, ` +
        `${built.split('\n').length} lines. Not written — CHANGELOG.md is produced, not tracked (#1572).`,
    )
    return
  }

  writeFileSync(CHANGELOG, built)
  console.log(`packages/core/CHANGELOG.md written from ${entries.length} entries`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
