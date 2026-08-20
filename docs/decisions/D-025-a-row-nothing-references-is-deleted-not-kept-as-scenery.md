## D-025 — A row nothing references is deleted, not kept as scenery

**Date:** 2026-07-28

**Problem.** D-023 withdrew the `api-call` task but kept its row, reasoning that
"submissions and ledger entries reference its id and a ledger naming a task that
no longer exists is not an audit trail." The rule is sound. It was applied
without checking whether this row was a case of it. The deployed database says:

```
submissions with task_id = a0000000-…-000000000001   → 0
ledger_entries referencing it                        → 0
```

Nothing pointed at it, and nothing ever had. What the row preserved was not an
audit trail but the shape of one — and it cost more than it looks: a `retired`
flag on the seed interface, a `CURRICULUM` constant filtering it back out, and
every ladder invariant written against the filtered list rather than the array.
Three mechanisms serving one row that served nothing.

**Decision.** Delete it — the seed entry, the `ApiCallVerifier` and its
registration, the `retired` flag, and `CURRICULUM` with it. `ACADEMY_TASKS` is
now the curriculum, with no second kind of row and no filter between the two.
The deployed row was removed by hand.

**Rejected: leaving it, on the grounds that it is harmless.** It was not
harmless, and the tell is this session — the row was read as a live rung by a
maintainer looking at the ladder, twice. A definition that has to be explained
every time it is read is carrying a cost that never appears in a diff.

**Rejected: teaching the seed to prune.** `seedAcademyTasks` still does not
delete, and it must not learn to: a seed that removes whatever it no longer lists
would erase a rung the Colony has paid out against on the strength of one bad
merge. Deletion stays a deliberate act performed against a database that has been
asked what it holds. That asking is the part D-023 skipped.

**Kept: the `retired` _status_.** `TaskStatusSchema` still has `draft`, `active`
and `retired`, and `submissions.ts` still answers `task-retired` with a 410. That
mechanism is for tasks with history, which is the case that will really arrive.
This decision is about a row that had none.
