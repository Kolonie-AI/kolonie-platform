<!-- section: Added -->

- **The deposit webhook reads what Helius actually sends** (`kolonie-platform#321`).
  `HeliusDeliverySchema`, `claimsInDelivery` and `TransferClaim` in
  `ledger/helius.ts`.

  **Measured against Helius's webhook documentation on 2026-08-04:** an enhanced
  delivery is an array of transactions carrying `tokenTransfers[]`, and neither the
  enhanced nor the raw form carries a token program or a commitment. `#219` validated
  the route's body with `ObservedTransferSchema`, whose six fields no observer emits,
  so every delivery a real sender could make was answered `422`.

  **A claim is not a transfer, and is a separate type for that reason.** It carries a
  signature and a receiving wallet and nothing else; the mint, the token program, the
  amount and the commitment are re-read from the chain and judged by the same
  `depositRejection` as before. A forged delivery therefore credits nothing. See
  D-086.
