#!/usr/bin/env node

/**
 * Fail when the console's palette has drifted from `kolonie-website`'s (`#422`).
 *
 * `apps/api/src/console/theme.ts` holds a copy of the website's `--k-*` values,
 * because the two live in different repositories and the console has no build
 * step to import a stylesheet through. **Two hand-maintained palettes disagree
 * within a month**, so the copy needs a check or it is not a copy — it is a
 * second palette that happens to have started the same.
 *
 * This is the same shape the website already uses for its font files: they are
 * copied out of the npm package, and `theme.test.ts` asserts the copies still
 * match the package byte for byte. What differs is only that the source is a
 * repository rather than a dependency, so the comparison is a job rather than a
 * test — `.github/workflows/theme-drift.yml` checks the website out and runs
 * this.
 *
 * ## What it compares, and what it deliberately does not
 *
 * Every entry in `CONSOLE_TOKENS`, against the **dark** `:root` block of the
 * website's `src/styles/theme.css`. The light block is not compared because the
 * console is dark only, and the font stack is not compared because the console
 * cannot fetch a webfont under `default-src 'none'` — both are decisions
 * recorded in `theme.ts` rather than omissions.
 *
 * A token in `CONSOLE_TOKENS` that the website does not declare at all is a
 * failure too. That is the direction that would otherwise go unnoticed: a value
 * invented here reads as part of the shared palette and is not.
 *
 * ## Usage
 *
 *     node scripts/check-theme-drift.mjs <path to kolonie-website/src/styles/theme.css>
 *
 * Exits non-zero and prints every difference, rather than the first — somebody
 * fixing this wants the whole list.
 */

// `console` and `process` are imported rather than reached for: the eslint
// config declares no environment for a script, and one import line is cheaper
// than a config block per file. `check-counts.mjs` does the same.
import console from 'node:console'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

const themePath = process.argv[2]
if (themePath === undefined) {
  console.error(
    'usage: node scripts/check-theme-drift.mjs <path to kolonie-website/src/styles/theme.css>',
  )
  process.exit(2)
}

/**
 * The console's tokens, read out of the TypeScript source rather than imported.
 *
 * Importing would mean building `apps/api` first, which makes a check about two
 * text files depend on a compiler. The declaration is a literal object of string
 * pairs and has to stay one for this to work — `theme.test.ts` asserts the same
 * parse, so a change of shape fails there rather than silently emptying this.
 */
async function consoleTokens() {
  const source = await readFile(path.join(here, '..', 'apps/api/src/console/theme.ts'), 'utf8')
  const block = source.match(
    /export const CONSOLE_TOKENS: Readonly<Record<string, string>> = \{([\s\S]*?)\n\}/,
  )
  if (block === null) throw new Error('CONSOLE_TOKENS not found in apps/api/src/console/theme.ts')

  const tokens = new Map()
  for (const [, name, value] of block[1].matchAll(/'(--k-[a-z0-9-]+)':\s*'([^']*)'/g)) {
    tokens.set(name, value)
  }
  if (tokens.size === 0) throw new Error('CONSOLE_TOKENS parsed as empty')
  return tokens
}

/**
 * The website's dark values: the first `:root` block, which is the dark one.
 * `:root[data-theme='light']` comes after it and is not read.
 */
async function websiteTokens(file) {
  const css = await readFile(file, 'utf8')
  const start = css.indexOf(':root,')
  if (start === -1) throw new Error(`no :root block in ${file}`)
  const light = css.indexOf("[data-theme='light']")
  const dark = css.slice(start, light === -1 ? undefined : light)

  const tokens = new Map()
  for (const [, name, value] of dark.matchAll(/(--k-[a-z0-9-]+):\s*([^;]+);/g)) {
    tokens.set(name, value.replace(/\s+/g, ' ').trim())
  }
  if (tokens.size === 0) throw new Error(`no --k-* declarations in ${file}`)
  return tokens
}

const ours = await consoleTokens()
const theirs = await websiteTokens(themePath)

const problems = []
for (const [name, value] of ours) {
  const upstream = theirs.get(name)
  if (upstream === undefined) {
    problems.push(`${name}: declared in the console, absent from the website's theme.css`)
  } else if (upstream !== value) {
    problems.push(`${name}: console has ${value}, website has ${upstream}`)
  }
}

if (problems.length > 0) {
  console.error(
    `The console's palette has drifted from kolonie-website (${problems.length} of ${ours.size} tokens):\n`,
  )
  for (const problem of problems) console.error(`  ${problem}`)
  console.error(
    '\nFix apps/api/src/console/theme.ts, or — if the website moved on purpose — copy the new values across.',
  )
  process.exit(1)
}

console.log(`Palette in step with kolonie-website: ${ours.size} tokens compared, none drifted.`)
