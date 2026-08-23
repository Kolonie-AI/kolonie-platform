## D-138 — The decisions index is the directory too, and the produced file is not tracked

**Date:** 2026-08-24

`docs/decisions.md` is no longer tracked. `docs/decisions/` is the records,
`scripts/build-decisions-index.mjs` still writes the one-page index for anybody
who wants it, and nothing commits the result.

### What was decided before, and why it did not hold

`#1497` split the 9497-line `docs/decisions.md` into one file per record and kept
the file as a **produced index**. `#1496` gave that index `merge=union`, and
`scripts/check-union-merge-guards.mjs` recorded `check:decisions` as the guard
that made a union result safe: a produced file's union is allowed to be wrong,
because the gate refuses to let it stay wrong.

That is a coherent argument about the wrong failure. Measured 2026-08-23 in the
merge queue on `main`:

```
pos=2 AWAITING_CHECKS PR#1657      <- adds D-136, regenerates docs/decisions.md
pos=5 UNMERGEABLE     PR#1660      <- adds D-137, regenerates docs/decisions.md
```

The two pull requests overlapped in exactly one file, and it was that one.
**GitHub never applies a `.gitattributes` merge driver**, so the union that
resolves cleanly in a working tree resolves not at all on the surface that decides
whether a branch can land — and a gate that catches a _wrong_ index cannot catch
one that never merged, because there is no merge to check. The queue reports it as
`UNMERGEABLE`, drops the entry, and the pull request sits looking green.

### The reader `#1497` protected, measured

`#1497`'s one argument for keeping the file tracked was that **twenty-odd things
link into it by anchor**, and deleting it would break every one. Measured
2026-08-24 across the repository:

| Claim                                 | What is actually there                                                                  |
| ------------------------------------- | --------------------------------------------------------------------------------------- |
| Anchor links into `docs/decisions.md` | **none.** `grep -riE 'decisions\.md#'` matches nothing                                  |
| Markdown links to the file            | **one**, in `packages/core/README.md`, now pointing at the directory                    |
| `ci.yml` citations                    | already cite `docs/decisions/`, the directory, at `:193` and `:391`                     |
| Everything else                       | cites a bare `D-0NN` number in prose — `AGENTS.md` D-008, `core/src/api/tasks.ts` D-014 |

A bare `D-` number resolves against the directory as well as it ever resolved
against the file, and better than it resolved against 9497 lines.

### The rejected alternative, and what it would have cost

**Keep it tracked and resolve each collision by hand.** That is what `main` does
with `packages/db/drizzle/meta/_journal.json`, and it is an accepted cost there
for a stated reason: that file's failure is _loud_. `check:migrations` bites, and
a person sees a conflict they must resolve.

This one fails quietly. A dropped merge-queue entry looks exactly like a pull
request waiting its turn, and on 2026-08-23 it took reading the queue to notice.
Trading a silent failure for a hand resolution nobody is prompted to make is the
wrong direction, and the cost of the alternative is paid by whichever session next
writes a record while another is in flight — a rate that rises with the number of
sessions, not with the number of decisions.

### The rule this sharpens, for the third time

`#271` (the storage barrel), `#1572` (`packages/core/CHANGELOG.md`) and now this:
**a file nobody commits cannot be merged at all.** What the third case adds is
that a `--check` gate is not a substitute. Both produced files had one; both
needed untracking anyway.

`--check` keeps its place for a different job. `check:decisions` now asserts that
the _directory_ assembles — a heading that does not parse, a missing date, a file
named for a different record, and above all **a `D-` number claimed twice**. That
last is the one collision the split genuinely cannot remove: two branches each
taking `D-138` write two different files, git merges them without a word, and the
pair is only wrong once both are on `main`. Nothing else catches it.

### Out of scope

The `union` stanzas on `packages/db/src/schema/index.ts` and
`apps/api/src/mcp/tool-list.ts` stay. They have the same defect — GitHub does not
apply their driver either — but they are append-only registries whose collisions
are ordinary text conflicts a person resolves in seconds, and each has a real
guard against a wrong resolution. They are not produced, so untracking them is not
available; that is the difference that decides it.

---

Issues: `#1662`. Precedent: `#271`, `#951`, `#1496`, `#1497`, `#1572`, `D-132`.
