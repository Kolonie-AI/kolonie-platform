#!/usr/bin/env node

/**
 * Fail when a file marked `merge=union` in `.gitattributes` carries a duplicate
 * entry (`#1496`).
 *
 * ## What `union` buys and what it costs
 *
 * `union` is a built-in merge driver that keeps **both** sides of a conflicting
 * hunk instead of asking. On an append-only registry that is exactly right: two
 * branches adding two unrelated tables add two lines at the same place, and a
 * hand resolution between them decides nothing.
 *
 * The cost is that a union merge **never fails**. Where the two sides could
 * produce the same entry twice, it produces a file that compiles and is wrong,
 * and it does it silently — which is worse than the conflict it removed.
 *
 * So `#1496` made it a condition: nothing gets `union` unless something
 * downstream would catch a duplicate. This is that something, for the case where
 * nothing else is.
 *
 * ## Why it reads `.gitattributes` rather than a list of its own
 *
 * A second list of union files would be a second place to keep in step, which is
 * the failure this whole batch exists to stop. Marking a path `union` is what
 * enrols it here; there is nothing else to remember and nothing that can drift.
 *
 * Measured 2026-08-21, and the reason this is not left to the build: with
 * `packages/db/src/schema/index.ts` carrying the same `export * from` line twice,
 * `tsc -b` is green and `npm run check:counts` is green. TypeScript does not mind
 * a module being re-exported twice. Nothing in the repository objected.
 *
 * `apps/api/src/mcp/tool-list.ts` is the opposite case — `tool-list.test.ts`
 * diffs it against what `tools/list` actually serves and goes red on a duplicate,
 * verified the same day. It is checked here too, because the condition is about
 * the driver rather than about which files happen to be covered today.
 *
 * ## Naming the guard is the enforcement
 *
 * `GUARDS` below is the whole of it. A path marked `merge=union` that is not in
 * that table fails this check, so the condition `#1496` wrote cannot be met by
 * intention: somebody adding a driver has to say what catches a duplicate before
 * the driver lands.
 *
 * Two kinds, because two files are guarded two different ways:
 *
 * - `duplicate-scan` — this script reads the file and refuses a repeated entry.
 *   For a list whose union result is meant to be *correct*.
 * - `regenerated` — the file is produced, and a `--check` gate compares it to
 *   what its script would write. The union result is not expected to be right;
 *   it is expected not to stop the merge, and the named gate is what makes that
 *   safe.
 *
 * **`regenerated` currently has no members, and both files that had it left for
 * the same reason.** `packages/core/CHANGELOG.md` went first (`#1572`) and
 * `docs/decisions.md` followed (`#1662`, D-138): union resolved each correctly in
 * a working tree, GitHub never applied the driver, and both went on conflicting
 * where it decides whether a branch can land. The kind is kept described rather
 * than deleted because the distinction is the useful part — if a produced file is
 * ever tracked and given `union` again, it is guarded by its `--check` and not by
 * a scan for repeated lines. **What that pair proved is the sharper rule:** a
 * gate catches a *wrong* file and cannot catch one that never merged, so for a
 * produced file the cure is to stop tracking it rather than to guard it. A file
 * nobody commits needs no driver and no guard.
 *
 * ## What counts as an entry
 *
 * A line that is one item of a list: an `export * from '…'`, a quoted string
 * followed by a comma. Comments, blank lines, brackets and declarations are not
 * entries and are ignored — a file may legitimately open three arrays with three
 * identical `] as const` lines.
 */

// `console` and `process` are imported rather than reached for, as
// `check-fixture-mirrors.mjs` and `check-counts.mjs` do: the eslint config
// declares no environment for a script.
import console from 'node:console'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The paths `.gitattributes` marks `merge=union`.
 *
 * Only literal paths are read. A pattern with a wildcard would need git's own
 * matcher to expand, and there are none — if one is ever added this says so
 * rather than skipping it quietly, because a union file nobody checks is the
 * exact hole this script fills.
 */
function unionPaths() {
  const file = join(root, '.gitattributes')
  if (!existsSync(file)) {
    throw new Error('.gitattributes is missing — #1496 added it and something removed it')
  }

  const paths = []
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue

    const [pattern, ...attributes] = line.split(/\s+/)
    if (!attributes.includes('merge=union')) continue

    if (/[*?[\]]/.test(pattern)) {
      throw new Error(
        `.gitattributes marks the pattern '${pattern}' merge=union. This check only ` +
          'reads literal paths, so that entry would go unguarded. Either name the ' +
          'files or teach this script to expand a pattern.',
      )
    }
    paths.push(pattern)
  }
  return paths
}

/**
 * What catches a duplicate in each `merge=union` file.
 *
 * Every path `.gitattributes` marks `union` must appear here or this check
 * fails. See the header for the two kinds.
 */
const GUARDS = {
  'packages/db/src/schema/index.ts': {
    kind: 'duplicate-scan',
    why: 'nothing else catches it — tsc and check:counts are both green on a doubled export',
  },
  'apps/api/src/mcp/tool-list.ts': {
    kind: 'duplicate-scan',
    why: 'also apps/api/src/mcp/tool-list.test.ts, which diffs it against the served tools/list',
  },
}

/** One item of a list, or null for a line that is not one. */
function entryOf(line) {
  const text = line.trim()
  if (text === '' || text.startsWith('//') || text.startsWith('*') || text.startsWith('/*')) {
    return null
  }

  const reExport = text.match(/^export \* from ['"](.+)['"];?$/)
  if (reExport) return `export ${reExport[1]}`

  const stringItem = text.match(/^['"](.+)['"],$/)
  if (stringItem) return `item ${stringItem[1]}`

  return null
}

const failures = []

for (const path of unionPaths()) {
  const guard = GUARDS[path]
  if (guard === undefined) {
    failures.push(
      `${path}: marked merge=union in .gitattributes and named in no guard. ` +
        'A union merge never fails, so a file with nothing downstream of it is a ' +
        'silent wrong answer waiting to happen. Add it to GUARDS in this script ' +
        'with what catches a duplicate.',
    )
    continue
  }

  const file = join(root, path)
  if (!existsSync(file)) {
    failures.push(`${path}: marked merge=union in .gitattributes and does not exist`)
    continue
  }

  // A produced file is guarded by the gate that regenerates it, not by a scan
  // for repeated lines: its union result is allowed to be wrong, and the gate is
  // what refuses to let it stay wrong.
  if (guard.kind === 'regenerated') continue

  const seen = new Map()
  const lines = readFileSync(file, 'utf8').split('\n')

  lines.forEach((line, index) => {
    const entry = entryOf(line)
    if (entry === null) return

    const first = seen.get(entry)
    if (first === undefined) {
      seen.set(entry, index + 1)
      return
    }
    failures.push(
      `${path}:${index + 1}: ${line.trim()} — already at line ${first}. ` +
        'This file is merge=union, so a duplicate is what a merge produces when ' +
        'two branches add the same entry. Delete one.',
    )
  })
}

if (failures.length > 0) {
  console.error('\nmerge=union is not safe here yet:\n')
  for (const failure of failures) console.error(`  ${failure}`)
  console.error(
    '\nA union merge keeps both sides and never fails, so nothing else was going ' +
      'to tell you. See .gitattributes and #1496.\n',
  )
  process.exit(1)
}

const paths = unionPaths()
const scanned = paths.filter((path) => GUARDS[path]?.kind === 'duplicate-scan')
console.log(
  `check:union-guards — ${paths.length} merge=union files, all guarded; ` +
    `${scanned.length} scanned for duplicate entries, none found`,
)
