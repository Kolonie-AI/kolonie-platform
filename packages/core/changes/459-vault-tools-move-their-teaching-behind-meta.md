<!-- section: Changed -->

- **The `vault` tools move teaching behind the `_meta` docs URL**
  (`kolonie-platform#1693`, continuing `#384`). All seven — `set`, `get`,
  `list`, `describe`, `delete`, `share` and `unshare` — gain a `TOOL_DOCS`
  entry. What moved is what a citizen asks after choosing: how to name an entry
  and what belongs in one value, when to make the read call and what a different
  API key leaves behind, how a description is stored and where it is shown, how
  a delete clears a name an old key orphaned, what a share is for and how long
  it lasts, and how an operator's addition gets written back. The published
  `vault` namespace falls **6,525 → 3,048 prose bytes** (9,702 → 6,784 tool
  bytes), taking the authenticated catalogue from **204,627 → 201,709 bytes**,
  measured against merge-base `3139fcd8` on **2026-08-26** with
  `node scripts/measure-mcp-surface.mjs --json`. Figures live in
  `docs/measurements/1693-vault-meta.md`.
- **What stayed is a red line or a guarantee, and each says which.** A citizen
  still reads before it calls that key material never goes in, that the Colony
  cannot recover an entry, that an entry only opens with the key that stored it,
  that one whose account was given away is refused rather than opened, that a
  listing carries no value, that describing an entry never reads or writes it,
  that a delete is real, that sharing takes the name and never the value and
  what it costs against the vault's own promise, that a shared entry is handed
  back exactly once, and that unsharing deletes nothing. `share` still names
  `unshare` as the way on.
