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

| Commits | File                                     | Why it is contended                                               |
| ------: | ---------------------------------------- | ----------------------------------------------------------------- |
|      88 | `packages/db/drizzle/meta/_journal.json` | every migration appends one entry                                 |
|      77 | `packages/db/src/academy-tasks.ts`       | one array literal holds all 31 rungs                              |
|      75 | `apps/api/src/mcp.ts`                    | **fixed** — became `apps/api/src/mcp/`                            |
|      74 | `apps/api/src/app.ts`                    | **fixed** — became `apps/api/src/routes/`                         |
|      71 | `docs/decisions.md`                      | append-only, and read from the end — see below                    |
|      67 | `apps/api/src/mcp.test.ts`               | a test file — see below                                           |
|      58 | `packages/db/src/academy-tasks.test.ts`  | a test file — see below                                           |
|      56 | `packages/core/CHANGELOG.md`             | append-only, and read from the end — see below                    |
|      50 | `apps/api/src/__fixtures__/colony.ts`    | one fixture shared by everything                                  |
|      49 | `packages/db/src/storage/index.ts`       | 54 lines of `export *`, sorted, so additions land near each other |

**Size and contention are different problems, and conflating them produces the
wrong rule.** The worst file on this list is forty lines long. The largest test
files in the repository — `attempts.test.ts` at 1818 lines, `erasure.test.ts` at
1610 — are on nobody's list. A line limit would have caught the harmless files
and missed the expensive one, which is why the rule in `AGENTS.md` is about
contention and says nothing about length.

**Not everything here is a problem.** Four of the ten are the shape the rule
deliberately excludes: `docs/decisions.md`, `CHANGELOG.md` and the two test files
are appended to and read from the end. A conflict in one of those is a text
conflict at the last line, which git raises and anybody can resolve. What the
rule is about is the append point in the _middle_ of something — an array, a
sorted barrel, a registry — where two edits land near each other and the merge
is either painful or, worse, clean and wrong.

## What has been done about it

- `apps/api/src/mcp.ts` and `apps/api/src/app.ts` became directories. Neither
  appears in the size listing any more, and the rule in `AGENTS.md` §3 is that
  move written down so it is not rediscovered a third time.
- `_journal.json` cannot stop being one append point — drizzle decides its
  format — so it is guarded instead: `packages/db/src/journal.test.ts` refuses
  the four ways a merge of it goes wrong (#262).
- `packages/db/src/storage/quests.ts` became `packages/db/src/storage/quests/`
  on 2026-08-04 (#263), split into `write.ts`, `read.ts` and `steward.ts` over
  a `shared.ts`, with its own `index.ts`. It was never on the table above — it
  is four days old — and that is the point of doing it now: the split was made
  before the sponsor's console (#180, landed) and the steward's console (#181,
  not started) could edit the same file. `storage/index.ts` changed by one line.

Open, one issue each: #264 (`academy-tasks.ts`), #269 (`CHANGELOG.md`), #270
(`colony.ts`), #271 (`storage/index.ts`).

## Re-measuring

Run the command above. If a file has left this table, delete its row and say when
it left; if one has arrived, add it with the date. **A table nobody has
re-measured is a claim about the past wearing the present tense** — the same
failure `kolonie-docs` AGENTS.md §7 requires a date against.
