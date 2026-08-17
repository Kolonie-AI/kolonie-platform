/**
 * Run one npm script across every workspace that has it, at once instead of one
 * after another.
 *
 * **Two callers, and the second is why this file is named for a script rather than
 * for the tests** (`#303`). `npm run test --workspaces` was serial and `#285` fixed
 * it here; `npm run typecheck --workspaces --if-present` was serial for the same
 * reason, one line further down `npm run check`, and had become the largest
 * non-test stage of it at 46.2 s. Writing a second runner would have meant two
 * copies of the one property either of them must have — see *The thing that must
 * not regress* below — and the copies would have drifted.
 *
 * **`npm run <script> --workspaces` is serial.** For the tests (`#285`): seven vitest processes
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

import { shareOfMachine, WORKER_BUDGET_VAR } from './test-workers.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * How many workspaces run at once, per script — **and the two numbers differ
 * because the work below them has a different shape.**
 *
 * These processes are not the leaves. A `test` process spawns a vitest that fans
 * out to workers of its own, so the real concurrency is the number here
 * multiplied by something like the core count again; a `typecheck` process is one
 * `tsc`, which is single-threaded per project and fans out to nothing. A single
 * shared constant would therefore be wrong for one of them whichever value it
 * held, and the two are kept apart rather than averaged.
 *
 * **`test` — a quarter of the cores.** On CLAUDE002 (8 vCPU, 7.2 GiB RAM), whole
 * suite, 2026-08-04 (`#285`):
 *
 * | at once | wall | peak memory |
 * |---------|------|-------------|
 * | 2       | 97.8 s | 4.6 GiB   |
 * | 3       | 102.9 s | 4.8 GiB  |
 * | 4       | 103.0 s | 4.8 GiB, and swap touched |
 *
 * **`typecheck` — half of them.** Same machine, eight workspaces, 2026-08-04,
 * two rounds, warm build state (`#303`). Serial, which is what this replaced:
 * **46.2 s**.
 *
 * | at once | wall | peak memory used |
 * |---------|------|------------------|
 * | 2       | 24.2 s, 23.9 s | 2.8 GiB |
 * | 4       | **18.4 s, 18.9 s** | 3.3 GiB |
 * | 8       | 20.2 s, 20.2 s | 3.8 GiB |
 *
 * Eight was slower *and* hungrier than four in both rounds, which is the same
 * signature `#285` found one table up and the reason neither number is simply
 * *all of them*. Swap was untouched at every setting.
 *
 * A script with no entry here runs one at a time. That is the safe direction for
 * an unmeasured caller: slow is recoverable, and a machine that swaps during a
 * check is slower than the serial version this replaced and much harder to reason
 * about.
 */
const CONCURRENCY = {
  test: Math.max(1, Math.min(4, Math.floor(availableParallelism() / 4))),
  typecheck: Math.max(1, Math.min(8, Math.floor(availableParallelism() / 2))),
}

/** How many to run at once for a script nobody has measured: one. */
const concurrencyFor = (script) => CONCURRENCY[script] ?? 1

/**
 * Every unit of work that has this script, in the order declared.
 *
 * **A workspace without the script is dropped rather than failed**, which is what
 * `--if-present` did and is not the same as passing it: `packages/core` has no
 * `typecheck:integration` and never will, and a runner that treated that as a
 * failure would make adding a script to one workspace a change to all of them.
 */
export const workspacesWithScript = async (script, root = ROOT) => {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  const found = []

  /**
   * The root's own tests, which are the tests of the scripts in this directory,
   * including this file's. A different script name, because `test` at the root is
   * what runs this runner and asking it to run itself is a fork bomb with a
   * summary table.
   *
   * **Only for `test`.** The root has no `typecheck` of its own — `scripts/` is
   * deliberately outside the TypeScript project, which is why this file is `.mjs`
   * and its test says `@ts-expect-error` over the import. A rule that pulled the
   * root in for every script would have this runner typecheck a directory that has
   * no `tsconfig.json`.
   */
  if (script === 'test' && manifest.scripts?.['test:scripts'] !== undefined) {
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
    const entries = await readdir(path.join(root, prefix), { withFileTypes: true })

    for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort()) {
      const directory = path.join(prefix, entry.name)
      const own = await readFile(path.join(root, directory, 'package.json'), 'utf8').catch(
        () => undefined,
      )
      if (own === undefined) continue

      const parsed = JSON.parse(own)
      if (parsed.scripts?.[script] !== undefined)
        found.push({ name: parsed.name, directory, script })
    }
  }

  return found
}

/**
 * What each child gets on top of this process's environment.
 *
 * **Only `test` gets a worker budget, and only because only `test` has workers.**
 * A `tsc` is one process and divides into nothing; publishing a budget to it
 * would be a number nobody reads. See `scripts/test-workers.mjs` for what the
 * workspaces do with it and for the measurements that made it necessary — in
 * short, this runner sizes itself from the core count and so does each vitest
 * below it, and before `#963` nothing multiplied the two together.
 */
export const environmentFor = (script, concurrency, env = process.env) =>
  script === 'test'
    ? { ...env, [WORKER_BUDGET_VAR]: String(shareOfMachine(concurrency)) }
    : { ...env }

/** Run one workspace to completion, keeping its output to itself until it is done. */
const runWorkspace = ({ name, directory, script }, env = process.env) =>
  new Promise((resolve) => {
    const started = Date.now()
    const child = spawn('npm', ['run', script], {
      cwd: path.join(ROOT, directory),
      // This process's environment plus the budget, so DATABASE_URL and the rest
      // reach the workspace unchanged.
      env,
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

/**
 * Which script to run, from the command line.
 *
 * **Required rather than defaulted to `test`.** A default would make
 * `node scripts/run-workspace-script.mjs` — the command somebody types when they
 * are guessing — run the whole test suite, and the argument is one word.
 */
export const scriptFrom = (argv) => {
  const [script] = argv
  if (script === undefined || script.startsWith('-')) return undefined
  return script
}

/**
 * Which workspaces to run it in, from everything after the script name.
 *
 * **Empty means all of them**, which is what every caller but one wants and what
 * this file did before the filter existed. `scripts/check-affected.mjs` (`#1157`)
 * is the exception: it works out which workspaces a change can have reached and
 * names them here, so that a one-file edit in `apps/api` does not run
 * `packages/db`'s 187 test files.
 *
 * Directories rather than package names — `apps/api`, not `@kolonie-ai/api`. The
 * caller is mapping changed *paths* to workspaces, so paths are what it holds,
 * and one of the ten packages is named `@kolonie.ai/mcp` with a dot where the
 * other nine have a dash.
 */
export const onlyFrom = (argv) => argv.slice(1).filter((argument) => !argument.startsWith('-'))

/**
 * Keep the named workspaces, and refuse a name that matches nothing.
 *
 * **A filter that quietly selects nothing is the failure this whole file exists
 * to avoid**, one level up: a typo would report a green run over an empty list
 * instead of the tests somebody asked for. So an unknown directory throws rather
 * than narrowing the run.
 */
export const only = (workspaces, directories) => {
  if (directories.length === 0) return workspaces

  const known = new Set(workspaces.map((workspace) => workspace.directory))
  const unknown = directories.filter((directory) => !known.has(directory))
  if (unknown.length > 0) {
    throw new Error(
      `No workspace with that script in: ${unknown.join(', ')}. ` +
        `Known: ${[...known].sort().join(', ')}`,
    )
  }

  const wanted = new Set(directories)
  return workspaces.filter((workspace) => wanted.has(workspace.directory))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2)
  const script = scriptFrom(argv)

  if (script === undefined) {
    console.error('Name the npm script to run, e.g. `node scripts/run-workspace-script.mjs test`.')
    process.exit(1)
  }

  const all = await workspacesWithScript(script)

  if (all.length === 0) {
    console.error(`No workspace has a ${script} script. That is not a pass.`)
    process.exit(1)
  }

  let workspaces
  try {
    workspaces = only(all, onlyFrom(argv))
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }

  const concurrency = concurrencyFor(script)
  const environment = environmentFor(script, concurrency)
  const budget = environment[WORKER_BUDGET_VAR]

  console.log(
    `running ${script} in ${workspaces.length} workspaces, ${concurrency} at a time` +
      // Printed rather than kept to itself: when a workspace times out, the first
      // question is how much of the machine it actually had.
      (budget === undefined ? '' : `, up to ${budget} test workers each`) +
      '\n',
  )

  const results = await inBatches(workspaces, concurrency, async (workspace) => {
    const result = await runWorkspace(workspace, environment)
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
