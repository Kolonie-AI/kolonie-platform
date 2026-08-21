## D-123 — A merge driver cannot resolve the generated changelog, because at driver time the entries are not there yet

**2026-08-15 · kolonie-platform#951 · after `#672` and `#952`**

`packages/core/CHANGELOG.md` is generated _and_ committed, so two branches whose
entry files never touch still meet on it. `#951` weighed three options and left
the choice open: stop committing the file, add a merge driver, or state the truth
and leave it. `#952` did the third half. This is the second.

**Rejected: the merge driver, and it was rejected by measurement rather than by
taste.** A driver is the obvious answer — the resolution is always _discard both
sides and regenerate_, which is never a judgement, and that is the signature of a
conflict that should not reach a person. It was built and rehearsed end to end on
2026-08-15 against a clone of this repository, two branches from one base each
adding one unrelated entry:

- The driver fires, the merge reports success, **and the committed
  `CHANGELOG.md` is missing the incoming branch's entry.**
- `npm run check:changelog` then fails on `main`.

**The cause is the order Git works in, and no version of the driver escapes it.**
A content merge runs _before_ the working tree and the index are updated for the
other paths in the merge. Probed at driver time on the same rehearsal: the
incoming `changes/903-c2.md` is in **neither** the working tree nor the index —
209 entries in both, and the new one in neither. A driver that regenerates from
`changes/` is therefore regenerating from the _outgoing_ side's entries and
writing a plausible, wrong file.

Reading both sides through `MERGE_HEAD` instead is possible in a plain merge and
is not during a rebase, in `git merge-tree`, or anywhere else the refs are not
set — so the correct-looking version is the one that fails in the case this
repository actually hits, which is a rebase per merge on a moving `main`.

**A conflict is better than a silently wrong generated file.** The trade the
driver offered was: never see this conflict again, and occasionally commit a
changelog missing somebody's entry, caught by CI on `main` rather than on the
branch. Today the same situation costs a rebase and a regenerate, and it **fails
safe** — `--ours` on this file drops the other entry, `check:changelog` catches
it on the branch, and the author's natural next move fixes it.

**Also rejected: not committing the generated file.** `#951` ruled it out and it
stays ruled out — `CHANGELOG.md` is read on `main` and at a tag, and an
uncommitted file is not readable there.

**What would reverse this**: a Git version that materialises the merged tree
before running content drivers, or a changelog that is not committed because it
is published somewhere else. Neither is on the horizon, and the second is a
product decision rather than a build one.
