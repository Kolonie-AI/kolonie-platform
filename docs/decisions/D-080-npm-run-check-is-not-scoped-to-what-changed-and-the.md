## D-080 — `npm run check` is not scoped to what changed, and the measurement is why

**Date:** 2026-08-04

**Problem.** The check is the thing every agent runs before a push, and running
it four times in one session is ordinary. `#305` asked whether it should be
allowed to run less than everything when what changed cannot reach most of it —
a Markdown-only change running the database suite is work nobody can use.

**Decision.** It runs everything, and this record exists so the question is
answered with a measurement rather than re-argued each time somebody notices the
wall clock.

**What it would actually save, measured.** The last 120 commits on `main`,
classified by which workspaces could see them through the dependency graph
(`packages/db` → `packages/core`, `apps/*` → the packages they import):

| what a commit could affect               | share |
| ---------------------------------------- | ----- |
| every workspace                          | 59%   |
| the six downstream of `packages/db`      | 21%   |
| one app alone                            | 10%   |
| nothing that has tests — docs, workflows | 6%    |
| other partial sets                       | 4%    |

**The 59% is not lockfile noise, which is the part that decides this.** 62 of
those 71 commits touch `packages/core` and 9 touch the root or the tooling. The
domain model is imported by everything _correctly_ — it is the contract, and
`AGENTS.md` §3 requires shared shapes to live there — so the commits that would
skip the least are the commits this repository mostly makes.

The 21% saves almost nothing either: `packages/db` is 64 s of an 80 s test stage,
so a run that skips `packages/core` and `packages/verifiers` still waits for the
long pole.

That leaves 16% of commits with a real saving — roughly 50 s for a change
confined to one app, roughly 80 s for one that touches no tested code. Weighted
across all of them, **under 10 seconds a run**, against a check that is 1 min 28 s
warm since `#303` and `#304`.

**Rejected: a graph-derived selection with a loud summary.** The mechanism is
buildable — the workspace graph is in the `package.json` files and is accurate —
and the safety could be made visible by printing what was skipped. It is refused
on value rather than on feasibility: under ten seconds is not worth a second way
for a green answer to mean something other than _everything passed_, in a
repository where `main` is not protected and the check is the only gate (D-070).

**What is available instead, and is enough.** `check:fast` skips the tests and
says so in capital letters; `npm run test -w @kolonie-ai/api` runs one workspace.
`AGENTS.md` §4 documents both. Iterating is already cheap; the full check is for
the one moment it is the gate.

**When this should be reopened.** If `packages/core` stops being where most work
lands, or if the test stage grows past a few minutes again, the arithmetic
changes and this record is the thing to re-measure rather than the thing to
quote.
