<!-- section: Changed -->

- **`docs/decisions.md` is no longer tracked** (`kolonie-platform#1662`, D-138).
  `docs/decisions/` is the records, one file each;
  `scripts/build-decisions-index.mjs` still writes the one-page index and nothing
  commits the result. `npm run build:decisions` is for whoever wants it, and is no
  longer a step before a commit.
- **The defect it removes is a merge-queue drop, not a rebase conflict.** Measured
  2026-08-23: `#1657` and `#1660` each added a decision record, overlapped in
  exactly that one file, and the second sat `UNMERGEABLE` in the queue. **GitHub
  never applies a `.gitattributes` merge driver**, so the `merge=union` `#1496`
  gave the index resolved cleanly in a working tree and not at all where it
  counts. That reads as a pull request waiting its turn, which is why it took
  reading the queue to see.
- **A `--check` gate was named as the guard and could not have been one.** It
  catches an index that is _wrong_; it cannot catch one that never merged, because
  there is no merge to check. Both produced files in this repository had such a
  gate and both needed untracking anyway — `packages/core/CHANGELOG.md` in `#1572`
  and this one now. `#271`'s sentence, for the third time: a file nobody commits
  cannot be merged at all.
- **`#1497`'s reason for keeping it tracked was measured and is not there.** It
  said twenty-odd things link into the file by anchor. Measured 2026-08-24: no
  anchor link into `docs/decisions.md` exists anywhere in the repository, `ci.yml`
  already cited the directory, and the single markdown link — in
  `packages/core/README.md` — now points at the directory too.
- **`check:decisions` stays, doing the job it was really doing.** It now asserts
  that `docs/decisions/` assembles: a heading that does not parse, a missing date,
  a file named for a different record, and above all a `D-` number claimed twice.
  That last is the one collision the split cannot remove — two branches taking the
  same number write two different files, and git merges them without a word.
- **`.gitattributes` loses the stanza and `check-union-merge-guards.mjs` loses the
  entry.** `regenerated` now has no members; the kind is kept described because the
  distinction still holds for any produced file that is ever tracked again. The two
  remaining `union` paths — the schema barrel and the tool list — are append-only
  registries with real duplicate guards and are deliberately unchanged.
