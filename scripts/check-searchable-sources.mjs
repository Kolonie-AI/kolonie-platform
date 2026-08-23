#!/usr/bin/env node

/**
 * Fail when a text file in the working tree carries a raw NUL byte (`#1527`).
 *
 * ## Why a gate and not a one-time fix
 *
 * **`grep` treats a file containing a NUL as binary and stops.** It prints
 * `Binary file … matches` at best, and under the wrapper this repository's agents
 * use it returns nothing at all with **exit code 1** — the same answer as *this
 * symbol does not exist*. `ripgrep` is louder and no more useful: it warns and
 * skips the rest of the file.
 *
 * Measured 2026-08-21 on `09c5759d`: six source files carried one, and one of
 * them was `packages/db/src/storage/account-walks.ts` — 3,302 lines holding
 * `recordWalkProseModeration`, `writeWalkProseVerdict` and the whole walk-close
 * path, with the byte at line 2706. A search for any of those answered *not
 * found*. Diagnosing `#1485` cost the time of reconstructing the call chain with
 * a script because every `grep` over the file came back empty.
 *
 * So the failure is silent by construction, and a fix without a gate is a fix
 * that lasts until the next author writes the byte instead of the escape. The
 * two compile to the same string; what differs is whether the *file* can be
 * searched.
 *
 * ## What it does not do
 *
 * It does not object to non-ASCII. Typographic quotes, accented labels and `→`
 * are throughout this repository and none of them stops a search. **NUL is the
 * one byte that decides a file is binary**, which is why this checks for it
 * alone rather than growing into a character policy.
 *
 * ## What it reads
 *
 * `git ls-files`, so the set comes from git rather than from a directory walk
 * that has to learn about `node_modules`, `dist` and worktrees. Extensions are
 * an allowlist rather than a denylist: a NUL in a `.png` is the file working
 * correctly, and guessing which unknown extension is text is how a gate starts
 * failing on somebody's fixture.
 *
 * **`--others --exclude-standard`, so the set is the working tree and not only
 * what is tracked (`#1644`).** Without them the gate is silent for exactly as
 * long as a file is new — which is the whole time it is being written, and the
 * case where the byte gets in: nobody pastes a NUL into a file they have been
 * editing for a week. `apps/api/src/atlas/figures-cache.ts` was written with one
 * in a template literal, passed `npm run check` locally before `git add`, and
 * failed the same commit on CI. The flags cost nothing and move that failure to
 * where the author is.
 *
 * The ignore rules are what keep `node_modules` and `dist` out, so the exclusion
 * this file relied on survives — it is now stated by `.gitignore` rather than
 * implied by the file not having been added yet.
 *
 * **There is no per-file exemption and that is deliberate.** The one file with a
 * defensible reason — a `TextEncoder` fixture building an EXIF header — encodes
 * identically from the escape, so the exemption would have bought nothing and
 * cost the property. An allowlist of one is an allowlist.
 */

// `console` and `process` are imported rather than reached for, as
// `check-union-merge-guards.mjs` and `check-counts.mjs` do: the eslint config
// declares no environment for a script.
import { execFileSync } from 'node:child_process'
import console from 'node:console'
import { readFileSync } from 'node:fs'
import process from 'node:process'

/** Extensions where a NUL is never the file working correctly. */
const TEXT = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.sql',
  '.yml',
  '.yaml',
  '.css',
  '.html',
  '.sh',
  '.txt',
  '.toml',
])

const inTree = execFileSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  { encoding: 'utf8' },
)
  .split('\0')
  .filter((name) => name !== '')

const carrying = []
for (const name of inTree) {
  const dot = name.lastIndexOf('.')
  if (dot === -1 || !TEXT.has(name.slice(dot))) continue

  let bytes
  try {
    bytes = readFileSync(name)
  } catch {
    // Listed and absent is somebody else's failure — a sparse checkout, a file
    // being deleted in this very commit, an untracked one removed between the
    // listing and the read. Not this gate's to report.
    continue
  }

  const at = bytes.indexOf(0)
  if (at === -1) continue

  const line = bytes.subarray(0, at).toString('utf8').split('\n').length
  carrying.push({ name, line, count: bytes.filter((byte) => byte === 0).length })
}

if (carrying.length === 0) {
  console.log(`No text file in the working tree carries a NUL byte (${inTree.length} read).`)
  process.exit(0)
}

console.error('These files carry a raw NUL byte, so grep and ripgrep skip them silently:\n')
for (const { name, line, count } of carrying) {
  console.error(`  ${name}  —  ${count} NUL${count === 1 ? '' : 's'}, first at line ${line}`)
}
console.error(
  '\nWrite it as the escape sequence instead. In a TypeScript string or template\n' +
    'literal that is \\u0000, which compiles to the same character and leaves the\n' +
    'file searchable. If you meant a binary fixture, build it from bytes rather\n' +
    'than from a source file nobody can grep.',
)
process.exit(1)
