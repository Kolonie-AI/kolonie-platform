<!-- section: Changed -->

- **`docs/decisions.md` is 129 files and an index, not 9497 lines**
  (`kolonie-platform#1497`). It reached 9497 lines on **+9582/−85 in thirty
  days** — it more than doubled in a month, was essentially never edited, only
  appended to, and every branch in flight appended at the same place. Two agents
  recording two unrelated decisions collided there by construction.

  **The argument had already been won twice in this organisation.**
  `kolonie-docs/state/decisions.md` at 3052 lines and `packages/core/CHANGELOG.md`
  at 1745 were both cured the same way, one file per record. This file is the one
  that was never brought along, and it had grown to three times the size that
  triggered the first split.

  Each record is now `docs/decisions/D-0NN-<slug>.md`. **Every byte of every
  record reaches its file unchanged** — 130 sections in, 130 files out, 530,528
  bytes on both sides, and no section's text differs. **No number is reassigned**:
  `D-114` is still `D-114`, because `ci.yml`, `AGENTS.md` and a dozen source
  comments cite records by number.

  **The file stays and stops being the records**, which is `kolonie-docs`' shape
  rather than either ending `#1497` weighed. Deleting it would break twenty-odd
  references; producing the whole of it would keep a 9497-line artefact in git. So
  it is an **index** — number, title, date, link, about 150 lines — produced by
  `scripts/build-decisions-index.mjs` with a `--check` mode in `npm run check`, so
  the directory and the file cannot drift. A citation by `D-` number now resolves
  better than it did: the index links at the record instead of asking a reader to
  scroll.

  It also takes `merge=union` under `#1496`, on the changelog's argument: two
  branches each writing a record produce two rows, which is what the file should
  say, and `check:decisions` is what refuses to let a wrong resolution stay.
