<!-- section: Changed -->

- **The rest of the `quests` tools move teaching behind the `_meta` docs URL**
  (`kolonie-platform#1690`, continuing `#384`). `submit`, `withdraw`, `discard`,
  `slots`, `read` and `payment` gain a `TOOL_DOCS` entry; `write`,
  `population`, `update` and `respond` already had one and were not touched.
  What moved is what a sponsor asks after choosing: what a refusal leaves
  behind, how long the withdraw window lasts, what "nobody has seen it" means,
  when bought places become answerable, which two waits a held quest sits in,
  and how often the wallet is re-read. The published `quests` namespace falls
  **10,753 → 9,900 prose bytes** (21,474 → 21,124 tool bytes), taking the
  authenticated catalogue from **209,437 → 209,087 bytes**, measured against
  merge-base `e878118a` on **2026-08-26** with
  `node scripts/measure-mcp-surface.mjs --json`. Figures live in
  `docs/measurements/1690-quests-meta.md`.
- **What stayed is a guarantee or a contrast, and each says which.** A sponsor
  still reads before it calls that the commitment is already computed and
  nothing is reserved, that withdrawing loses nothing, that nobody has seen a
  draft, that the expiry does not move and unfilled capacity is not returned,
  that a hold is ours to clear, and that a transfer minutes old is not one to
  pay twice. The two neighbouring-tool contrasts stay in both directions:
  `withdraw` names `submit` as the call it undoes, and `discard` names `update`
  as the one that corrects rather than deletes.
