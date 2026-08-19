/**
 * How many test workers one workspace may start while the others are running.
 *
 * **The defect this exists to close** (`#963`). Two numbers decide how many
 * processes a `npm run test` puts on the machine, and until this file neither of
 * them knew about the other. `run-workspace-script.mjs` sizes the number of
 * *workspaces* running at once from the core count; each workspace's vitest then
 * sizes its own pool of *workers* from the core count again. The product is what
 * lands on the machine, and nobody owned it.
 *
 * On CLAUDE002 (8 vCPU, 7.2 GiB) that product is 2 × (6 + 7) = thirteen Node
 * processes and six Postgres backends. Measured on 2026-08-15, before this file:
 *
 * | run | `packages/db` | `apps/api` | peak memory | verdict |
 * |---|---|---|---|---|
 * | alone, as a pair | 218 s | 131 s | — | both green |
 * | through the runner | 456 s | 368 s | 7079 MiB | **both red** |
 *
 * Every failure in that run was a clock — nine `Hook timed out in 10000ms`, four
 * `Test timed out in 5000ms`, two at 30000ms — and `sys` time exceeded `user`
 * time (7m20s against 5m30s), which is a machine swapping rather than a machine
 * working.
 *
 * **Why CI never sees it, and why that matters.** CI runs the same
 * `npm run check` on a four-core runner, so `Math.floor(4 / 4)` is 1 and the
 * workspaces go one at a time. The contention is not something CI has and this
 * machine lacks; it is something that switches on above four cores. A local
 * check that is red for a reason CI cannot reproduce is a check whose red
 * carries no information, which is the whole complaint in `#963`.
 *
 * ## Why a ceiling and not an assignment
 *
 * The runner knows how many workspaces it is starting; it does not know what any
 * of them is doing. `packages/db` caps itself at six workers because every worker
 * holds a connection pool and a Postgres backend, and that cap is about memory
 * rather than cores. A number pushed down from the runner must therefore be able
 * to *lower* that six and never to raise it — on a thirty-two-core machine an
 * assignment would hand `packages/db` eight workers and overrule the one comment
 * in this repository that measured what happens next.
 *
 * So the runner publishes a budget and each config applies {@link testWorkers} to
 * whatever it would otherwise have chosen. `undefined` in, `undefined` out: a
 * workspace with no opinion of its own and no budget in the environment keeps
 * vitest's default, and `npx vitest run --root apps/api` on its own is unchanged.
 */
import { availableParallelism, totalmem } from 'node:os'
import process from 'node:process'
// Node globals, imported rather than reached for, exactly as the runner beside
// this file does: the eslint config declares no environment for a script.

/**
 * The variable the runner sets and the configs read.
 *
 * Deliberately the Colony's own name and not `VITEST_MAX_THREADS`. Vitest owns
 * that one, its meaning is tied to the pool implementation, and a value found in
 * an inherited environment would silently change what a bare `vitest run` does.
 * This one is set by exactly one writer, one process above the reader.
 */
export const WORKER_BUDGET_VAR = 'KOLONIE_TEST_WORKERS'

/**
 * One workspace's share of the machine, given how many run at once.
 *
 * Floor rather than round, and never below one: the point is that the shares sum
 * to no more than the machine, and a workspace that got zero workers would run
 * nothing at all.
 *
 * **The share is fixed for the whole run rather than recomputed as workspaces
 * finish**, so the last workspace in a batch holds a quarter of the machine while
 * three quarters of it is idle. That is a real cost and it is the cheap side of
 * the trade: recomputing means telling a vitest that has already started to
 * change its pool size, and the alternative — every workspace sizing itself from
 * the whole machine — is the defect above.
 */
/**
 * How much memory one vitest worker of a database-backed suite costs.
 *
 * **Measured rather than chosen** (`#1354`). On the 8-core / 7186 MiB host where
 * `#1350` was found: baseline 1790 MiB, four workers peaked at 6405 MiB, so
 * 1150 MiB each. Rounded up, because the number that matters is the one that
 * does not thrash.
 */
const MIB_PER_WORKER = 1200

/**
 * What the machine keeps for itself: the editor, the Postgres container, the
 * agent that started the run. Taken off the top rather than hoped for — the
 * measurement above had 1790 MiB already resident before vitest started.
 */
const MIB_RESERVED = 2048

/**
 * The most workers a database-backed suite may start, from **memory** rather
 * than from cores (`#1354`).
 *
 * ## Why not cores
 *
 * `#1350` gave `apps/api` `min(6, cpus - 2)` and fixed the local failure it was
 * for: fifteen timeouts in 12m12s became 4381 green in 1m46s. It also cost CI
 * 23 % — measured as an A/B on two pull requests a minute apart, 471 s against
 * 580 s — because on a four-core runner it asks for two workers where the
 * published budget already allowed four. The runner has 16 GiB and no memory
 * problem at all; it was being lowered by a rule derived from a 7 GiB laptop.
 *
 * The constraint was always memory. `packages/db`'s own comment says so — *the
 * ceiling is memory, not cores* — and then multiplies by cores anyway. This is
 * that sentence, arithmetic included.
 *
 * ## The cap stays, and it is not about this machine
 *
 * Six, from `packages/db`: a thirty-two-core, 128 GiB machine must not be
 * allowed to raise it, because past a handful of workers the shared Postgres is
 * the thing that saturates and no amount of RAM changes that.
 *
 * **This is a preference and `testWorkers` still only lowers it**, so
 * `npm run check` continues to publish a smaller share and each workspace
 * continues to take it.
 */
export const memoryCeiling = (totalBytes = totalmem()) =>
  Math.max(1, Math.min(6, Math.floor((totalBytes / 1024 ** 2 - MIB_RESERVED) / MIB_PER_WORKER)))

export const shareOfMachine = (concurrency, cores = availableParallelism()) =>
  Math.max(1, Math.floor(cores / Math.max(1, concurrency)))

/**
 * How many workers this workspace may start: its own preference, lowered to the
 * budget if there is one.
 *
 * Returns `undefined` when nothing constrains it, which is what a vitest config
 * wants — `maxWorkers: undefined` is *unset* rather than *zero*, so a workspace
 * that has never had an opinion keeps vitest's default when run on its own.
 *
 * **A malformed budget throws rather than being ignored.** It has one writer, so
 * a value that is not a worker count is a bug in this repository and not a
 * contributor's environment; ignoring it would restore the unbounded behaviour
 * silently, which is the failure mode that took two twelve-minute runs to notice
 * in the first place. `testWorkerSlot` in `packages/db` refuses a malformed slot
 * for the same reason.
 */
export const testWorkers = (preferred = undefined, env = process.env) => {
  const raw = env[WORKER_BUDGET_VAR]
  if (raw === undefined || raw.trim() === '') return preferred

  const budget = Number(raw)
  if (!Number.isInteger(budget) || budget < 1) {
    throw new Error(
      `${WORKER_BUDGET_VAR} is ${JSON.stringify(raw)}, which is not a worker count. ` +
        `It is how many test workers this workspace may start while the other workspaces ` +
        `in the same run are using the same machine, and it is set by ` +
        `scripts/run-workspace-script.mjs.`,
    )
  }

  return preferred === undefined ? budget : Math.min(preferred, budget)
}
