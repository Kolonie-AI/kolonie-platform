## D-084 — `packages/db`'s test `setup` figure is where the module graph is charged, not work the suite could stop doing

**Date:** 2026-08-04

**Problem.** Vitest reports a `setup` figure for `packages/db` and `0ms` for every
other workspace, and it is large: 19.6 s of a 50 s test stage when `#313` measured
it, 13.5 s of a 40 s stage when this record measured it on a quieter machine. The
natural reading is that two fifths of this package's wall clock is spent before a
single assertion runs, and that reading is what `#313` was opened to act on. It is
wrong, and the arrangement stands unchanged.

**Decision.** Nothing changes. `setupFiles`, the per-worker databases from `#284`,
the migrated template from `#296` and the worker count all stay as they are.

**What the figure actually is, by ablation.** Three arrangements, `packages/db`
alone, 89 files, an idle 8-vCPU machine, two runs each, all figures summed across
workers except the wall clock:

| Arrangement                                | Wall        | `setup`     | `import`        | `setup` + `import` |
| ------------------------------------------ | ----------- | ----------- | --------------- | ------------------ |
| As configured                              | 41.4 / 40.0 | 13.5 / 14.3 | 5.5 / 5.9       | 19.1 / 20.2        |
| `setupFiles` registered, its body disabled | 39.2 / 39.2 | 11.6 / 11.4 | 6.0 / 5.7       | 17.6 / 17.0        |
| No `setupFiles` at all                     | 40.2 / 39.8 | **0**       | **18.9 / 17.8** | 18.9 / 17.8        |

**Remove the setup file and the number does not go away — it moves to `import`,
and the wall clock does not change.** The setup file's first statement imports
`testing.js`, which pulls in the client, the schema and Drizzle; a test file that
had no setup file would load exactly the same graph a moment later, and be charged
for it under a different heading. Vitest attributes a module to whichever phase
first asked for it. There is nothing here to stop paying for, because the payment
is loading the code the tests are about to use.

**What the setup file's own work costs is the difference between the first two
rows: about 2 s summed, and 1–2 s of wall.** That is one `select` against
`pg_database` per file, and `test-worker-setup.ts` already argues why the cheaper
`globalSetup` arrangement was refused — it would need a database count in one file
to stay equal to `maxWorkers` in another. Two seconds does not buy that back.

**The template copy was already the answer to the expensive half.** `#296`
measured 811 ms to replay the migrations against 63 ms to copy a template, and it
is the template that runs today. `#313` proposed measuring exactly that as its
second step; it had already landed.

**Rejected: raising the worker count.** The current formula caps at six, and the
package alone is faster with more:

| Workers | `packages/db` alone |
| ------- | ------------------- |
| 2       | 79.1 s              |
| 4       | 48.1 s              |
| 6       | 40.2 s              |
| 8       | 37.2 s              |

That saving does not survive the run it would have to survive. Under the full
`npm run check`, where the other eight workspaces are running too, six workers
gave 89.9 s and 92.7 s and eight gave 86.7 s and 93.8 s — the same number twice
over. Peak memory was 5401 MB against 5375 MB of 7 GB, so the ceiling the config
comment warns about was not reached either way. Three seconds that appear in
isolation and vanish in the real run are not a reason to change a constant whose
current value is defended on a machine this measurement did not test.

**The one number worth carrying forward is `tests`, not `setup`.** In the same
runs the summed `tests` figure is 183 s against a 40 s stage. That is the real
shape of this package — a great many short round trips to a real Postgres, already
spread across six workers — and it is not a defect, it is what testing against a
real database costs.

**A caution this record exists to leave behind.** Both of `#313`'s premise
measurements — a 50 s stage and a 19.6 s setup — were taken while a second agent
was running its own `npm run check` on the same machine. Uncontended, the same
commit gives a 40 s stage. A full check measured 3 m 51 s under that contention
and 1 m 27 s without it, on the same clone minutes apart. **Any wall clock quoted
about this repository is worth nothing without knowing what else the machine was
doing**, and `#313`'s own framing — that a summed figure must say it is summed —
needs this second half beside it.

**When this should be reopened.** If the test stage grows past a few minutes, or
if `packages/db` stops being the long pole, the arithmetic changes. Re-measure by
ablation, as the table above does, rather than by reading the `setup` figure —
which will still be large and will still not be what it looks like.
