<!-- section: Added -->

- **An account can be unconfirmed** (`kolonie-platform#152`).
  `AccountSchema.unconfirmedSince` records that a re-check did not find an
  account. A fact rather than a penalty: nothing is revoked by it, and a later
  successful check clears it.
