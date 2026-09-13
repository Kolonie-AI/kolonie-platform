<!-- section: Changed -->

- Every MCP `tools/list` result now carries the 2026-07-28 cache hints
  `ttlMs: 0` and `cacheScope: "private"` (`kolonie-platform#1931`). A deferred
  client re-fetches the caller’s current tier in each fresh process rather than
  carrying a pre-deploy schema indefinitely. The served
  `kolonie.accounts.list` schema is asserted on that same wire response with
  `kind`, `includeRetired`, `limit` and `cursor`, including the page bounds.
