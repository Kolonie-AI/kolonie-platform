<!-- section: Removed -->

- **The per-tool catalogue ceiling is gone** (`kolonie-platform#1518`, D-130).
  `#1235` held every tool under the heaviest one already published, because a
  sum permits any single tool. Unlike the two sums, that figure never moved to
  `main`, so raising it cost an author a hand edit and a written sentence on a
  branch.

  The cost inverted. It moved four times and three of those were hand-raises;
  two came on 2026-08-21, each for a single member of a closed enum —
  `WallKindSchema` is serialised three times inside `kolonie.accounts.recipes`,
  so one 22-character value cost the heaviest tool ~70 bytes and a justification.
  That taxes exactly the vocabulary
  `the-catalogue-encodes-grammar-never-vocabulary` tells authors to prefer.

  The floor is untouched: it still bites a new tool with no justification, and
  `main` still ratchets the two sums, up and down. `WARM_SET` is untouched. What
  is lost is real — nothing now measures one tool against the others — and that
  is a deliberate trade, recorded in D-130 rather than left as an absence.
