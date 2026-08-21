## D-132 — The changelog is the directory, and the produced file is not tracked

**Date:** 2026-08-22

**Supersedes the second half of `D-123`**, which rejected _not committing the
generated file_. The half of `D-123` about merge drivers stands untouched and is
reaffirmed below.

**Problem.** `packages/core/CHANGELOG.md` is produced from
`packages/core/changes/` and is also tracked, so every change that adds an entry
also modifies the artefact. Two pull requests open at once therefore conflict on
it whatever else they touch — which is the collision `#951` split the directory
out to remove, surviving one level along.

Measured on `main`: **432 commits to `CHANGELOG.md` in thirty days**, 36 on
2026-08-21 alone.

**`#1496`'s `merge=union` does not close it, and this is the new fact.** Verified
2026-08-22 on one pair of branches, same commits both times:

|                                                 |                                |
| ----------------------------------------------- | ------------------------------ |
| `git check-attr merge` → `union`, `git merge`   | **clean**                      |
| attribute overridden with `!merge`, `git merge` | **conflict in `CHANGELOG.md`** |

So the driver is correct and it is the only thing resolving the file. **GitHub
does not apply it.** It reported `CONFLICTING` for that same pair, the merge queue
reports the same state as `UNMERGEABLE` and evicts the entry, and — measured the
same evening — **the eviction silently clears auto-merge**, so a pull request that
was armed and green stops waiting without saying so. Three pull requests needed
four rebase rounds between them, all four on this one produced file.

**Why `D-123`'s reason for keeping it no longer holds.** It rejected untracking in
one sentence: _`CHANGELOG.md` is read on `main` and at a tag, and an uncommitted
file is not readable there._ Measured 2026-08-22:

|                                                  |                                                     |
| ------------------------------------------------ | --------------------------------------------------- |
| Tags in this repository                          | **0**                                               |
| Workflows that publish, tag or cut a release     | **0**                                               |
| npm packages under the `Kolonie-AI` organisation | **none**                                            |
| `packages/core/package.json`                     | `private: false`, `publishConfig` → GitHub Packages |

The package is configured to be published and never has been. _At a tag_ is not a
reader, because there are no tags. What survives is _read on `main`_, which is
equally true of `packages/core/changes/` — the source, on `main`, one file per
entry, readable.

`docs/contention.md` had already recorded the same measurement on 2026-08-04 —
_there are no tags and no release workflow_ — and drew the opposite conclusion
from it, that nothing would assemble the files. Read the other way round it is an
argument that the tracked artefact has no reader.

**Decision.** `packages/core/CHANGELOG.md` is git-ignored. `changes/` is the
changelog. `build-changelog.mjs` still produces the file and
`packages/core`'s `prepack` runs it, so a publish would ship exactly the
changelog `#672` asked for, built from the same entries.

`check:changelog` becomes _the directory assembles_ — which is what it was really
asserting, since every malformed entry threw in `readEntries` before the
comparison was ever reached. Verified: a missing section marker still exits 1.

**What is given up, stated rather than discovered.** Nothing now catches two
entry files sharing a number. Under the old check they produced a different
artefact and failed; now both simply appear. That is the right outcome and it is
half the point — two branches both picking `410` was one of the collisions being
removed — and the assembled order stays deterministic because `readEntries` sorts
lexicographically by filename.

**`D-123`'s first half stands.** A custom regenerating merge driver is still
wrong, for the reason it rehearsed: at content-merge time the incoming
`changes/` entry is in neither the index nor the working tree, so the driver
regenerates from the outgoing side and writes a plausible, wrong file. Nothing
here reopens that. The answer is not a better driver; it is having no file to
merge — `#271`'s sentence about the storage barrel, unchanged: _a file nobody
commits cannot be merged at all, which is the whole of the fix._

**What would reverse this.** A release process. The moment something publishes
`@kolonie-ai/core`, the artefact has the reader `#672` and `D-123` were
protecting — and `prepack` already produces it for exactly that, so the reversal
costs nothing but this paragraph.

Issues: `#1572`. Precedent: `#271`, `#951`, `#1496`, `D-123`.
