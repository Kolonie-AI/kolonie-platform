# Contended files

Which files two agents working this repository at the same time collide in, and
why each of them does. This is the evidence behind the **independent work gets
independent files** rule in [`AGENTS.md` §3](../AGENTS.md#3-rules-that-apply-everywhere);
the rule is the part to follow, and this is the part that has to be re-measured
rather than believed.

## The measurement

Commits touching each file in the 21 days to **2026-08-03**, which is the date
these numbers are true of and the reason they are worth anything:

```bash
git log --since=2026-07-13 --until=2026-08-04 --name-only --pretty=format: \
  | grep -v '^$' | sort | uniq -c | sort -rn | head -15
```

| Commits | File                                     | Why it is contended                                       |
| ------: | ---------------------------------------- | --------------------------------------------------------- |
|      88 | `packages/db/drizzle/meta/_journal.json` | every migration appends one entry                         |
|      77 | `packages/db/src/academy-tasks.ts`       | one array literal holds all 31 rungs                      |
|      75 | `apps/api/src/mcp.ts`                    | **fixed** — became `apps/api/src/mcp/`                    |
|      74 | `apps/api/src/app.ts`                    | **fixed** — became `apps/api/src/routes/`                 |
|      71 | `docs/decisions.md`                      | **fixed** — became `docs/decisions/`, one record one file |
|      67 | `apps/api/src/mcp.test.ts`               | a test file — see below                                   |
|      58 | `packages/db/src/academy-tasks.test.ts`  | a test file — see below                                   |
|      56 | `packages/core/CHANGELOG.md`             | **judged and kept** — one hot line, cheap merge — below   |
|      50 | `apps/api/src/__fixtures__/colony.ts`    | **fixed** — became `__fixtures__/colony/`                 |
|      49 | `packages/db/src/storage/index.ts`       | **fixed** — generated on every build and no longer in git |

**Size and contention are different problems, and conflating them produces the
wrong rule.** The worst file on this list is forty lines long. The largest test
files in the repository — `attempts.test.ts` at 1818 lines, `erasure.test.ts` at
1610 — are on nobody's list. A line limit would have caught the harmless files
and missed the expensive one, which is why the rule in `AGENTS.md` is about
contention and says nothing about length.

**Not everything here is a problem.** Four of the ten are the shape the rule
deliberately excludes: `docs/decisions.md`, `CHANGELOG.md` and the two test files
are chronicles. A conflict in one of those is a text conflict git raises and
anybody can resolve.

**Two of those four have since been fixed anyway, and the reason is worth the
line** (`#951`, `#1497`). _A conflict anybody can resolve_ was true and it was
not the whole cost: `CHANGELOG.md` went on to 1745 lines and `docs/decisions.md`
to **9497**, growing +9582 in its last thirty days, and every branch in flight
collided at the same append point whatever else it touched. A conflict that is
cheap to resolve and certain to happen is still a toll on every change. Both are
one file per record now, and the file that remains at each path is produced from
the directory with a `--check` gate so the two cannot drift. What the rule is about is the append point in the _middle_
of something — an array, a sorted barrel, a registry — where two edits land near
each other and the merge is either painful or, worse, clean and wrong.

**One correction to that paragraph, measured rather than assumed** (2026-08-04,
#269): `CHANGELOG.md` is not appended to at the end. Entries are **prepended**,
under the newest `###` heading, and the line is fixed — of the 56 commits in the
window that could be attributed to a first hunk, **34 began within the first ten
lines of the file** and 26 of those at line 9 exactly. It is a chronicle read
from the top, so the conflict is at a hot line rather than a cold one. That
makes it constant, not expensive: see the judgement below.

## What has been done about it

- `apps/api/src/mcp.ts` and `apps/api/src/app.ts` became directories. Neither
  appears in the size listing any more, and the rule in `AGENTS.md` §3 is that
  move written down so it is not rediscovered a third time.
- `_journal.json` cannot stop being one append point — drizzle decides its
  format — so it is guarded instead: `packages/db/src/journal.test.ts` refuses
  the four ways a merge of it goes wrong (#262).
- `packages/db/src/storage/index.ts` is **generated and no longer in git**
  (#271, 2026-08-04). Re-measured on the day: **54 commits** in the 21 days to
  2026-08-04, up from the 49 that opened the issue, so it was getting worse
  rather than settling. `packages/db/scripts/generate-storage-barrel.mjs` writes
  it from the contents of the directory, root `build` runs it, and
  `storage/barrel.test.ts` asserts what is on disk is what the generator writes.
  Adding a storage module is now a change to one file — the module — and a file
  nobody commits cannot be merged at all.

  **`schema/index.ts` has the same shape and is deliberately left alone.** It is
  49 lines of `export *` and one line per table, but `drizzle-kit` reads it to
  generate migrations, so it has to be a real, flat, exhaustive list that the
  tool can parse. It is on this list as a known append point with no fix
  available, not as an oversight.

  Grouping the storage modules into subdirectories was the obvious alternative
  and was not taken: `storage/x.ts` and `schema/x.ts` are a deliberate pair, and
  the schema cannot follow storage into subdirectories for the reason above. The
  two halves of the package would have stopped agreeing about their own shape,
  and only one of them was free to move.

- `apps/api/src/__fixtures__/colony.ts` became `apps/api/src/__fixtures__/colony/`
  on 2026-08-04 (#270), split four ways — `agent.ts` (the citizen and its
  credential, and the only one of the four with state in it), `rungs.ts` (the
  Academy rungs, one field each), `work.ts` (tasks, quests, submissions,
  guidance, deposits) and `desks.ts` (support, erasure, accounts, and the
  operator's own two). `FakeColony` is now an intersection of the four area
  types rather than a fifth declaration of the same fields, so `index.ts` does
  not grow when a feature does — which is the property, rather than the file
  count.

- `packages/db/src/storage/quests.ts` became `packages/db/src/storage/quests/`
  on 2026-08-04 (#263), split into `write.ts`, `read.ts` and `steward.ts` over
  a `shared.ts`, with its own `index.ts`. It was never on the table above — it
  is four days old — and that is the point of doing it now: the split was made
  before the sponsor's console (#180, landed) and the steward's console (#181,
  not started) could edit the same file. `storage/index.ts` changed by one line.

## `packages/core/CHANGELOG.md`: judged on 2026-08-04 and kept (#269)

**Re-measured first: 63 commits** in the 21 days to 2026-08-05, up from the 56
this table records for the day before. It is the most-written file left on the
list, and 34 of those writes land within ten lines of the top.

**The changeset pattern — a `.changes/` directory, one file per change, a script
that assembles — was not adopted.** Three reasons, in the order they weighed:

1. **The merge is cheap and it cannot be wrong.** Two entries inserted at one
   line are two independent bullets under one heading. Resolving it is _keep
   both_, and the order carries no meaning, so there is no version of this
   conflict that merges cleanly into something false. That second half is what
   the rule in `AGENTS.md` §3 actually exists for, and this file does not have
   it.
2. **Nothing would assemble the files.** A changeset directory earns its keep at
   release. `@kolonie-ai/core` has been released **once**, `0.1.0` on
   2026-07-26; there are no tags and no release workflow. Everything since is
   1150 lines under `## Unreleased`. Adopting the pattern would replace one long
   section nobody reads end to end with sixty loose files nobody reads end to
   end, and defer the assembly to an event that has happened once in the
   repository's life.
3. **It is five documents, not one directory.** `AGENTS.md`, `packages/core/
AGENTS.md`, `CONTRIBUTING.md`, the pull request template and the model-change
   issue template all instruct a contributor to write into `CHANGELOG.md`, and
   the criterion for adopting was that _something enforces_ the new rule rather
   than a sentence asking for it. That is a real change to how contributing
   works, spent on a conflict that costs a minute.

**What would change this.** A second release, or a release workflow landing —
either gives the assembly step a trigger and removes reason 2, which is the load
-bearing one. Or evidence that the conflict has produced a _wrong_ merge rather
than an annoying one, which would remove reason 1. Re-open #269 against either;
do not re-derive the question from the row in the table, which is what this
section exists to prevent.

Open, one issue each: #264 (`academy-tasks.ts`).

## Re-measuring

Run the command above. If a file has left this table, delete its row and say when
it left; if one has arrived, add it with the date. **A table nobody has
re-measured is a claim about the past wearing the present tense** — the same
failure `kolonie-docs` AGENTS.md §7 requires a date against.
