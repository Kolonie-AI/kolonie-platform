/**
 * The command between `check:fast`, which runs no tests, and `check`, which runs
 * for fifteen minutes (`#1157`).
 *
 * Format, lint and typecheck run over the whole repository — they are cheap and a
 * narrowed lint is a lint somebody will not trust. **Tests run only in the
 * workspaces the change can have reached**, which for an ordinary one-file edit is
 * one of ten.
 *
 * ## Affected is computed per workspace, not per module
 *
 * A changed file belongs to a workspace; that workspace and everything depending
 * on it runs, and nothing else does. Coarse and correct: an edit in `apps/api`
 * (228 test files) leaves `packages/db` (187) alone, and an edit in
 * `packages/core` correctly runs all ten, because all nine others depend on it.
 *
 * **`vitest --changed` is refused, and that is a decision rather than a
 * preference** (`#1157`). It walks the module graph and misses dynamic imports,
 * fixtures, migrations and anything data-driven — vitest's own tracker carries
 * `#3666`, *"`watch` + `--changed` is unreliable with unexpected DX"*. A gate that
 * silently under-tests is worse than no gate: a session reads green, pushes, and
 * pays the fifteen minutes anyway plus a wasted CI run. A later change that adds
 * it is arguing against this paragraph.
 *
 * ## What a file outside every workspace means
 *
 * Everything runs. `tsconfig.base.json`, `package-lock.json`, `.github/`,
 * `scripts/` — a change there can reach any workspace and frequently does, and
 * this file itself lives in one of those directories. The coarse answer is the
 * only honest one, and the output names the file that forced it so the reader is
 * not left wondering why a one-line edit ran everything.
 *
 * ## The base is origin/main, not HEAD
 *
 * A session that has made three commits on a branch must still see everything the
 * branch touched, so the comparison is against `origin/main` and includes
 * committed, staged, unstaged and untracked files alike. **Nothing is fetched**:
 * the ref is read as it stands, because a command that reaches the network is a
 * command that fails on a train.
 *
 * ## This is an inner-loop command and never the gate
 *
 * `npm run check` stays exactly what it is and stays what CI runs. Every path out
 * of this script says so on its last line, including the one where everything
 * passed — the point at which somebody is most likely to push.
 */
import { spawn } from 'node:child_process'
import console from 'node:console'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, URL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const SCOPE = '@kolonie'

/**
 * Every workspace, with the sibling workspaces it depends on.
 *
 * Dependencies are matched by package name and both `dependencies` and
 * `devDependencies` count: a workspace that only ever imports a sibling from its
 * tests is still a workspace that a change to that sibling can break.
 */
export const graphFrom = async (root = ROOT) => {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  const found = []

  for (const pattern of manifest.workspaces ?? []) {
    if (!pattern.endsWith('/*')) {
      throw new Error(`Unsupported workspace pattern ${JSON.stringify(pattern)} in package.json`)
    }

    const prefix = pattern.slice(0, -2)
    const entries = await readdir(path.join(root, prefix), { withFileTypes: true })

    for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort()) {
      const directory = path.join(prefix, entry.name)
      const own = await readFile(path.join(root, directory, 'package.json'), 'utf8').catch(
        () => undefined,
      )
      if (own === undefined) continue

      const parsed = JSON.parse(own)
      if (parsed.scripts?.test === undefined) continue

      const dependsOn = Object.keys({ ...parsed.dependencies, ...parsed.devDependencies }).filter(
        (name) => name.startsWith(SCOPE),
      )

      found.push({ directory, name: parsed.name, dependsOn })
    }
  }

  return found
}

/** The workspace a path belongs to, or `undefined` if it belongs to none. */
export const workspaceOf = (file, graph) =>
  graph.find((node) => file === node.directory || file.startsWith(`${node.directory}/`))

/**
 * The named workspaces plus everything that depends on them, transitively.
 *
 * Walked to a fixed point rather than one level deep. `packages/core` is depended
 * on directly by nine workspaces, but a two-level graph would already be wrong
 * the day somebody adds a package that only reaches `core` through `db`.
 */
export const withDependents = (directories, graph) => {
  const reached = new Set(directories)

  for (let changed = true; changed;) {
    changed = false
    for (const node of graph) {
      if (reached.has(node.directory)) continue
      const dependsOnReached = node.dependsOn.some((name) =>
        graph.some((other) => other.name === name && reached.has(other.directory)),
      )
      if (dependsOnReached) {
        reached.add(node.directory)
        changed = true
      }
    }
  }

  return [...reached].sort()
}

/**
 * What to run, given the changed paths.
 *
 * Pure, and the whole of the decision — so the shapes that matter (nothing
 * changed, one workspace, a root file, a file in `packages/core`) are testable
 * without a git repository or a spawned process.
 */
export const affectedFrom = (files, graph) => {
  if (files.length === 0) {
    return { nothing: true, everything: false, directories: [], skipped: allOf(graph) }
  }

  const outside = files.find((file) => workspaceOf(file, graph) === undefined)
  if (outside !== undefined) {
    return {
      nothing: false,
      everything: true,
      because: outside,
      directories: allOf(graph),
      skipped: [],
    }
  }

  const changed = [...new Set(files.map((file) => workspaceOf(file, graph).directory))]
  const directories = withDependents(changed, graph)

  return {
    nothing: false,
    everything: false,
    directories,
    skipped: allOf(graph).filter((directory) => !directories.includes(directory)),
  }
}

const allOf = (graph) => graph.map((node) => node.directory).sort()

/**
 * The last line, on every path out of this script.
 *
 * **Including the one where everything passed**, which is the point at which
 * somebody is most likely to push. A command that answers in forty seconds and
 * does not say what it skipped is a command that will be mistaken for the gate.
 */
export const closingLine = ({ everything, skipped }) =>
  everything
    ? 'Every workspace ran. This is still not npm run check: it ran no migrations check and no changelog check.'
    : `Skipped ${skipped.length === 0 ? 'nothing' : skipped.join(', ')}. ` +
      'Run npm run check before you push.'

const run = (command, args) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: 'inherit' })
    // A process killed by a signal exits with a null code. Treating that as
    // anything but a failure is how an out-of-memory kill becomes a green run.
    child.on('close', (code, signal) => resolve(signal === null ? code === 0 : false))
    child.on('error', () => resolve(false))
  })

const gitLines = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    child.stderr.on('data', (chunk) => (err += chunk))
    child.on('close', (code) =>
      code === 0
        ? resolve(out.split('\n').filter((line) => line !== ''))
        : reject(new Error(`git ${args.join(' ')} failed: ${err.trim()}`)),
    )
    child.on('error', reject)
  })

/**
 * Everything that differs from `origin/main`, committed or not.
 *
 * Three questions rather than one: `diff` covers committed and staged and
 * unstaged changes against the base, and `ls-files --others` covers the file
 * somebody has just written and not yet added — which is the commonest shape of
 * all for a new test.
 */
export const changedAgainstBase = async (base = 'origin/main') => {
  await gitLines(['rev-parse', '--verify', `${base}^{commit}`]).catch(() => {
    throw new Error(
      `${base} does not exist here. Fetch it once — this command deliberately does not.`,
    )
  })

  const [tracked, untracked] = await Promise.all([
    gitLines(['diff', '--name-only', base, '--']),
    gitLines(['ls-files', '--others', '--exclude-standard']),
  ])

  return [...new Set([...tracked, ...untracked])].sort()
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const graph = await graphFrom()

  const files = await changedAgainstBase().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })

  const affected = affectedFrom(files, graph)

  console.log(`${files.length} file(s) differ from origin/main.`)
  if (affected.nothing) {
    console.log('Nothing changed, so no tests will run. Format, lint and types still will.')
  } else if (affected.everything) {
    console.log(`${affected.because} belongs to no workspace, so every workspace's tests run.`)
  } else {
    console.log(`Tests will run in: ${affected.directories.join(', ')}`)
  }
  console.log()

  const gates = await run('node', ['scripts/run-gates.mjs', 'format:check', 'lint', 'typecheck'])

  // The tests run even when a gate failed, and both answers are reported. Whoever
  // is running this wants to know everything that is wrong in one pass — that is
  // the entire argument of `#1158`, and it does not stop being true one script up.
  const tests = affected.nothing
    ? true
    : await run('node', [
        'scripts/run-workspace-script.mjs',
        'test',
        ...(affected.everything ? [] : affected.directories),
      ])

  console.log(`\n${closingLine(affected)}`)

  process.exit(gates && tests ? 0 : 1)
}
