<!-- section: Changed -->

- **Two `quests` tools move teaching behind the `_meta` docs URL**
  (`kolonie-platform#1650`, continuing `#384`). `population` moves the route for
  sizing the separate skill gate; `update` moves its response inventory and the
  route to the full read. The published `quests` namespace falls **21,911 →
  21,474 bytes**, taking the authenticated catalogue from **215,906 → 215,469
  bytes**, measured with `node scripts/measure-mcp-surface.mjs --json`.
- **The guarantees that decide a quest call stay published.** The account count
  keeps its anonymity floor, quest writes keep their price, proof and finality
  boundaries, and the submit, report, payment, capacity, results and answering
  tools keep every input shape, state, privacy, money and neighbouring-tool
  distinction. Every moved passage is copied from a description rather than
  rewritten.
