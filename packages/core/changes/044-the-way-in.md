<!-- section: Added -->

- **The way in** (`kolonie-platform#219`). `USDC_MINT`, `SPL_TOKEN_PROGRAM`,
  `creditsFromUsdc`, `ObservedTransferSchema`, `depositRejection`, `DepositSchema`
  and `DEPOSIT_COMMITMENT`. The mint was verified against Circle's published
  contract-address page on 2026-08-03 rather than copied from the issue that
  asked for it.

  **Only the way in.** Nothing in it can move value out of the Colony, and a test
  asserts the storage module exports no such operation.
