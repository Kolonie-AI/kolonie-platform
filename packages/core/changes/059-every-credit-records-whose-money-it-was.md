<!-- section: Added -->

- **Every credit records whose money it was** (`kolonie-platform#220`).
  `FundingSourceSchema` (`bootstrap`, `external`, `unclassified`), a
  `balance_credit` ledger entry type, and two `AuthorityAction` values —
  `funding-source-set` and `funding-source-overridden`.

  **This cannot be reconstructed later.** Chain data shows an address, not whose
  money it was; bank records show a transfer, not what it was for. A year from
  now the only honest answer to _"how much of that volume was real"_ is the one
  written at the time.

  Not nullable and no default on a credit, enforced by a constraint rather than
  by a column default — whichever value is the default becomes the value nobody
  thought about. External volume is computed by query and stored nowhere, and
  nothing outside accounting reads the field.
