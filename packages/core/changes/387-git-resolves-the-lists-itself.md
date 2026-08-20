<!-- section: Changed -->

- **Git now resolves the lists this repository collides on**
  (`kolonie-platform#1496`). There was no `.gitattributes` at all, so every one of
  395 changelog conflicts a month, and every collision on a 122-line schema barrel
  that changed 118 times in thirty days, was resolved by a person. **Size was
  never what made them collide**: each is a registry where an unrelated feature
  appends one line at the same place as every other.

  Three paths get `merge=union`, for two different reasons.
  `packages/db/src/schema/index.ts` and `apps/api/src/mcp/tool-list.ts` are
  append-only lists where keeping both sides is the _right_ answer — two branches
  adding two tables mean each other no harm. `packages/core/CHANGELOG.md` is
  produced, so keeping both sides is merely never a conflict, and `check:changelog`
  is what makes that safe: it already fails when the file is not what
  `build-changelog.mjs` would write, so a wrong resolution costs one rebuild
  instead of reaching `main`.

  **`#1496` asked for `merge=ours` there, and `ours` is not a built-in driver.**
  git 2.53 ships three — `text`, `binary`, `union` — and `ours` needs
  `merge.ours.driver` in a local `git config`, which is not committed and would
  therefore work for one clone and silently not for CI. With the attribute
  committed and `git check-attr merge` reporting `ours`, a merge of two branches
  that had each added an entry still conflicted. Measured on two pairs of
  branches, `union` on the same file merged cleanly and byte-identically to what
  the script writes, including the worst case that issue names — both sides
  introducing a section heading that did not exist.

  **A union merge never fails**, so nothing gets one without something downstream
  that would catch a duplicate. `scripts/check-union-merge-guards.mjs` enforces
  that rather than trusting it: a path marked `union` that names no guard fails
  the check. It exists because the assumption did not hold — with the same module
  exported twice from the schema barrel, `tsc -b` and `check:counts` are both
  green.

  Three files were left without a driver on purpose, with the argument written
  beside them: the migration journal, whose order carries meaning and whose loud
  failure is what keeps it safe; and the two test files whose lists are
  append-only while the files around them are not, which a per-path attribute
  cannot separate.
