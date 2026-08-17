/**
 * Assert that every source file the build is supposed to emit actually has an
 * emitted `.js` next to it in `dist/`.
 *
 * ## Why this is not `npm run build`
 *
 * `#309` opened with a session that pulled `main`, ran `npm test`, and read six
 * failing workspaces as a broken `main`. Nothing was broken: `dist/` predated a
 * module, and the errors — `mintMemoryCode is not a function`, `Cannot read
 * properties of undefined`, a route answering 500 — named neither `dist` nor the
 * build. The fix for that was one line in `package.json`: the root `test` script
 * built first, and an incremental build is 1.4 s warm.
 *
 * **That half is gone, and the line with it (`#1156`).** Tests resolve their
 * sibling workspaces through the `@kolonie-ai/source` export condition now, so a
 * test never reads `dist` and a stale `dist` cannot produce the errors above.
 * `npm run test` no longer builds, and this script moved out of it and up beside
 * `npm run build` in `check` and `check:fast` — next to the thing it is about,
 * rather than in front of a suite that no longer depends on it.
 *
 * **The other half is why this file still exists, and it is the one nobody
 * would guess.** `dist` is still built, still published and still what
 * production runs. `tsc -b` decides a project is up to date from its
 * `.tsbuildinfo`, not from its outputs. Delete one emitted file and it says
 * *"Project … is up to date"* and emits nothing — measured 2026-08-04, on
 * `packages/core/dist/continuity/memory-code.js`:
 *
 * ```
 * $ rm packages/core/dist/continuity/memory-code.js
 * $ npm run build && ls packages/core/dist/continuity/memory-code.js
 * ls: cannot access '…': No such file or directory
 * ```
 *
 * So the one command an agent reaches for cannot repair it, and the failure looks
 * exactly like the one a build *does* fix. Building first would have left that
 * case failing with the same unreadable errors and an agent one step further from
 * the answer, because `npm run build` would now appear to have been tried.
 *
 * This script is the part that names it. It is a directory walk over eight
 * workspaces and costs about 50 ms, which is why it can sit in the fast loop.
 *
 * ## What it checks, and what it deliberately does not
 *
 * **Forward only: every expected output exists.** It does not check that `dist/`
 * has nothing extra. Every large workspace here carries orphaned `.js` from
 * sources that were renamed or deleted — 114 files against 80 sources in
 * `packages/core` on 2026-08-04 — and those are inert. A check that failed on
 * them would fail on `main` today and be switched off within a week.
 *
 * **It does not check content.** A truncated or half-written file passes. The
 * failure this exists for is an output that was never emitted or was removed;
 * detecting a corrupt one means reading every file, which is not a fast-loop
 * cost, and `tsc -b --force` is the answer to both.
 *
 * **The exclusions are read from each workspace's own `tsconfig.build.json`**
 * rather than restated here. They are the reason a test file has no output, and a
 * second copy of that list is a copy that goes out of step the first time somebody
 * adds one — which is the failure `#120` is named after in `kolonie-docs`.
 */
import console from 'node:console'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, URL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * One `tsconfig` exclude pattern as a regular expression, matched against a path
 * relative to the workspace.
 *
 * TypeScript's glob is larger than the three shapes this repository uses
 * (`src/**\/*.test.ts`, `src/**\/__fixtures__/**`, `src/test-worker-setup.ts`),
 * and the ones below are what it implements: `**\/` spans zero or more
 * directories, a trailing `**` spans the rest of the path, and `*` stops at a
 * separator. **An unsupported pattern throws rather than being ignored** — a
 * pattern this did not understand would exclude nothing, so a test file would
 * arrive as a missing output and the check would fail on a green tree.
 */
export const excludeToRegExp = (pattern) => {
  if (/[?[\]{}!+@()]/.test(pattern)) {
    throw new Error(`Unsupported exclude pattern ${JSON.stringify(pattern)} in a tsconfig`)
  }

  const source = pattern
    .split('/')
    .map((segment) => {
      if (segment === '**') return '\0'
      return segment.replaceAll(/[.^$|\\]/g, String.raw`\$&`).replaceAll('*', '[^/]*')
    })
    .join('/')
    // A `**` in the middle spans zero or more directories, so it takes the
    // following separator with it; one at the end spans everything that is left.
    .replaceAll('\0/', '(?:[^/]+/)*')
    .replaceAll('\0', '.*')

  return new RegExp(`^${source}$`)
}

/** Every file under `directory`, relative to it, in no particular order. */
const filesUnder = async (directory, prefix = '') => {
  const entries = await readdir(path.join(directory, prefix), { withFileTypes: true }).catch(
    () => undefined,
  )
  if (entries === undefined) return []

  const found = []
  for (const entry of entries) {
    const relative = path.join(prefix, entry.name)
    if (entry.isDirectory()) found.push(...(await filesUnder(directory, relative)))
    else found.push(relative)
  }
  return found
}

/**
 * The outputs a workspace's build owes, given its sources and its exclusions.
 *
 * Every `.ts` input emits a `.js`, including one that declares nothing but types:
 * `declaration` is on and `emitDeclarationOnly` is not, so there is no input that
 * legitimately produces no JavaScript. A `.d.ts` in `src` would be that exception
 * and this repository has none — if one arrives, it belongs on this line.
 */
export const expectedOutputs = (sources, excludePatterns) => {
  const excluded = excludePatterns.map(excludeToRegExp)

  return sources
    .filter((relative) => relative.endsWith('.ts') && !relative.endsWith('.d.ts'))
    .map((relative) => path.posix.join('src', relative.split(path.sep).join('/')))
    .filter((relative) => !excluded.some((pattern) => pattern.test(relative)))
    .map((relative) => `${relative.slice('src/'.length, -'.ts'.length)}.js`)
}

/** The expected outputs a workspace has not got. */
export const missingOutputs = (expected, present) => {
  const have = new Set(present)
  return expected.filter((relative) => !have.has(relative)).sort()
}

/**
 * One `tsconfig` as an object, whether or not it holds comments.
 *
 * **`tsconfig` files are JSONC, and this script assumed plain JSON.** It said so
 * out loud — *"these eight are plain JSON"* — and it held right up until `#1156`
 * put a `//` line above `customConditions` in every `tsconfig.build.json`. The
 * failure is worth naming because of where it lands: `check-dist` throws a
 * `SyntaxError` out of `JSON.parse` naming a position in a file the author was
 * not editing, in the middle of `npm run check`, after the build has already
 * passed. Nothing about it says *a comment in a tsconfig is what did this*.
 *
 * **`JSON.parse` first, and TypeScript's own parser only when that fails.**
 * `typescript` costs 405 ms to import, measured on CLAUDE002 on 2026-08-17, and
 * this script sits in `check:fast` at about 50 ms — so the common case must not
 * pay for it. A file with comments pays it once, and pays it to the same parser
 * `tsc` reads the file with, rather than to a comment stripper here that would
 * have to be right about `//` inside a string.
 *
 * A file that neither can read still throws, and deliberately: a workspace
 * quietly dropped from this check is the check not running.
 */
const readTsconfig = async (file) => {
  const text = await readFile(file, 'utf8')

  try {
    return JSON.parse(text)
  } catch {
    const ts = (await import('typescript')).default
    const { config, error } = ts.parseConfigFileTextToJson(file, text)
    if (error !== undefined) {
      throw new Error(
        `${file} is neither JSON nor JSONC: ${ts.flattenDiagnosticMessageText(error.messageText, ' ')}`,
      )
    }
    return config
  }
}

/** Every workspace with a `tsconfig.build.json`, which is every workspace that emits. */
const buildingWorkspaces = async (root) => {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  const found = []

  for (const pattern of manifest.workspaces ?? []) {
    const prefix = pattern.slice(0, -2)
    const entries = await readdir(path.join(root, prefix), { withFileTypes: true })

    for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort()) {
      const directory = path.join(prefix, entry.name)
      const file = path.join(root, directory, 'tsconfig.build.json')
      // Absent means this workspace does not emit, which is not a failure. Every
      // other reason the file cannot be read is one, and is thrown: a workspace
      // quietly dropped from this check is the check not running.
      const config = await readTsconfig(file).catch((cause) => {
        if (cause.code === 'ENOENT') return undefined
        throw cause
      })
      if (config === undefined) continue

      found.push({ directory, exclude: config.exclude ?? [] })
    }
  }

  return found
}

/** Every workspace whose `dist/` is missing something, with what is missing. */
export const distGaps = async (root = ROOT) => {
  const gaps = []

  for (const { directory, exclude } of await buildingWorkspaces(root)) {
    const sources = await filesUnder(path.join(root, directory, 'src'))
    const outputs = await filesUnder(path.join(root, directory, 'dist'))
    const missing = missingOutputs(
      expectedOutputs(sources, exclude),
      outputs.map((relative) => relative.split(path.sep).join('/')),
    )

    if (missing.length > 0) gaps.push({ directory, missing })
  }

  return gaps
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const gaps = await distGaps()

  if (gaps.length === 0) process.exit(0)

  console.error('dist/ is missing files the build owes it:\n')
  for (const { directory, missing } of gaps) {
    console.error(`  ${directory}/dist`)
    for (const relative of missing.slice(0, 10)) console.error(`    ${relative}`)
    if (missing.length > 10) console.error(`    … and ${missing.length - 10} more`)
  }

  console.error(
    [
      '',
      'The tests would fail against this with errors naming neither dist nor the',
      'build — a missing export reads as a broken import (#309).',
      '',
      '`npm run build` will NOT fix it: tsc -b reads .tsbuildinfo rather than the',
      'outputs, so it reports every project up to date and emits nothing. Run:',
      '',
      '    npx tsc -b --force',
      '',
    ].join('\n'),
  )
  process.exit(1)
}
