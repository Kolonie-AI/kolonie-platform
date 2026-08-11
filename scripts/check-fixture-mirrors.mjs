#!/usr/bin/env node

/**
 * Fail when a fixture's copy of a production decision rule has gone stale
 * (`#735`).
 *
 * `apps/api/src/__fixtures__/` fakes the storage layer so the API tests can run
 * without a database — a deliberate property, and the reason the honest fix
 * (drive the fixture and the real function through one table of cases) is not
 * available here. What the fixtures fake is mostly rows, and faking a row cannot
 * drift. What **can** drift is the handful of them that reimplement a *decision*:
 * whether `replace: true` abandons an open challenge, which of two rows counts as
 * outstanding, when a mint refuses.
 *
 * That drifted twice in one afternoon. `#714` and `#717` were both one-line
 * conditions in `packages/db/src/storage/`, both faithfully copied into a fixture
 * with a doc comment citing the issue that put it there, and in both cases every
 * API test went on passing with the fixture's old behaviour after production
 * changed. **A fixture with a stale one-liner looks careless; a fixture with a
 * well-argued paragraph looks correct**, and the argument outlives the code it
 * describes.
 *
 * ## What a mirror is, and what this actually checks
 *
 * A fixture that reimplements a rule declares which function it mirrors and pins
 * that function's shape:
 *
 *     // @mirrors packages/db/src/storage/sms-challenges.ts mintSmsReceiveChallenge 1a2b3c4d
 *
 * The pin is a hash of the function's code. When somebody edits the production
 * rule the hash moves, this fails, and the only way past it is to open the
 * fixture — which is the whole mechanism. It does not prove the two agree; **it
 * makes the fixture unskippable when the thing it copies changes**, which is the
 * step that was missed both times. Re-pinning without reading the fixture is
 * possible and is the same act as deleting a failing assertion.
 *
 * ## Why the hash is over code and not over the file
 *
 * Comments and blank lines are stripped and whitespace is collapsed before
 * hashing, so a reworded paragraph does not send anyone to a fixture that is
 * still correct. A pin that fires on prose would be re-pinned reflexively within
 * a month, and a check people learn to wave through is worse than no check.
 *
 * ## Adding one
 *
 * Put the marker above the fixture's implementation of the rule, with any hash,
 * and run this — it prints the one to paste. Fixtures that only store and return
 * rows need no marker; this is not a coverage target, and a marker on a fixture
 * that decides nothing is noise for whoever edits that function next.
 *
 * ## Usage
 *
 *     node scripts/check-fixture-mirrors.mjs
 *
 * Exits non-zero and prints every problem rather than the first, and prints the
 * replacement pin beside each — somebody fixing this wants the whole list and
 * then wants to paste.
 */

// `console` and `process` are imported rather than reached for, as
// `check-theme-drift.mjs` and `check-counts.mjs` do: the eslint config declares
// no environment for a script.
import console from 'node:console'
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Where markers are looked for. A directory rather than the whole tree: a
 * mirror is a fixture's problem, and a production file citing another production
 * file is an import waiting to be written. */
export const FIXTURE_DIR = 'apps/api/src/__fixtures__'

const MARKER = /@mirrors\s+(\S+)\s+([A-Za-z0-9_$]+)\s+([0-9a-f]{8})/g

/**
 * The pinned shape of one function: its code with the prose taken out.
 *
 * Extraction is textual on purpose — a check about two text files should not
 * need the compiler that a `tsc -b` already ran. It relies on the one thing
 * Prettier guarantees here: a top-level declaration starts at column zero and
 * ends at a closing brace at column zero.
 */
export function functionSource(source, name) {
  const lines = source.split('\n')
  const start = lines.findIndex((line) =>
    new RegExp(`^export (async function|function|const) ${name}\\b`).test(line),
  )
  if (start === -1) return undefined

  let end = start
  while (end < lines.length && !/^[}]/.test(lines[end])) end += 1
  if (end === lines.length) return undefined

  return lines.slice(start, end + 1).join('\n')
}

/** Code only: block comments, line comments, blank lines and indentation gone. */
export function fingerprint(text) {
  const code = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('\n')
    .replace(/[ \t]+/g, ' ')

  return createHash('sha256').update(code).digest('hex').slice(0, 8)
}

/** Every marker in a fixture, with the line it sits on for the error message. */
export function markersIn(source, file) {
  const found = []
  for (const match of source.matchAll(MARKER)) {
    found.push({
      fixture: file,
      line: source.slice(0, match.index).split('\n').length,
      target: match[1],
      symbol: match[2],
      pinned: match[3],
    })
  }
  return found
}

async function main() {
  const dir = path.join(root, FIXTURE_DIR)
  const files = (await readdir(dir)).filter((name) => name.endsWith('.ts'))

  const markers = []
  for (const name of files) {
    const source = await readFile(path.join(dir, name), 'utf8')
    markers.push(...markersIn(source, `${FIXTURE_DIR}/${name}`))
  }

  if (markers.length === 0) {
    console.error(`No @mirrors markers found under ${FIXTURE_DIR}. That is a defect in this check.`)
    process.exit(1)
  }

  const problems = []
  const sources = new Map()

  for (const marker of markers) {
    if (!sources.has(marker.target)) {
      sources.set(
        marker.target,
        await readFile(path.join(root, marker.target), 'utf8').catch(() => undefined),
      )
    }
    const source = sources.get(marker.target)

    if (source === undefined) {
      problems.push(`${marker.fixture}:${marker.line} mirrors ${marker.target}, which is not there`)
      continue
    }

    const body = functionSource(source, marker.symbol)
    if (body === undefined) {
      problems.push(
        `${marker.fixture}:${marker.line} mirrors ${marker.symbol} in ${marker.target}, which declares no such export`,
      )
      continue
    }

    const now = fingerprint(body)
    if (now !== marker.pinned) {
      problems.push(
        `${marker.fixture}:${marker.line} pins ${marker.symbol} at ${marker.pinned}, which is now ${now}\n` +
          `      ${marker.target} changed. Read the fixture against it, then pin ${now}.`,
      )
    }
  }

  if (problems.length > 0) {
    console.error(
      `${problems.length} of ${markers.length} fixture mirrors are out of step with what they copy:\n`,
    )
    for (const problem of problems) console.error(`  ${problem}`)
    console.error(
      '\nThe pin moving is not itself a fault — it is the prompt to check whether the\n' +
        'fixture still behaves like the function it fakes (#714, #717). Re-pin once it does.',
    )
    process.exit(1)
  }

  console.log(`Fixture mirrors in step: ${markers.length} pinned, none drifted.`)
}

// Importable by the test without running, the shape `check-dist.mjs` uses.
if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
