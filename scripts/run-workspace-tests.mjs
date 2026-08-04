/**
 * Run every workspace's tests at once instead of one after another.
 *
 * **`npm run test --workspaces` is serial** (`#285`). Seven vitest processes
 * started, ran and exited in the order the workspaces happen to be listed, and
 * six of the seven need no database at all — they waited behind the one that does
 * for no reason but that ordering. Measured on CLAUDE002 (8 vCPU, 7.2 GiB RAM) on
 * 2026-08-04: the whole suite took 9 min 19 s while the machine averaged 83% of a
 * possible 800% CPU, roughly one core of eight.
 *
 * ## The thing that must not regress
 *
 * A concurrent runner has one failure mode a serial one does not: **losing a
 * failure.** `npm run test --workspaces` fails the moment a workspace does,
 * because it is a shell chain. Here every workspace runs to completion and the
 * verdict is assembled afterwards, so an exit code that reports the last process
 * to finish — or the runner's own health — turns a red suite green.
 *
 * That is not a hypothetical in this repository. `npm run check` piped into
 * `grep` reports the grep's exit code and not the chain's, and Prettier fails
 * with a lowercase `[warn]` that a filter looking for `error` swallows; the
 * off-repo note about it exists because somebody read a green exit code off a
 * command that had failed. {@link verdictFrom} is the same trap one layer up, and
 * it is tested rather than trusted.
 *
 * ## Ordering, and what the reader gets
 *
 * Output is buffered per workspace and printed in one block when that workspace
 * finishes, under a banner naming it. Interleaving seven vitest reporters line by
 * line would make every line ambiguous — and the whole point of a test log is to
 * tell you *where* something failed. The closing summary is printed in declared
 * order rather than finishing order, so two runs of the same suite read the same
 * way even when the workspaces finish in a different sequence.
 */
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import console from 'node:console'
import { readdir, readFile } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import path from 'node:path'
import process from 'node:process'
// `Buffer`, `console`, `process` and `URL` are Node globals, imported rather than
// reached for: the eslint config declares no environment for a script, and one
// import line is cheaper than a config block per file. The storage barrel's
// generator does the same, for the same reason.
import { fileURLToPath, URL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * How many workspaces run at once.
 *
 * **A quarter of the cores, and that is not conservatism — it is the measurement.**
 * These processes are not the leaves: each spawns a vitest that fans out to
 * workers of its own, so the real concurrency is this number multiplied by
 * something like the core count again. On CLAUDE002 (8 vCPU, 7.2 GiB RAM), whole
 * suite, 2026-08-04:
 *
 * | at once | wall | peak memory |
 * |---------|------|-------------|
 * | 2       | 97.8 s | 4.6 GiB   |
 * | 3       | 102.9 s | 4.8 GiB  |
 * | 4       | 103.0 s | 4.8 GiB, and swap touched |
 *
 * Going wider was slower *and* hungrier, which is the signature of oversubscription
 * rather than of a bad cap. `packages/db` alone finishes in 72 s; the extra 26 s
 * here is what it pays for sharing the machine, and widening the runner makes that
 * worse rather than better.
 *
 * The ceiling is memory, not cores. A machine that swaps during a test run is
 * slower than the serial version this replaced and much harder to reason about.
 */
const CONCURRENCY = Math.max(1, Math.min(4, Math.floor(availableParallelism() / 4)))

/** Every unit of work that has tests, in the order declared. */
const workspacesWithTests = async () => {
  const manifest = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'))
  const found = []

  // The root's own tests — the tests of the scripts in this directory, including
  // this file's. A different script name, because `test` at the root is what runs
  // this runner and asking it to run itself is a fork bomb with a summary table.
  if (manifest.scripts?.['test:scripts'] !== undefined) {
    found.push({ name: `${manifest.name} (scripts)`, directory: '.', script: 'test:scripts' })
  }

  for (const pattern of manifest.workspaces ?? []) {
    if (!pattern.endsWith('/*')) {
      // Every pattern this repository has ever used is `prefix/*`. Refusing the
      // rest is better than half-supporting them: a glob this does not understand
      // would silently contribute no workspaces, and a suite that stops running a
      // third of itself looks exactly like a suite that got faster.
      throw new Error(`Unsupported workspace pattern ${JSON.stringify(pattern)} in package.json`)
    }

    const prefix = pattern.slice(0, -2)
    const entries = await readdir(path.join(ROOT, prefix), { withFileTypes: true })

    for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort()) {
      const directory = path.join(prefix, entry.name)
      const own = await readFile(path.join(ROOT, directory, 'package.json'), 'utf8').catch(
        () => undefined,
      )
      if (own === undefined) continue

      const parsed = JSON.parse(own)
      // `--if-present` is what the serial command used to do, and dropping a
      // workspace that has no tests is not the same as failing on it.
      if (parsed.scripts?.test !== undefined) found.push({ name: parsed.name, directory })
    }
  }

  return found
}

/** Run one workspace to completion, keeping its output to itself until it is done. */
const runWorkspace = ({ name, directory, script = 'test' }) =>
  new Promise((resolve) => {
    const started = Date.now()
    const child = spawn('npm', ['run', script], {
      cwd: path.join(ROOT, directory),
      // Inherited, so DATABASE_URL and the rest reach the workspace unchanged.
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const chunks = []
    child.stdout.on('data', (chunk) => chunks.push(chunk))
    child.stderr.on('data', (chunk) => chunks.push(chunk))

    const finish = (code) =>
      resolve({
        name,
        directory,
        ok: code === 0,
        seconds: (Date.now() - started) / 1000,
        output: Buffer.concat(chunks).toString('utf8'),
      })

    // A process killed by a signal exits with a null code. Treating that as
    // anything but a failure is how an out-of-memory kill becomes a green run.
    child.on('close', (code, signal) => finish(signal === null ? code : 1))
    child.on('error', (error) => {
      chunks.push(Buffer.from(`could not start npm in ${directory}: ${error.message}\n`))
      finish(1)
    })
  })

/**
 * The exit code, given what every workspace did.
 *
 * Separated from the running so it can be tested without spawning anything —
 * this is the sentence that decides whether a red suite is reported red.
 */
export const verdictFrom = (results) => ({
  failed: results.filter((result) => !result.ok).map((result) => result.name),
  code: results.every((result) => result.ok) ? 0 : 1,
})

/** Run `limit` at a time, resolving in the order the tasks were given. */
const inBatches = async (items, limit, run) => {
  const results = new Array(items.length)
  let next = 0

  const worker = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await run(items[index])
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const workspaces = await workspacesWithTests()

  if (workspaces.length === 0) {
    console.error('No workspace has a test script. That is not a pass.')
    process.exit(1)
  }

  console.log(`running ${workspaces.length} workspaces, ${CONCURRENCY} at a time\n`)

  const results = await inBatches(workspaces, CONCURRENCY, async (workspace) => {
    const result = await runWorkspace(workspace)
    const verdict = result.ok ? 'passed' : 'FAILED'
    console.log(`${'─'.repeat(72)}\n${result.name} — ${verdict} in ${result.seconds.toFixed(1)}s`)
    console.log(`${'─'.repeat(72)}`)
    console.log(result.output.trimEnd())
    console.log()
    return result
  })

  const { failed, code } = verdictFrom(results)

  console.log('═'.repeat(72))
  for (const result of results) {
    console.log(`  ${result.ok ? 'pass' : 'FAIL'}  ${result.name} (${result.seconds.toFixed(1)}s)`)
  }
  console.log('═'.repeat(72))

  if (code !== 0) {
    console.error(`\n${failed.length} workspace(s) failed: ${failed.join(', ')}`)
  }

  process.exit(code)
}
