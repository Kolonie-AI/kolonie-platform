/**
 * Run several npm scripts at once and report all of their answers, rather than
 * stopping at the first one that fails.
 *
 * ## Why this exists
 *
 * `npm run check` was ten steps joined by `&&` (`#1158`). **Five of them depend on
 * nothing but the working tree** — `check:lock`, `format:check`, `lint`,
 * `check:fixtures`, `check:changelog` — and ran one after another for no reason
 * but the order somebody typed them in. Four more depend only on the build:
 * `check:dist`, `check:catalogue-floor`, `check:migrations` and `typecheck`.
 * `check:migrations` reads `@kolonie-ai/core`'s `dist` (`#1367`); hoisted into
 * the tree phase it reported a missing migration that did not exist, against a
 * stale build.
 *
 * A shell chain also loses answers. `check:lock && format:check && lint` tells
 * you the lock file is stale and nothing about the other two, so a session fixes
 * one thing, runs the chain again, and finds the next — which is the slowest
 * possible way to learn six facts that were all knowable at once.
 *
 * ## The thing that must not regress
 *
 * **Losing a failure.** A chain fails the moment a step does, because that is
 * what `&&` means. Here every gate runs to completion and the verdict is
 * assembled afterwards, so an exit code that reports the last process to finish —
 * or this runner's own health — turns a red check green. That is not
 * hypothetical in this repository: Prettier fails with a lowercase `[warn]` that
 * a filter looking for `error` swallows, and somebody has already read a green
 * exit code off a command that had failed.
 *
 * {@link verdictFrom} is that sentence, and it is shared with
 * `scripts/run-workspace-script.mjs` rather than copied — the copies would drift,
 * and the one they would drift on is the one that decides whether red is
 * reported red.
 *
 * ## Ordering, and what the reader gets
 *
 * Output is buffered per gate and printed in **declared** order once the phase
 * finishes, never in finishing order and never interleaved. Six streams merged
 * line by line would make every line ambiguous, and two runs of the same phase
 * would read differently depending on which gate happened to be quick. A short
 * progress line is printed as each one lands, so a phase that takes half a minute
 * is not silent — but it carries a verdict and a duration, never the gate's own
 * output.
 *
 * ## What this deliberately does not do
 *
 * **It does not know which gates may run together.** The caller names them, and
 * the ordering that matters is asserted in `scripts/run-gates.test.ts` against
 * `package.json` itself: `check:catalogue-floor` reads
 * `apps/api/dist/mcp/catalogue-budget.js`, `check:dist` reads every `dist/`, and
 * `check:migrations` reads `@kolonie-ai/core`'s `dist` (`#1367`), so all three
 * belong after `build`. A phase that hoisted them in front of it would fail with
 * a message about the wrong thing entirely.
 */
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import console from 'node:console'
import process from 'node:process'
// `Buffer`, `console`, `process` and `URL` are Node globals, imported rather than
// reached for: the eslint config declares no environment for a script, and one
// import line is cheaper than a config block per file. The workspace runner and
// the storage barrel's generator do the same, for the same reason.
import { fileURLToPath, URL } from 'node:url'

import { verdictFrom } from './run-workspace-script.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * The gates to run, from the command line.
 *
 * **Required, and an empty list is a failure rather than a pass.** A phase that
 * names no gate is a `package.json` somebody edited badly, and reporting it green
 * would mean six checks silently stopped running — the failure this whole file is
 * written to avoid, one level up.
 */
export const gatesFrom = (argv) => argv.filter((argument) => !argument.startsWith('-'))

/** Run one gate to completion, keeping its output to itself until it is done. */
const runGate = (name, env = process.env) =>
  new Promise((resolve) => {
    const started = Date.now()
    const child = spawn('npm', ['run', name], {
      cwd: ROOT,
      // This process's environment unchanged, so DATABASE_URL reaches
      // check:migrations and the lint cache reaches the two that use it.
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const chunks = []
    child.stdout.on('data', (chunk) => chunks.push(chunk))
    child.stderr.on('data', (chunk) => chunks.push(chunk))

    const finish = (code) =>
      resolve({
        name,
        ok: code === 0,
        seconds: (Date.now() - started) / 1000,
        output: Buffer.concat(chunks).toString('utf8'),
      })

    // A process killed by a signal exits with a null code. Treating that as
    // anything but a failure is how an out-of-memory kill becomes a green run.
    child.on('close', (code, signal) => finish(signal === null ? code : 1))
    child.on('error', (error) => {
      chunks.push(Buffer.from(`could not start npm run ${name}: ${error.message}\n`))
      finish(1)
    })
  })

const RULE = '─'.repeat(72)
const DOUBLE = '═'.repeat(72)

/**
 * Everything the reader sees once a phase is over, as one string.
 *
 * **Pure, and given the results in declared order**, so the test can hand it
 * finishing orders that differ from the declared one and assert that what is
 * printed does not change. A reader comparing two runs of the same phase is
 * usually comparing them line by line.
 */
export const report = (results) => {
  const lines = []

  for (const result of results) {
    lines.push(RULE, `${result.name} — ${result.ok ? 'passed' : 'FAILED'}`, RULE)
    // A gate that passes quietly still gets a banner. "It printed nothing" and
    // "it did not run" look identical otherwise, and only one of them is fine.
    lines.push(result.output.trim() === '' ? '(no output)' : result.output.trimEnd(), '')
  }

  lines.push(DOUBLE)
  for (const result of results) {
    lines.push(`  ${result.ok ? 'pass' : 'FAIL'}  ${result.name} (${result.seconds.toFixed(1)}s)`)
  }
  lines.push(DOUBLE)

  const { failed } = verdictFrom(results)
  // One failing gate per line, named. A reader scrolling back through six blocks
  // of output needs the answer in a form `grep` can find.
  for (const name of failed) lines.push(`FAILED: ${name}`)

  return lines.join('\n')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const gates = gatesFrom(process.argv.slice(2))

  if (gates.length === 0) {
    console.error(
      'Name the npm scripts to run, e.g. `node scripts/run-gates.mjs lint format:check`.',
    )
    process.exit(1)
  }

  console.log(`running ${gates.length} gates at once: ${gates.join(', ')}\n`)

  const results = await Promise.all(
    gates.map(async (name) => {
      const result = await runGate(name)
      // Progress, in finishing order, carrying a verdict and nothing else. The
      // output itself is held back so the blocks below stay in declared order.
      console.log(
        `  ${result.ok ? 'pass' : 'FAIL'}  ${result.name} (${result.seconds.toFixed(1)}s)`,
      )
      return result
    }),
  )

  console.log(`\n${report(results)}`)

  const { code } = verdictFrom(results)
  process.exit(code)
}
