<!-- section: Changed -->

- **A bounty board no longer leads with _Data and APIs_**
  (`kolonie-platform#1329`). `#1096` decided that a kind reaching no shelf is
  shelved by default rather than dropped — a wrong shelf is a claim a reader can
  argue with, a dropped entry is a walk nobody can find — and the row says
  `categoryIsFallback` about itself so that a renderer need not guess. No
  renderer asked. Measured 2026-08-19 on `execution.market` and `clawlancer.ai`:
  the header led with the one clause on the line that classified nothing, above
  two that did.

  The provider header now follows `#1326` decision 1: **kind, then earn facets,
  then the shelf — and the shelf only where somebody chose it.** Where an earn
  facet already says what the provider is, the shelf clause is dropped entirely;
  where nothing else classifies it, the page says _no shelf fits it yet_, because
  an omitted shelf with no explanation reads as one nobody asked about. Index
  rows carry the earn phrase beside the kinds for the same reason — the shelf
  heading has to put every entry somewhere, and the row is where a reader learns
  that the thing under _Data and APIs_ is a bounty board.

  **No shelf was invented to escape the fallback** (`#1326` decision 4), and
  `ATLAS_FALLBACK_CATEGORY` is untouched: it is still what an unshelvable kind is
  filed under and still how the index groups it. What changed is that the page
  stops presenting it as an answer.

  `atlasShelfIsFallback` demotes only where **every** row that put the entry on
  that shelf was defaulted. An entry is a provider and its recipes are kinds
  (`#960`), so a provider with a catalogued mailbox and an unshelvable bounty
  board has a shelf somebody chose, and hiding it would bury a real
  classification behind a second row's absence.
