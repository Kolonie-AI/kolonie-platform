## D-085 — `apps/api`'s `import` exceeds its `tests` because both are summed across workers, and at one worker the order reverses

**Date:** 2026-08-04

**Problem.** `#314` observed that `apps/api` reports `import 79.9s` against
`tests 55.4s` for a 20 s test stage, and asked whether the suite spends more time
loading modules than exercising them — and if so, whether that is a fact about the
runtime or something this repository does to itself. It is neither. It is what
summing a per-worker cost across workers looks like.

**Decision.** Nothing changes. `connectedClient` keeps driving a real client over
a real transport, `fakeColony` keeps its four files, the pool is not touched, and
the worker count stays as it is.

**The measurement that settles it.** `apps/api` alone, 82 files, 1,261 tests, one
idle 8-vCPU machine, worker count swept. Everything except the wall clock is
summed across workers:

| Workers | Wall   | `transform` | `import`  | `tests`    |
| ------- | ------ | ----------- | --------- | ---------- |
| 1       | 25.7 s | 5.3 s       | **7.8 s** | **15.5 s** |
| 2       | 18.9 s | 9.6 s       | 14.3 s    | 19.1 s     |
| 4       | 16.3 s | 19.4 s      | 30.3 s    | 26.9 s     |
| 6       | 16.4 s | 28.3 s      | 46.5 s    | 39.5 s     |
| 8       | 17.5 s | 42.7 s      | 75.2 s    | 45.3 s     |

**`import` grows linearly with the worker count and the wall clock does not.**
Roughly 7.5 s per worker, every time, because each worker loads the module graph
once — `#290` turned per-file isolation off for this workspace, so the graph is
paid per worker and not per file. `tests` grows too, more slowly, which is the
same eight processes taking longer each on eight shared cores.

**At one worker, where summed and wall are the same thing, `tests` is twice
`import`.** The ratio the issue was opened about exists only in the summing.

**Where the 7.5 s actually goes**, measured with five one-line probe files, each
importing one layer and asserting nothing, run alone:

| What the file imports                            | `import` |
| ------------------------------------------------ | -------- |
| nothing                                          | 59 ms    |
| `@modelcontextprotocol/sdk` client and transport | 382 ms   |
| `__fixtures__/colony/index.js` (`fakeColony`)    | 4.84 s   |
| `src/mcp.js` (the server surface)                | 6.51 s   |
| `__fixtures__/mcp.js` (`connectedClient`)        | 6.78 s   |

**The SDK is not the floor** — it is 0.32 s over an empty file, four per cent of
the graph, and the obvious first guess is wrong. **`connectedClient` costs 0.27 s
more than the server surface it wraps**, so the fixture is not the cost either:
what is expensive is `apps/api`'s own graph, which is every tool, every route and
the domain model, and which a test of the MCP surface has to load by definition.
`#270`'s four-file split of `fakeColony` is not implicated: the fixture sits below
the server surface, not on top of it.

**Rejected: nothing was proposed, and that is the outcome.** There is no import to
remove, no fixture to slim, no pool to change. A per-worker graph load of 7.5 s
against a 16 s stage on eight cores is what a workspace of this size costs, and
the arrangement that makes it cheap — one load per worker rather than per file —
already landed in `#290`.

**The transform cache, which `#314` asked about separately.** There is no
persistent one worth chasing: `node_modules/.vite` holds 16 KB of dependency
metadata, and deleting it before a run cost about half a second of `transform` at
one worker. `#304` cached the two checks that read every file; this stage has
nothing of the same shape to cache.

**Read with D-084**, which found the same shape in `packages/db`: a phase figure
that looks like waste and is an artefact of how vitest attributes and sums.
**Between them, both halves of the _"a test run takes 500 seconds"_ story are now
accounted for** — that figure was a summed `tests` number for a 50 s stage, and
this record is why the summed numbers are large. The rule `#314` stated for itself
generalises: every figure says whether it is summed or wall clock, **and every wall
clock figure says what else the machine was running.**
