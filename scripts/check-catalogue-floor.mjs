/**
 * The half of the catalogue ratchet that reads history (`#1118`).
 *
 * ## The rule this runs, and why it had no runner
 *
 * `#889` wrote down that raising the floor takes a commit message naming
 * [the catalogue encodes grammar, never vocabulary](https://github.com/Kolonie-AI/kolonie-docs/blob/main/state/decisions/the-catalogue-encodes-grammar-never-vocabulary.md)
 * and saying what the new tools are vocabulary-free for. It shipped that rule as
 * `raiseIsJustified`, with unit tests, and **no caller** — so in practice the
 * floor was a number in a JSON file, and moving it took whatever the author was
 * willing to type, checked by nobody. This is the caller.
 *
 * It finds the last commit that touched `catalogue-budget.json`, reads the file
 * on both sides of it, and hands the pair with that commit's message to
 * `floorChangeVerdict`. A raise with no sentence exits non-zero.
 *
 * ## Why it is its own entry point
 *
 * `scripts/check-catalogue-budget.mjs` measures, and measuring the served
 * catalogue needs a database and a vitest run. This needs neither: it is `git`
 * and a string test, so it costs a second and can sit in `npm run check` where
 * everybody runs it. Splitting them also splits what they can each see —
 * measuring happens *before* the commit exists, and judging the commit can only
 * happen after.
 *
 * ## What it deliberately cannot catch
 *
 * **An uncommitted raise.** The message it judges is written after the number
 * moves, so a working tree with an edited floor has nothing to judge yet. It
 * says so and passes; the commit that follows is what the next run reads, and
 * CI reads it on the branch where amending is still ordinary.
 *
 * **A raise dressed in the right words.** The check is two `includes` and knows
 * it (`raiseIsJustified` says so at length). What it makes impossible is the
 * ordinary case: the floor moving because a check was failing and moving it was
 * the quickest way to a green run.
 *
 * **Anything, in a repository without history.** A shallow clone or an export
 * has no previous version to compare against. It reports what it could not read
 * and exits zero rather than failing a build over the checkout depth.
 */
import console from 'node:console'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, URL, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const RELATIVE = 'apps/api/src/mcp/catalogue-budget.json'
const BUDGET = path.join(ROOT, ...RELATIVE.split('/'))

/** Run `git` and hand back its output, or `undefined` if it had nothing to say. */
const git = (...args) => {
  const run = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' })
  if (run.status !== 0 || typeof run.stdout !== 'string') return undefined
  return run.stdout
}

/** The rule itself, from the built api — the same module the suite tests. */
let floorChangeVerdict
try {
  ;({ floorChangeVerdict } = await import(
    pathToFileURL(path.join(ROOT, 'apps', 'api', 'dist', 'mcp', 'catalogue-budget.js')).href
  ))
} catch {
  console.error(
    'The catalogue floor rule was not built: apps/api/dist/mcp/catalogue-budget.js is missing.\n' +
      'Run `npm run build` first. This check reads the compiled module rather than reimplementing\n' +
      'it, so that the rule the suite tests and the rule CI enforces cannot drift apart.',
  )
  process.exit(1)
}

const totalsOf = (json, where) => {
  const parsed = JSON.parse(json)
  if (typeof parsed.tools !== 'number' || typeof parsed.bytes !== 'number') {
    throw new Error(`${where} has no tools/bytes pair`)
  }
  return { tools: parsed.tools, bytes: parsed.bytes }
}

if (git('rev-parse', '--git-dir') === undefined) {
  console.log(`Not a git checkout, so there is no commit to judge. ${RELATIVE} left unchecked.`)
  process.exit(0)
}

const log = git('log', '-1', '--format=%H%n%B', '--', RELATIVE)
if (log === undefined || log.trim() === '') {
  console.log(
    `No commit in this checkout touches ${RELATIVE} — a shallow clone, or a floor that has\n` +
      'never moved here. Nothing to judge.',
  )
  process.exit(0)
}

const [sha, ...messageLines] = log.split('\n')
const message = messageLines.join('\n')

const after = git('show', `${sha}:${RELATIVE}`)
const before = git('show', `${sha}^:${RELATIVE}`)

if (after === undefined) {
  console.log(`${RELATIVE} could not be read at ${sha.slice(0, 8)}. Nothing to judge.`)
  process.exit(0)
}

if (before === undefined) {
  // The commit that introduced the floor, or the first one this clone has. There
  // is no earlier figure to have been raised from.
  console.log(
    `${sha.slice(0, 8)} is the first commit here that carries ${RELATIVE}, so there is no\n` +
      'previous floor to compare it against.',
  )
  process.exit(0)
}

const verdict = floorChangeVerdict(
  totalsOf(before, `${RELATIVE} before ${sha.slice(0, 8)}`),
  totalsOf(after, `${RELATIVE} at ${sha.slice(0, 8)}`),
  message,
)

const working = totalsOf(readFileSync(BUDGET, 'utf8'), RELATIVE)
const committed = totalsOf(after, RELATIVE)
const uncommitted = working.tools !== committed.tools || working.bytes !== committed.bytes

if (!verdict.allowed) {
  console.error(`${sha.slice(0, 8)} — ${verdict.message}`)
  process.exit(1)
}

console.log(`${sha.slice(0, 8)} — ${verdict.message}`)

if (uncommitted) {
  // Not a failure: the message that would justify it does not exist yet. Saying
  // so is the whole of what can be done here, and saying nothing is what let the
  // floor move unremarked in the first place.
  console.log(
    `${RELATIVE} is edited and not committed: ${working.tools} tools and ${working.bytes} bytes\n` +
      `against ${committed.tools} and ${committed.bytes} in ${sha.slice(0, 8)}. ` +
      'The commit that lands it is what the next run judges.',
  )
}
