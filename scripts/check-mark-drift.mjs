#!/usr/bin/env node

/**
 * Fail when the console's copy of the mark has drifted from `kolonie-website`'s
 * (`#498`).
 *
 * `apps/api/src/console/mark.ts` holds a copy of the path data in the website's
 * `public/mark.svg`, because the two live in different repositories and the
 * console has no build step to import through. This is the same arrangement
 * `check-theme-drift.mjs` guards for the palette, for the same reason and with
 * the same argument: a copy with nothing watching it is not a copy — it is a
 * second drawing that happens to have started the same.
 *
 * ## What it compares
 *
 * **The geometry, and the stroke weight.** Every `d="…"` in order, and the
 * `stroke-width`. That is the whole of what is copied.
 *
 * **Not the colour**, and its absence here is the point rather than a gap. The
 * console's strokes are `var(--k-accent)` and `var(--k-text-strong)`, which
 * `theme.ts` declares and `check-theme-drift.mjs` compares against the same
 * website theme the mark is generated from. So the two scripts together cover
 * the whole mark: this one the shape, that one the colour, and neither
 * duplicates the other.
 *
 * A literal colour appearing in `mark.ts` **is** a failure here, though — it
 * would mean a value had escaped the palette into a file the palette check does
 * not read.
 *
 * ## Why `mark.svg` and not `favicon.svg`
 *
 * The regular, untiled cut: the console's background is `--k-bg`, which is a
 * surface the Colony's own theme owns. `kolonie-docs/brand/README.md` §2 — the
 * tile exists for a background nobody here chose.
 *
 * ## Usage
 *
 *     node scripts/check-mark-drift.mjs <path to kolonie-website/public/mark.svg>
 *
 * Exits non-zero and prints every difference rather than the first.
 */

import console from 'node:console'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

const markPath = process.argv[2]
if (markPath === undefined) {
  console.error(
    'usage: node scripts/check-mark-drift.mjs <path to kolonie-website/public/mark.svg>',
  )
  process.exit(2)
}

/** Every `d="…"`, in document order. */
const paths = (svg) => [...svg.matchAll(/\bd="([^"]+)"/g)].map((match) => match[1])

const strokeWidth = (svg) => svg.match(/stroke-width="([^"]+)"/)?.[1]

/**
 * The `CONSOLE_MARK` array literal, and not the file around it.
 *
 * Scoped rather than read whole, and the first version of this script was not:
 * it read the source and reported `#498`, `#422` and `#397` as literal colours,
 * because an issue reference and a short hex are the same six characters. The
 * comments in that file are longer than the markup and are exactly where those
 * references live.
 *
 * The declaration has to stay an array of string literals for this to work.
 * That is the same constraint `check-theme-drift.mjs` puts on `CONSOLE_TOKENS`,
 * and it fails loudly here rather than silently comparing nothing.
 */
const source = await readFile(path.join(here, '..', 'apps/api/src/console/mark.ts'), 'utf8')
const block = source.match(/export const CONSOLE_MARK = \[([\s\S]*?)\n\]\.join\(''\)/)
if (block === null) {
  console.error('CONSOLE_MARK not found in apps/api/src/console/mark.ts')
  process.exit(1)
}
const ours = block[1]
const theirs = await readFile(markPath, 'utf8')

const problems = []

const oursPaths = paths(ours)
const theirsPaths = paths(theirs)

// Without this, an empty parse on either side compares [] to [] and passes —
// the failure mode `--fail` exists for in the workflow that fetches the file.
if (theirsPaths.length === 0) problems.push(`no path data found in ${markPath}`)
if (oursPaths.length === 0) problems.push('no path data found in CONSOLE_MARK')

if (oursPaths.length !== theirsPaths.length) {
  problems.push(
    `the console draws ${oursPaths.length} paths, the website's mark has ${theirsPaths.length}`,
  )
} else {
  for (const [index, ourPath] of oursPaths.entries()) {
    if (ourPath !== theirsPaths[index]) {
      problems.push(`path ${index + 1}: console has ${ourPath}, website has ${theirsPaths[index]}`)
    }
  }
}

const oursWeight = strokeWidth(ours)
const theirsWeight = strokeWidth(theirs)
if (oursWeight !== theirsWeight) {
  problems.push(
    `stroke-width: console has ${oursWeight ?? 'none'}, website's mark.svg has ${theirsWeight ?? 'none'}` +
      ' — check this is mark.svg and not the favicon, which is the heavy cut',
  )
}

// The console's strokes are tokens. A hex here would be a colour the palette
// check cannot see, in the one file it does not read.
const literals = ours.match(/#[0-9a-f]{3,8}\b/gi) ?? []
for (const literal of literals) {
  problems.push(`${literal}: a literal colour in mark.ts, which must draw in var(--k-*) only`)
}

if (problems.length > 0) {
  console.error(
    `The console's mark has drifted from kolonie-website (${problems.length} problem(s)):\n`,
  )
  for (const problem of problems) console.error(`  ${problem}`)
  console.error(
    '\nFix apps/api/src/console/mark.ts, or — if the website redrew the mark on purpose — copy the new geometry across.',
  )
  process.exit(1)
}

console.log(
  `Mark in step with kolonie-website: ${oursPaths.length} paths and the stroke weight compared, none drifted.`,
)
